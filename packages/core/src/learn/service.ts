/**
 * The learning service: one learning session from the probe through the
 * plan to teaching, with questions graded on the server.
 *
 * Who may call what:
 * - The tutor (the model in the session's chat) starts nothing on its own
 *   identity. The host resolves the session from the chat the tool runs in,
 *   never from tool arguments, then calls {@link LearnService.concludeProbe},
 *   {@link LearnService.setPlan} and {@link LearnService.ask}.
 * - The learner answers through the workspace ({@link LearnService.answer}),
 *   identified by the host's authenticated principal.
 *
 * Questions keep their keys here: views carry the learner's form of a
 * question, and the committed answer is released only with the verdict.
 * @module @hodos/core/learn/service
 */
import { stripServerFields, type GradeResult, type JsonValue } from '@hodos/plugin-sdk'
import { systemClock, type Clock } from '../clock.js'
import { HodosError } from '../errors.js'
import { randomIds, type IdGenerator, type LearnerId } from '../ids.js'
import { FsrsScheduler } from '../mastery/fsrs.js'
import { scanForLeaks, secretFragments } from '../projection/student-view.js'
import type { PluginRegistry, RegistryLogger } from '../registry/registry.js'
import { movesMastery, nodeMasteryView, observeNode, type NodeMasteryView } from './mastery.js'
import { parsePlan, planStatuses, planToMermaid, type PlanEdge, type PlanNode, type PlanNodeStatus } from './plan.js'
import {
  answerReport,
  choiceAnswerText,
  diagnosticProblems,
  gradeChoice,
  interfaceItem,
  QUESTION_LIMITS,
  QUESTION_ROLES,
  questionForm,
  questionReveal,
  questionSummary,
  readChoiceBody,
  readChoiceResponse,
  readExplainBody,
  readExplainResponse,
  readInterfaceBody,
  type InterfaceBody,
  type InterfaceKind,
  type QuestionBody,
  type QuestionForm,
  type QuestionReveal,
  type QuestionRole,
  type QuestionSpec,
  type QuestionVerdict,
} from './question.js'
import { LearnRepository, type LearnSessionRecord, type QuestionOrigin, type QuestionRecord, type QuestionStatus } from './repository.js'
import { assessmentText, GOAL_MAX_CHARS, phaseAfterQuestion, readProbeAssessment, rolesFor, type LearnPhase, type ProbeAssessment } from './session.js'

/** The forms a question can take. */
export type QuestionFormType = QuestionBody['type']

/** Grading methods whose results can move mastery. */
const EVIDENCE_METHODS = new Set(['deterministic', 'engine', 'oracle'])

/** Largest accepted learner response, as JSON. */
const MAX_RESPONSE_JSON = 16_384

/** Answered questions kept in a session view. */
const VIEW_HISTORY = 50

/** A question as the learner sees it: its form, and once answered, the verdict and reveal. */
export interface QuestionView {
  readonly id: string
  readonly role: QuestionRole
  readonly nodeId?: string
  readonly prompt: string
  readonly details?: string
  readonly origin: QuestionOrigin
  readonly status: QuestionStatus
  readonly form: QuestionForm
  /** Server-held progress of a stepwise interface question (client-visible). */
  readonly progress?: JsonValue
  readonly askedAt: string
  readonly answer?: {
    readonly text: string
    readonly thinking?: string
    readonly verdict: QuestionVerdict
    readonly reveal: QuestionReveal
    readonly answeredAt: string
  }
}

/** The plan map with where each node stands. */
export interface PlanView {
  readonly nodes: readonly PlanNode[]
  readonly edges: readonly PlanEdge[]
  readonly statuses: Readonly<Record<string, PlanNodeStatus>>
  readonly version: number
}

