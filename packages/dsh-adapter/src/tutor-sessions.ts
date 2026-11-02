/**
 * Tutor sessions: DSH chats that are Hodos learning or practice sessions.
 *
 * - The chat gets the tools of its kind and phase (registered in the
 *   agent's own scope, swapped when the phase changes) and, under the
 *   `restricted` policy, loses every other tool except DSH's own
 *   `ask_user_question`: a learner-facing tutor has no shell, filesystem,
 *   network or credential tools, and cannot start subagents. Global tools are
 *   hidden with a restriction; tools other plugins register in the agent's
 *   own scope cannot be hidden, so a guard refuses to run them.
 * - What the tutor writes in a learning session is recorded as teacher
 *   prose for the knowledge graph; after a turn, extraction runs in the
 *   background once enough new prose has accumulated (budgeted per learner).
 * - Graded answers and practice submissions from the Hodos panel reach the
 *   tutor as follow-up turns; when the chat's agent is not running they wait
 *   until it is.
 * @module @hodos/dsh/tutor-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { learningTools, practiceTools } from './learn-tools.js'
import type { ChatBinding, HodosService } from './service.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message from the Hodos panel: a graded answer, a practice submission, a request to start. */
    hodos: { kind: 'hodos' } & ContextFormed
  }
}

/** Longest message text sent to the model. */
const MAX_MESSAGE_CHARS = 12_000

/** Hodos tools that start a subagent: not offered to a restricted tutor. */
const DELEGATING_TOOLS: ReadonlySet<string> = new Set(['hodos_draft_course'])

/** DSH tools a restricted tutor keeps: asking the learner an ungraded question. */
const ALLOWED_HOST_TOOLS: readonly string[] = ['ask_user_question']

/** The tools a binding needs. */
function toolsFor(hodos: HodosService, binding: ChatBinding | null): ToolDefinition[] {
  if (binding === null) return []
  if (binding.kind === 'learn') return learningTools(hodos, binding.phase)
  return binding.closed ? [] : practiceTools(hodos)
}

/** Text blocks of an assistant message (not reasoning, not tool calls). */
function proseOf(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  return event.data.message.content.map(block => (block.type === 'text' ? block.text : '')).filter(t => t.trim() !== '').join('\n\n')
}

/** Binds chats to Hodos and keeps tutor sessions consistent across phases and restarts. */
export class TutorSessions {
  private readonly active = new Map<string, { signature: string; dispose: () => void }>()
  private readonly pending = new Map<string, Array<{ text: string; summary: string }>>()

  /**
   * @param ctx - plugin context with `agents`.
   * @param hodos - the Hodos service.
   */
  constructor(private readonly ctx: Context, private readonly hodos: HodosService) {}

  private agent(sessionId: string): Agent | undefined {
    return this.ctx.agents.list().find(a => String(a.id) === sessionId)
  }

  /**
   * Give a live chat the tools its binding needs (idempotent; swaps tools when the phase changed).
   * @param sessionId - DSH session id.
   */
  sync(sessionId: string): void {
    const agent = this.agent(sessionId)
    if (agent === undefined) return
    const binding = this.hodos.binding(sessionId)
    const tools = toolsFor(this.hodos, binding)
    const signature = `${binding?.kind ?? 'none'}:${binding?.kind === 'learn' ? binding.phase : String(binding?.closed ?? '')}:${tools.map(t => t.name).join(',')}`
    const current = this.active.get(sessionId)
    if (current?.signature === signature) return
    current?.dispose()
    this.active.delete(sessionId)
    if (tools.length === 0) return
    const disposers: Array<() => void> = []
    const undo = (): void => { for (const dispose of disposers.splice(0).toReversed()) dispose() }
    let guard: (() => void) | undefined
    try {
      if (this.hodos.config.tutorTools === 'restricted') {
        const globals = this.hodos.globalTools().filter(name => !DELEGATING_TOOLS.has(name))
        const allowed = new Set([...globals, ...ALLOWED_HOST_TOOLS, ...tools.map(tool => tool.name)])
        // The guard comes first and outlives a failure of the steps below, so a session that could not be
        // set up completely still runs no other tool (fail closed).
        guard = agent.ctx.tools.guard(execution => (allowed.has(execution.name) ? undefined : `${execution.name} is not available in a Hodos session; use the Hodos tools.`))
        disposers.push(this.restrict(agent, globals))
      }
      for (const tool of tools) disposers.push(agent.ctx.tools.register(tool))
    } catch (error) {
      undo()
      this.hodos.logger.error(`could not set up Hodos session ${sessionId}${guard === undefined ? '' : '; every other tool stays refused'}: ${error instanceof Error ? error.message : String(error)}`)
      // Keep the guard; the next change of the session retries the setup (the signature differs).
      if (guard !== undefined) this.active.set(sessionId, { signature: `failed:${signature}`, dispose: guard })
      return
    }
    this.active.set(sessionId, { signature, dispose: () => { undo(); guard?.() } })
  }

