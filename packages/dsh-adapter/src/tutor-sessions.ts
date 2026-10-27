/**
 * Tutor sessions: DSH sessions bound to a Hodos learning journey.
 *
 * - The session gets the Hodos session tools (registered in the agent's own
 *   scope) and, under the `restricted` policy, loses every other tool: a
 *   learner-facing tutor has no shell, filesystem, network or credential tools,
 *   and cannot start subagents (which may have them). Global tools are hidden
 *   with a restriction; tools other plugins register in the agent's own scope
 *   (DSH's `subagent`) cannot be hidden, so a guard refuses to run them.
 * - Every message the learner types in a bound session marks open exercises
 *   and an active checkpoint as assisted (tutor contact).
 * - Workspace activity reaches the tutor as rate-limited notices.
 * @module @hodos/dsh/tutor-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EngineEvent, LearnerId } from '@hodos/core'
import { unreachable } from '@hodos/plugin-sdk'
import type { HodosService } from './service.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Learner activity in the Hodos workspace, reported to the tutor. */
    hodos: { kind: 'hodos' } & ContextFormed
  }
}

/** Longest notice text sent to the model. */
const MAX_NOTICE_CHARS = 600

/** Hodos tools that start a subagent: not offered to a restricted tutor. */
const DELEGATING_TOOLS: ReadonlySet<string> = new Set(['hodos_draft_course'])

/** Binds sessions to Hodos and keeps tutor sessions consistent across restarts. */
export class TutorSessions {
  private readonly active = new Map<string, () => void>()

  /**
   * @param ctx - plugin context with `agents`.
   * @param hodos - the Hodos service.
   * @param sessionTools - the tools a bound session receives.
   */
  constructor(
    private readonly ctx: Context,
    private readonly hodos: HodosService,
    private readonly sessionTools: () => ToolDefinition[],
  ) {}

  private agent(sessionId: string): Agent | undefined {
    return this.ctx.agents.list().find(a => a.id === sessionId)
  }

  /**
   * Turn a live session into a tutor session (idempotent).
   * @param sessionId - DSH session id.
   */
  activate(sessionId: string): void {
    if (this.active.has(sessionId)) return
    const agent = this.agent(sessionId)
    if (agent === undefined) return
    const disposers: Array<() => void> = []
    try {
      const sessionTools = this.sessionTools()
      for (const tool of sessionTools) disposers.push(agent.ctx.tools.register(tool))
      if (this.hodos.config.tutorTools === 'restricted') {
        const globals = this.hodos.globalTools().filter(name => !DELEGATING_TOOLS.has(name))
        disposers.push(agent.ctx.tools.restrict({ allow: globals }))
        const allowed = new Set([...globals, ...sessionTools.map(tool => tool.name)])
        disposers.push(agent.ctx.tools.guard(execution => (allowed.has(execution.name) ? undefined : `${execution.name} is not available in a learning session; use the Hodos tools.`)))
      }
    } catch (error) {
      for (const dispose of disposers.toReversed()) dispose()
      this.hodos.logger.error(`could not set up tutor session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.active.set(sessionId, () => { for (const dispose of disposers.toReversed()) dispose() })
  }

  /** Whether a session is an active tutor session in this process. */
  isActive(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /**
   * Listen for agents and session events. Call once from the plugin.
   * @returns nothing; listeners are owned by the plugin context.
   */
  listen(): void {
    // A bound session resumed after a restart becomes a tutor session again.
    this.ctx.on('agent/created', ({ agent }) => {
      if (this.hodos.isTutorSession(String(agent.id))) this.activate(String(agent.id))
      return undefined
    })
    // The agent's scope unwinds its registrations on disposal.
    this.ctx.on('agent/disposed', ({ agent }) => { this.active.delete(String(agent.id)) })
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => this.onSessionEvent(session, event))
    this.hodos.engine.onEvent(event => this.onEngineEvent(event))
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return
    const binding = this.hodos.store.sessionBinding(String(session.id))
    if (binding === undefined || binding.journeyId === null) return
    // Checkpoint integrity: talking to the tutor during an attempt makes it assisted.
    this.hodos.engine.recordTutorContact(binding.learnerId)
  }

  private onEngineEvent(event: EngineEvent): void {
    const policy = this.hodos.config.notices
    if (policy === 'off') return
    const notice = noticeFor(event)
    if (notice === null) return
    const learnerId = notice.learnerId
    const sessions = this.hodos.store.sessionsForJourney(notice.journeyId)
    for (const sessionId of sessions) {
      const agent = this.agent(sessionId)
      if (agent === undefined) continue
      // Bounded model usage: a token bucket per learner caps notices.
      if (!this.hodos.engine.allowNotice(learnerId)) return
      const message = createUserMessage({
        content: [{ type: 'text', text: notice.text.slice(0, MAX_NOTICE_CHARS) }],
        source: { kind: 'hodos', form: 'notice', summary: notice.summary.slice(0, 120) },
      })
      try {
        if (policy === 'proactive' && notice.wake) agent.followup(message)
        else agent.inject(message)
      } catch (error) {
        this.hodos.logger.warn(`notice to ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/** A notice derived from an engine event, or null when the tutor need not hear about it. */
export function noticeFor(event: EngineEvent): { learnerId: LearnerId; journeyId: string; text: string; summary: string; wake: boolean } | null {
  switch (event.type) {
    case 'attempt': {
      // The agent already knows about its own relayed attempts.
      if (event.channel !== 'ui' || event.journeyId === null) return null
      // Results of placement and checkpoint items stay withheld, in the summary too.
      const assessment = event.mode === 'checkpoint' || event.mode === 'diagnostic'
      const what = assessment ? 'answered an assessment item (result withheld until the end)' : `answered a ${event.mode} exercise: ${event.status}`
      return {
        learnerId: event.learnerId,
        journeyId: event.journeyId,
        text: `[Hodos] The learner ${what} on skill ${event.skillId} in the workspace${event.hintLevel > 0 ? ` after ${event.hintLevel} hint level(s)` : ''}.`,
        summary: assessment ? `Learner answered an assessment item on ${event.skillId}` : `Learner ${event.status} on ${event.skillId}`,
        wake: false,
      }
    }
    case 'checkpoint':
      return {
        learnerId: event.learnerId,
        journeyId: event.journeyId,
        text: `[Hodos] The learner ${event.passed ? 'passed' : 'did not pass'} the checkpoint for ${event.skillId}. ${event.passed ? 'Congratulate them and introduce the next skill.' : 'Encourage them; Hodos adapted the path (see hodos_status).'}`,
        summary: `Checkpoint ${event.passed ? 'passed' : 'not passed'}: ${event.skillId}`,
        wake: true,
      }
    case 'journey':
      return event.phase === 'complete'
        ? { learnerId: event.learnerId, journeyId: event.journeyId, text: '[Hodos] The learner reached the journey goal.', summary: 'Learning goal reached', wake: true }
        : null
    case 'hint':
    case 'security':
      return null
    default: return unreachable(event, 'engine event')
  }
}