/** A learning session as the learner sees it. */
export interface SessionView {
  readonly id: string
  readonly goal: string
  readonly phase: LearnPhase
  readonly assessment: ProbeAssessment | null
  readonly plan: PlanView | null
  readonly openQuestion: QuestionView | null
  /** Answered questions, oldest first (the latest {@link VIEW_HISTORY}). */
  readonly answered: readonly QuestionView[]
  readonly mastery: readonly NodeMasteryView[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** A short entry in the learner's session list. */
export interface SessionSummary {
  readonly id: string
  readonly goal: string
  readonly phase: LearnPhase
  readonly hostSessionId: string | null
  readonly updatedAt: string
}

/** What the tutor asks for. The body fields are untrusted model input. */
export interface AskRequest {
  readonly form: QuestionFormType
  readonly role: QuestionRole
  readonly nodeId?: string
  readonly prompt: string
  readonly details?: string
  /** The form's fields: options/correct/multi/explanation, answer, or kind/payload/key/explanation. */
  readonly input: Readonly<Record<string, unknown>>
}

/** A learner's answer. */
export interface AnswerSubmission {
  readonly response?: JsonValue
  /** The learner said they do not know. */
  readonly dontKnow?: boolean
  /** The learner's thinking out loud. */
  readonly thinking?: string
}

/** The outcome of submitting an answer. */
export type AnswerOutcome =
  /** A stepwise question moved on; the question stays open. */
  | { readonly status: 'continue'; readonly question: QuestionView; readonly message?: string }
  /** The question is answered. `report` is the tutor's account of it. */
  | { readonly status: 'answered'; readonly question: QuestionView; readonly report: string }

/** Dependencies of the learning service. */
export interface LearnServiceOptions {
  readonly repository: LearnRepository
  readonly registry: PluginRegistry
  readonly logger: RegistryLogger
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly scheduler?: FsrsScheduler
  /** Mastery threshold shown in views (default: the standard gate). */
  readonly theta?: number
}

function problemsError(what: string, problems: readonly string[]): HodosError {
  return new HodosError('INVALID_INPUT', `${what}: ${problems.join('; ')}`)
}

function compactJson(value: JsonValue, limit = 500): string {
  const text = JSON.stringify(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** The learning service. */
export class LearnService {
  private readonly repo: LearnRepository
  private readonly registry: PluginRegistry
  private readonly logger: RegistryLogger
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly scheduler: FsrsScheduler
  private readonly theta: number | undefined

  /** @param options - dependencies. */
  constructor(options: LearnServiceOptions) {
    this.repo = options.repository
    this.registry = options.registry
    this.logger = options.logger
    this.clock = options.clock ?? systemClock
    this.ids = options.ids ?? randomIds
    this.scheduler = options.scheduler ?? new FsrsScheduler()
    this.theta = options.theta
  }

  private now(): string {
    return this.clock.now().toISOString()
  }

  // ---- sessions ----

  /**
   * Start a learning session in a host chat.
   * @param learnerId - the learner (from the host's authenticated identity).
   * @param goal - what the learner wants to learn, in their words.
   * @param hostSessionId - the chat the session runs in, if any.
   * @returns the new session.
   * @throws {HodosError} `INVALID_INPUT` for an empty or overlong goal;
   *   `CONFLICT` when the chat already holds a learning session.
   */
  start(learnerId: LearnerId, goal: string, hostSessionId: string | null): LearnSessionRecord {
    const text = goal.trim()
    if (text === '') throw new HodosError('INVALID_INPUT', 'say what you want to learn')
    if (text.length > GOAL_MAX_CHARS) throw new HodosError('INVALID_INPUT', `keep the goal under ${GOAL_MAX_CHARS} characters`)
    return this.repo.transaction(() => {
      if (hostSessionId !== null && this.repo.sessionForHost(hostSessionId) !== undefined) throw new HodosError('CONFLICT', 'this chat already holds a learning session')
      const at = this.now()
      const session: LearnSessionRecord = {
        id: this.ids.next('lsn'), learnerId, hostSessionId, goal: text, phase: 'probe',
        assessment: null, plan: null, planSource: null, planVersion: 0, createdAt: at, updatedAt: at,
      }
      this.repo.insertSession(session)
      return session
    })
  }

  /** @param hostSessionId - host chat id. @returns its learning session, or undefined. */
  sessionForHost(hostSessionId: string): LearnSessionRecord | undefined {
    return this.repo.sessionForHost(hostSessionId)
  }

  /**
   * A session owned by the learner.
   * @param learnerId - the learner.
   * @param sessionId - the session.
   * @returns the session.
   * @throws {HodosError} `NOT_FOUND` when it does not exist or is someone else's.
   */
  ownedSession(learnerId: string, sessionId: string): LearnSessionRecord {
    const session = this.repo.session(sessionId)
    if (session?.learnerId !== learnerId) throw new HodosError('NOT_FOUND', 'no such learning session')
    return session
  }

  private session(sessionId: string): LearnSessionRecord {
    const session = this.repo.session(sessionId)
    if (session === undefined) throw new HodosError('NOT_FOUND', 'no such learning session')
    return session
  }

  /** @param learnerId - learner. @returns their sessions, most recently active first. */
  sessions(learnerId: string): SessionSummary[] {
    return this.repo.sessions(learnerId).map(s => ({ id: s.id, goal: s.goal, phase: s.phase, hostSessionId: s.hostSessionId, updatedAt: s.updatedAt }))
  }

  /**
   * Close a session: it accepts no more questions or answers.
   * @param learnerId - the owner.
   * @param sessionId - the session.
   */
  close(learnerId: string, sessionId: string): void {
    this.repo.transaction(() => {
      const session = this.ownedSession(learnerId, sessionId)
      if (session.phase === 'closed') return
      this.supersedeOpen(session.id)
      this.repo.updateSession({ ...session, phase: 'closed', updatedAt: this.now() })
    })
  }

  private open(sessionId: string): LearnSessionRecord {
    const session = this.session(sessionId)
    if (session.phase === 'closed') throw new HodosError('INVALID_STATE', 'this learning session is closed')
    return session
  }

  // ---- the probe and the plan ----

  /**
   * Conclude the probe with the prober's assessment; the session moves to planning.
   * @param sessionId - the session (resolved by the host from the chat).
   * @param assessment - untrusted `assessment` argument.
   * @returns the stored assessment.
   * @throws {HodosError} `INVALID_STATE` outside the probe or while a question
   *   waits for an answer; `INVALID_INPUT` for a malformed assessment.
   */
  concludeProbe(sessionId: string, assessment: unknown): ProbeAssessment {
    return this.repo.transaction(() => {
      const session = this.open(sessionId)
      if (session.phase !== 'probe') throw new HodosError('INVALID_STATE', 'the probe already concluded; plan from the assessment')
      if (this.repo.openQuestions(sessionId).length > 0) throw new HodosError('INVALID_STATE', 'a question is still waiting for the learner\'s answer; conclude after it is answered')
      const problems: string[] = []
      const read = readProbeAssessment(assessment, problems)
      if (read === undefined) throw problemsError('the assessment was not recorded', problems)
      this.repo.updateSession({ ...session, phase: 'plan', assessment: read, updatedAt: this.now() })
      return read
    })
  }

  /**
   * Write or rewrite the plan map.
   * @param sessionId - the session (resolved by the host from the chat).
   * @param source - the mermaid subset of {@link parsePlan}.
   * @returns the plan with where each node stands.
   * @throws {HodosError} `INVALID_STATE` before the probe concluded;
   *   `INVALID_INPUT` listing every problem of the map.
   */
  setPlan(sessionId: string, source: string): PlanView {
    return this.repo.transaction(() => {
      const session = this.open(sessionId)
      if (session.phase === 'probe') throw new HodosError('INVALID_STATE', 'the probe has not concluded; the plan comes after the assessment')
      const parsed = parsePlan(source)
      if (!parsed.ok) throw problemsError('the plan was not saved', parsed.problems)
      const next: LearnSessionRecord = { ...session, plan: parsed.plan, planSource: planToMermaid(parsed.plan), planVersion: session.planVersion + 1, updatedAt: this.now() }
      this.repo.updateSession(next)
      return this.planView(next) ?? { nodes: [], edges: [], statuses: {}, version: next.planVersion }
    })
  }

  private planView(session: LearnSessionRecord): PlanView | null {
    if (session.plan === null) return null
    return { nodes: session.plan.nodes, edges: session.plan.edges, statuses: planStatuses(session.plan, this.repo.taggedNodes(session.id)), version: session.planVersion }
  }

  // ---- questions ----

  /**
   * The installed interface kinds: every exercise kind of an installed plugin.
   * @returns kinds by id.
   */
  interfaceKinds(): Map<string, InterfaceKind> {
    const out = new Map<string, InterfaceKind>()
    for (const id of this.registry.kindIds()) {
      const kind = this.registry.kind(id)
      if (kind === undefined) continue
      out.set(id, {
        environment: kind.spec.environment,
        title: kind.spec.title,
        responseKind: kind.spec.responseKind,
        interaction: kind.spec.interaction,
        project: payload => stripServerFields(kind.spec.payloadSchema, payload) ?? null,
        text: payload => this.registry.fallbackText(id, payload),
      })
    }
    return out
  }

  /**
   * Ask the learner a question. A question still open from an interrupted
   * turn is superseded.
   * @param sessionId - the session (resolved by the host from the chat).
   * @param request - the question; its fields are untrusted model input.
   * @returns the stored question.
   * @throws {HodosError} `INVALID_STATE` when the phase does not take the
   *   role; `INVALID_INPUT` listing every problem with the question.
   */
  async ask(sessionId: string, request: AskRequest): Promise<QuestionRecord> {
    const session = this.open(sessionId)
    const problems: string[] = []
    if (!QUESTION_ROLES.includes(request.role)) problems.push(`role must be one of ${QUESTION_ROLES.join(', ')}`)
    else if (!rolesFor(session.phase).includes(request.role)) {
      throw new HodosError('INVALID_STATE', session.phase === 'probe'
        ? 'while probing, ask probe questions (no plan node); conclude the probe before teaching'
        : 'the probe has concluded; teaching questions are predict, check or review questions about a plan node')
    }
    const nodeId = request.nodeId?.trim() === '' ? undefined : request.nodeId?.trim()
    if (request.role === 'probe' && nodeId !== undefined) problems.push('probe questions are not about a plan node; leave nodeId out')
    if (request.role !== 'probe') {
      if (session.plan === null) problems.push('there is no plan map yet; write the plan before asking about its nodes')
      else if (nodeId === undefined) problems.push('nodeId is required: the plan node this question is about')
      else if (!session.plan.nodes.some(n => n.id === nodeId)) {
        const known = session.plan.nodes.map(n => n.id)
        problems.push(`nodeId "${nodeId}" is not a node of the plan; use one of ${known.slice(0, 8).join(', ')}${known.length > 8 ? ', …' : ''}`)
      }
    }
    const prompt = request.prompt.trim()
    if (prompt === '') problems.push('the question text is required')
    if (prompt.length > QUESTION_LIMITS.promptChars) problems.push(`the question is longer than ${QUESTION_LIMITS.promptChars} characters`)
    const details = request.details?.trim()
    if (details !== undefined && details.length > QUESTION_LIMITS.detailsChars) problems.push(`details are longer than ${QUESTION_LIMITS.detailsChars} characters`)

    const kinds = this.interfaceKinds()
    const id = this.ids.next('q')
    let body: QuestionBody | undefined
    switch (request.form) {
      case 'choice': body = readChoiceBody(request.input, problems); break
      case 'explain': body = readExplainBody(request.input, problems); break
      case 'interface': body = readInterfaceBody(request.input, kinds, problems); break
      default: problems.push('form must be choice, explain or interface')
    }
    if (body?.type === 'interface' && problems.length === 0) problems.push(...await this.checkInterface(id, body, nodeId, [prompt, details ?? '']))
    if (problems.length > 0 || body === undefined) throw problemsError('the question was not asked', problems)

    const spec: QuestionSpec = { role: request.role, ...(nodeId === undefined ? {} : { nodeId }), prompt, ...(details === undefined || details === '' ? {} : { details }), body }
    return this.repo.transaction(() => {
      const current = this.open(sessionId)
      this.supersedeOpen(sessionId)
      const at = this.now()
      const record: QuestionRecord = {
        seq: 0, id, sessionId, spec, origin: body.type === 'interface' && body.bankItem !== undefined ? 'bank' : 'model', status: 'open',
        progress: null, response: null, answerText: null, thinking: null, verdict: null, askedAt: at, answeredAt: null,
      }
      this.repo.insertQuestion(record)
      const phase = phaseAfterQuestion(current.phase, nodeId)
      this.repo.updateSession({ ...current, phase, updatedAt: at })
      return this.repo.question(id) ?? record
    })
  }

  /** Validate an interface question with its plugin and check the tutor's text for the answer. */
  private async checkInterface(id: string, body: InterfaceBody, nodeId: string | undefined, visibleText: readonly string[]): Promise<string[]> {
    const item = interfaceItem(id, body, nodeId)
    const problems = diagnosticProblems(await this.registry.validateItem(item))
    if (problems.length > 0) return problems
    // What the payload shows is the plugin's projection (server-only fields removed); the key itself
    // never leaves the server. The question text is the tutor's own and may name a theme as a hint
    // ("find the fork"); it must not contain the answer, which is what a distinctive key fragment is.
    const secrets = secretFragments(item, this.registry.kind(body.kind), { hintLevel: 0, answer: false })
    const distinctive = secrets.filter(f => f.length >= 8 || /[^\p{L}\s]/u.test(f))
    if (scanForLeaks(visibleText.join('\n'), distinctive).length > 0) return ['the question text gives away the answer; keep the answer out of what the learner sees']
    return []
  }

  private supersedeOpen(sessionId: string): void {
    for (const q of this.repo.openQuestions(sessionId)) this.repo.updateQuestion({ ...q, status: 'superseded' })
  }

  /**
   * Withdraw the open question of a session, for example when the tutor's
   * turn was interrupted.
   * @param sessionId - the session.
   */
  withdrawOpen(sessionId: string): void {
    this.repo.transaction(() => this.supersedeOpen(sessionId))
  }

  /**
   * A question of a session the learner owns.
   * @param learnerId - the learner.
   * @param questionId - the question.
   * @returns the question and its session.
   * @throws {HodosError} `NOT_FOUND` when it does not exist or is someone else's.
   */
  private ownedQuestion(learnerId: string, questionId: string): { question: QuestionRecord; session: LearnSessionRecord } {
    const question = this.repo.question(questionId)
    const session = question === undefined ? undefined : this.repo.session(question.sessionId)
    if (question === undefined || session?.learnerId !== learnerId) throw new HodosError('NOT_FOUND', 'no such question')
    return { question, session }
  }

  /**
   * Answer the open question.
   * @param learnerId - the learner (from the host's authenticated identity).
   * @param questionId - the question.
   * @param submission - the answer, "I don't know", and the learner's thinking.
   * @returns the outcome.
   * @throws {HodosError} `NOT_FOUND`, `INVALID_STATE` when the question is not
   *   open, `INVALID_INPUT` for a malformed answer, `UNAVAILABLE` when a
   *   plugin grader is missing or fails (the question stays open).
   */
  async answer(learnerId: string, questionId: string, submission: AnswerSubmission): Promise<AnswerOutcome> {
    const { question, session } = this.ownedQuestion(learnerId, questionId)
    if (session.phase === 'closed') throw new HodosError('INVALID_STATE', 'this learning session is closed')
    if (question.status !== 'open') throw new HodosError('INVALID_STATE', question.status === 'answered' ? 'this question is already answered' : 'this question was withdrawn')
    const thinking = submission.thinking?.trim()
    if (thinking !== undefined && thinking.length > QUESTION_LIMITS.thinkingChars) throw new HodosError('INVALID_INPUT', `keep your thinking under ${QUESTION_LIMITS.thinkingChars} characters`)
    const response = submission.response ?? null
    if (JSON.stringify(response).length > MAX_RESPONSE_JSON) throw new HodosError('INVALID_INPUT', 'the answer is too large')

    const body = question.spec.body
    let verdict: QuestionVerdict
    let answerText: string
    let progress = question.progress
    if (submission.dontKnow === true) {
      verdict = { outcome: 'dont-know', score: 0, countsAsEvidence: true }
      answerText = 'I don\'t know'
    } else {
      switch (body.type) {
        case 'choice': {
          const read = readChoiceResponse(body, response)
          if (typeof read === 'string') throw new HodosError('INVALID_INPUT', read)
          verdict = gradeChoice(body, read)
          answerText = choiceAnswerText(body, read.selected)
          break
        }
        case 'explain': {
          answerText = readExplainResponse(response)
          if (answerText === '') throw new HodosError('INVALID_INPUT', 'write your answer, or say you do not know')
          verdict = { outcome: 'ungraded', score: null, countsAsEvidence: false }
          break
        }
        case 'interface': {
          const graded = await this.gradeInterface(question, body, response)
          if (graded.status === 'continue') {
            const latest = this.repo.question(question.id)
            if (latest?.status !== 'open' || JSON.stringify(latest.progress) !== JSON.stringify(question.progress)) throw new HodosError('CONFLICT', 'this question changed; reload it')
            const next = { ...latest, progress: graded.progress }
            this.repo.updateQuestion(next)
            return { status: 'continue', question: this.questionView(next), ...(graded.message === undefined ? {} : { message: graded.message }) }
          }
          verdict = graded.verdict
          progress = graded.progress
          answerText = compactJson(response)
          break
        }
      }
    }

    return this.repo.transaction(() => {
      const latest = this.repo.question(question.id)
      if (latest?.status !== 'open') throw new HodosError('CONFLICT', 'this question was answered or withdrawn meanwhile')
      const at = this.clock.now()
      const answered: QuestionRecord = {
        ...latest, status: 'answered', progress, response, answerText, thinking: thinking === undefined || thinking === '' ? null : thinking,
        verdict, answeredAt: at.toISOString(),
      }
      this.repo.updateQuestion(answered)
      const nodeId = question.spec.nodeId
      if (nodeId !== undefined) {
        const observation = {
          sessionId: session.id, nodeId, learnerId: session.learnerId, role: question.spec.role, verdict,
          ...(body.type === 'choice' && !body.multi ? { options: body.options.length } : {}),
        }
        if (movesMastery(observation)) this.repo.saveNodeState(observeNode(this.repo.nodeState(session.id, nodeId), observation, at, this.scheduler))
      }
      this.repo.updateSession({ ...this.session(session.id), updatedAt: at.toISOString() })
      return {
        status: 'answered',
        question: this.questionView(answered),
        report: answerReport({ spec: question.spec, verdict, answerText, ...(answered.thinking === null ? {} : { thinking: answered.thinking }) }),
      }
    })
  }

  private async gradeInterface(question: QuestionRecord, body: InterfaceBody, response: JsonValue): Promise<
    | { status: 'continue'; progress: JsonValue; message?: string }
    | { status: 'graded'; verdict: QuestionVerdict; progress: JsonValue | null }
  > {
    const kind = this.registry.kind(body.kind)
    if (kind === undefined) throw new HodosError('UNAVAILABLE', `the environment for ${body.kind} is not installed`)
    const shape = kind.validateResponse(response)
    if (shape.length > 0) throw new HodosError('INVALID_INPUT', `answer rejected: ${shape.map(d => d.message).join('; ')}`)
    const item = interfaceItem(question.id, body, question.spec.nodeId)
    const input = { kind: body.kind, payload: body.payload, key: body.key, response, mode: 'practice' as const, skills: item.skills, attempt: 1 }
    let grade: GradeResult
    let progress: JsonValue | null = question.progress
    if (kind.spec.interaction === 'stepwise') {
      const step = await this.registry.step({ ...input, progress: question.progress })
      if (step.status === 'continue') {
        // The answer is still withheld mid-line: scan the reply for the key.
        const secrets = secretFragments(item, kind, { hintLevel: 0, answer: false }, [step.progress, response])
        const leaks = scanForLeaks(step.message ?? '', secrets).length > 0
        if (leaks) this.logger.warn(`withheld step feedback of ${body.kind} that quoted the key`)
        return { status: 'continue', progress: step.progress, ...(step.message === undefined || leaks ? {} : { message: step.message }) }
      }
      grade = step.grade
      progress = step.progress
    } else {
      grade = await this.registry.grade(input)
    }
    const method = this.registry.graderInfo(body.kind)?.method
    return {
      status: 'graded',
      progress,
      verdict: {
        outcome: grade.correct ? 'correct' : grade.score > 0 ? 'partial' : 'incorrect',
        score: grade.score,
        ...(grade.feedback === undefined ? {} : { feedback: grade.feedback }),
        ...(grade.misconceptions.length === 0 ? {} : { misconceptions: grade.misconceptions }),
        countsAsEvidence: method !== undefined && EVIDENCE_METHODS.has(method),
      },
    }
  }

  // ---- views ----

  private reveal(question: QuestionRecord): QuestionReveal {
    const body = question.spec.body
    if (body.type !== 'interface') return questionReveal(body)
    const kind = this.registry.kind(body.kind)
    if (kind === undefined || !kind.trusted || kind.spec.reveal === undefined) return questionReveal(body)
    try {
      return questionReveal(body, kind.spec.reveal(interfaceItem(question.id, body, question.spec.nodeId)))
    } catch (error) {
      this.logger.warn(`reveal for ${body.kind} failed: ${error instanceof Error ? error.message : String(error)}`)
      return questionReveal(body)
    }
  }

  /**
   * The learner's view of a question: no key while it is open.
   * @param question - the stored question.
   * @returns the view.
   */
  questionView(question: QuestionRecord): QuestionView {
    const { spec } = question
    const answered = question.status === 'answered' && question.verdict !== null
    return {
      id: question.id,
      role: spec.role,
      ...(spec.nodeId === undefined ? {} : { nodeId: spec.nodeId }),
      prompt: spec.prompt,
      ...(spec.details === undefined ? {} : { details: spec.details }),
      origin: question.origin,
      status: question.status,
      form: questionForm(question.id, spec.body, this.interfaceKinds()),
      ...(question.progress === null ? {} : { progress: question.progress }),
      askedAt: question.askedAt,
      ...(answered && question.verdict !== null ? {
        answer: {
          text: question.answerText ?? '',
          ...(question.thinking === null ? {} : { thinking: question.thinking }),
          verdict: question.verdict,
          reveal: this.reveal(question),
          answeredAt: question.answeredAt ?? question.askedAt,
        },
      } : {}),
    }
  }

  /**
   * The open question of a session, as the learner sees it.
   * @param sessionId - the session.
   * @returns the view, or null.
   */
  openQuestion(sessionId: string): QuestionView | null {
    const open = this.repo.openQuestions(sessionId).at(-1)
    return open === undefined ? null : this.questionView(open)
  }

  /**
   * The current state of a question, for a tutor waiting on it.
   * @param questionId - the question.
   * @returns the stored question, or undefined.
   */
  question(questionId: string): QuestionRecord | undefined {
    return this.repo.question(questionId)
  }

  /**
   * The learner's view of a session.
   * @param learnerId - the owner.
   * @param sessionId - the session.
   * @returns the view.
   */
  view(learnerId: string, sessionId: string): SessionView {
    const session = this.ownedSession(learnerId, sessionId)
    const questions = this.repo.questions(session.id)
    return {
      id: session.id,
      goal: session.goal,
      phase: session.phase,
      assessment: session.assessment,
      plan: this.planView(session),
      openQuestion: this.openQuestion(session.id),
      answered: questions.filter(q => q.status === 'answered').slice(-VIEW_HISTORY).map(q => this.questionView(q)),
      mastery: this.repo.nodeStates(session.id).map(s => nodeMasteryView(s, this.theta)),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
  }

  /**
   * Record prose for the knowledge graph: what the teacher explained, what the learner said.
   * @param sessionId - the session.
   * @param role - who wrote it.
   * @param text - the prose.
   */
  recordTranscript(sessionId: string, role: 'teacher' | 'learner', text: string): void {
    const t = text.trim()
    if (t === '') return
    this.repo.appendTranscript(sessionId, role, t.slice(0, 20_000), this.now())
  }

  /**
   * The tutor's context for a session: goal, phase, assessment, plan with
   * statuses, the open question and the recent answers. Contains no keys of
   * open questions.
   * @param sessionId - the session.
   * @returns plain text for the system prompt.
   */
  tutorContext(sessionId: string): string {
    const session = this.session(sessionId)
    const lines = [`Learning goal: ${session.goal}`, `Phase: ${session.phase}`]
    if (session.assessment !== null) lines.push('Assessment from the probe:', assessmentText(session.assessment))
    const plan = this.planView(session)
    if (session.plan !== null && plan !== null) {
      lines.push(`Plan map (version ${plan.version}):`, planToMermaid(session.plan))
      lines.push(`Node status: ${session.plan.nodes.map(n => `${n.id}=${plan.statuses[n.id] ?? 'upcoming'}`).join(', ')}`)
    }
    const mastery = this.repo.nodeStates(session.id)
    if (mastery.length > 0) lines.push(`Mastery estimates (checks graded by Hodos): ${mastery.map(s => `${s.nodeId} ${Math.round(s.pMastered * 100)}%`).join(', ')}`)
    const open = this.repo.openQuestions(session.id).at(-1)
    if (open !== undefined) lines.push(`Waiting for the learner's answer to: ${questionSummary(open.spec, questionForm(open.id, open.spec.body, this.interfaceKinds()))}`)
    const recent = this.repo.questions(session.id).filter(q => q.status === 'answered').slice(-5)
    for (const q of recent) {
      const v = q.verdict
      lines.push(`Answered ${q.spec.role}${q.spec.nodeId === undefined ? '' : ` on ${q.spec.nodeId}`}: "${q.spec.prompt.slice(0, 160)}" → ${v === null ? 'unknown' : v.outcome}`)
    }
    return lines.join('\n')
  }

  /**
   * Plan nodes due for review across the learner's sessions.
   * @param learnerId - the learner.
   * @returns due nodes with their session goal, most overdue first.
   */
  dueReviews(learnerId: string): Array<{ sessionId: string; goal: string; nodeId: string; title: string; dueAt: string }> {
    const out: Array<{ sessionId: string; goal: string; nodeId: string; title: string; dueAt: string }> = []
    for (const s of this.repo.dueNodes(learnerId, this.now())) {
      const session = this.repo.session(s.sessionId)
      const node = session?.plan?.nodes.find(n => n.id === s.nodeId)
      if (session === undefined || node === undefined || s.dueAt === null) continue
      out.push({ sessionId: session.id, goal: session.goal, nodeId: node.id, title: node.title, dueAt: s.dueAt })
    }
    return out
  }

}