  /**
   * Hide every global tool from a tutor's view except Hodos's own and the host tools it may keep.
   * DSH refuses a restriction that names a tool it does not know, and the host tools come from
   * other plugins that a composition may leave out, so a missing one is dropped rather than
   * failing the restriction.
   * @param agent - the tutor's agent.
   * @param globals - Hodos's global tools to keep.
   * @returns the restriction's disposer.
   */
  private restrict(agent: Agent, globals: readonly string[]): () => void {
    try {
      return agent.ctx.tools.restrict({ allow: [...globals, ...ALLOWED_HOST_TOOLS] })
    } catch (error) {
      this.hodos.logger.warn(`restricting a Hodos session without ${ALLOWED_HOST_TOOLS.join(', ')}: ${error instanceof Error ? error.message : String(error)}`)
      return agent.ctx.tools.restrict({ allow: [...globals] })
    }
  }

  /** Whether a chat currently has Hodos session tools in this process. */
  isActive(sessionId: string): boolean {
    const entry = this.active.get(sessionId)
    return entry !== undefined && !entry.signature.startsWith('failed:')
  }

  /**
   * Start a turn in a chat with a message from the Hodos panel; held until the chat's agent runs.
   * @param sessionId - DSH session id.
   * @param text - the message.
   * @param summary - a one-line account for the transcript.
   * @returns whether it was delivered now.
   */
  deliver(sessionId: string, text: string, summary: string): boolean {
    const agent = this.agent(sessionId)
    if (agent === undefined) {
      this.pending.set(sessionId, [...(this.pending.get(sessionId) ?? []), { text, summary }].slice(-20))
      return false
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: text.slice(0, MAX_MESSAGE_CHARS) }],
      source: { kind: 'hodos', form: 'notice', summary: summary.slice(0, 120) },
    }))
    return true
  }

  private flush(sessionId: string): void {
    const queued = this.pending.get(sessionId)
    if (queued === undefined) return
    this.pending.delete(sessionId)
    for (const m of queued) this.deliver(sessionId, m.text, m.summary)
  }

  /**
   * Listen for agents, session events and registry changes. Call once from the plugin.
   */
  listen(): void {
    // A bound chat resumed after a restart becomes a tutor session again.
    this.ctx.on('agent/created', ({ agent }) => {
      const id = String(agent.id)
      if (this.hodos.isTutorSession(id)) this.sync(id)
      this.flush(id)
      return undefined
    })
    // The agent's scope unwinds its registrations on disposal.
    this.ctx.on('agent/disposed', ({ agent }) => { this.active.delete(String(agent.id)) })
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => this.onSessionEvent(String(session.id), event))
    this.ctx.effect(() => this.hodos.onChanged(id => this.sync(id)), 'hodos session changes')
    // Installed interfaces change the exercise tools on offer.
    this.ctx.effect(() => this.hodos.registry.onChange(() => {
      const chats = [...this.active.keys()]
      for (const id of chats) this.sync(id)
    }), 'hodos registry changes')
  }

  private onSessionEvent(chatId: string, event: SessionEvent): void {
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') return
    const binding = this.hodos.binding(chatId)
    if (binding?.kind !== 'learn' || binding.phase === 'closed') return
    if (event.type === 'assistant/message') {
      const prose = proseOf(event)
      if (prose !== '') this.hodos.learn.recordTranscript(binding.sessionId, 'teacher', prose)
      return
    }
    const session = this.hodos.learnRepo.session(binding.sessionId)
    if (session === undefined || !this.hodos.hasModel()) return
    void this.extract(session.learnerId, session.id)
  }

  /** Extract new teacher prose of a session into the knowledge graph; never throws. */
  private async extract(learnerId: string, sessionId: string): Promise<void> {
    try {
      const result = await this.hodos.knowledge.extractSession(learnerId, sessionId)
      if (result.status === 'done') this.hodos.logger.info(`knowledge graph: ${result.stats.propositions} new propositions, ${result.stats.chains} chains from ${sessionId}`)
      else if (result.status === 'failed' || result.status === 'budget') this.hodos.logger.warn(`knowledge graph extraction for ${sessionId}: ${result.status}${result.message === undefined ? '' : ` (${result.message})`}`)
    } catch (error) {
      this.hodos.logger.warn(`knowledge graph extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
