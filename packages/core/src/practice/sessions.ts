/**
 * Practice sessions, after LearnHarness: the learner picks propositions of
 * their knowledge graph, and a tutor poses one problem at a time.
 *
 * - The tutor commits its full solution when it poses a problem; the
 *   learner sees the solution only once the problem is concluded.
 * - The learner works in a thinking field. Each submission goes to the
 *   tutor, which answers with the smallest hint that unblocks, or with a
 *   verdict when the submission claims an answer.
 * - The tutor concludes with an outcome and a verdict; the learner may
 *   dismiss a problem instead.
 *
 * Practice verdicts are the tutor's judgment. They are feedback only and
 * never move mastery estimates.
 * @module @hodos/core/practice/sessions
 */
import { systemClock, type Clock } from '../clock.js'
import { HodosError } from '../errors.js'
import { brandId, randomIds, type IdGenerator, type LearnerId } from '../ids.js'
import { chainLine, chainsForSelection, resolveProposition } from '../knowledge/graph.js'
import type { GraphRepository } from '../knowledge/repository.js'
import { json, num, optJson, optStr, str, type Row, type SqlRunner } from '../store/rows.js'
import type { HodosStore } from '../store/store.js'

/** What a problem trains. */
export type PracticeMode = 'recall' | 'discrimination' | 'composition'
/** How a problem ended. `dismissed` is the learner's; the tutor reports the others. */
export type PracticeOutcome = 'solved' | 'solvedWithHints' | 'movedOn' | 'surrendered' | 'dismissed'
/** The hint-ladder rung a problem needed, from a redirect of attention (R0) to the worked step (R5). */
export type HintRung = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
/** Why an answer missed. */
export type MissClass = 'cue' | 'discrimination' | 'execution' | 'careless' | 'structural'

/** All modes, outcomes the tutor may report, rungs and miss classes. */
export const PRACTICE_MODES: readonly PracticeMode[] = ['recall', 'discrimination', 'composition']
export const TUTOR_OUTCOMES: readonly PracticeOutcome[] = ['solved', 'solvedWithHints', 'movedOn', 'surrendered']
export const HINT_RUNGS: readonly HintRung[] = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']
export const MISS_CLASSES: readonly MissClass[] = ['cue', 'discrimination', 'execution', 'careless', 'structural']

/** Size limits. */
export const PRACTICE_LIMITS = { statementChars: 6000, solutionChars: 12000, verdictChars: 3000, thinkingChars: 8000, targets: 30, titleChars: 200 } as const

/** How a problem was concluded. */
export interface ProblemConclusion {
  readonly outcome: PracticeOutcome
  readonly verdict: string
  readonly rung: HintRung | null
  readonly missClass: MissClass | null
  readonly retest: boolean
}

/** A stored practice session. */
export interface PracticeSessionRecord {
  readonly id: string
  readonly learnerId: LearnerId
  readonly hostSessionId: string | null
  readonly title: string
  /** Picked proposition ids. */
  readonly targets: readonly string[]
  readonly status: 'active' | 'closed'
  readonly createdAt: string
  readonly updatedAt: string
}

/** A stored problem; the model solution is server-only until concluded. */
export interface ProblemRecord {
  readonly seq: number
  readonly id: string
  readonly sessionId: string
  readonly statement: string
  readonly mode: PracticeMode
  readonly targets: readonly string[]
  readonly modelSolution: string
  readonly status: 'active' | 'concluded'
  readonly conclusion: ProblemConclusion | null
  readonly posedAt: string
  readonly concludedAt: string | null
}

/** A problem as the learner sees it. */
export interface ProblemView {
  readonly id: string
  readonly statement: string
  readonly mode: PracticeMode
  readonly targets: readonly string[]
  readonly status: 'active' | 'concluded'
  readonly thinking: ReadonlyArray<{ readonly text: string; readonly at: string }>
  readonly conclusion?: ProblemConclusion
  /** Released when the problem is concluded. */
  readonly modelSolution?: string
  readonly posedAt: string
}

/** A practice session as the learner sees it. */
export interface PracticeView {
  readonly id: string
  readonly title: string
  readonly status: 'active' | 'closed'
  readonly targets: ReadonlyArray<{ readonly id: string; readonly name: string; readonly statement: string }>
  readonly problems: readonly ProblemView[]
}

function sessionFromRow(row: Row): PracticeSessionRecord {
  return {
    id: str(row, 'id'),
    learnerId: brandId<'LearnerId'>(str(row, 'learner_id')),
    hostSessionId: optStr(row, 'host_session_id'),
    title: str(row, 'title'),
    targets: json(row, 'targets_json') as string[],
    status: str(row, 'status') as PracticeSessionRecord['status'], // CHECK constraint
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  }
}

function problemFromRow(row: Row): ProblemRecord {
  return {
    seq: num(row, 'seq'),
    id: str(row, 'id'),
    sessionId: str(row, 'session_id'),
    statement: str(row, 'statement'),
    mode: str(row, 'mode') as PracticeMode, // CHECK constraint
    targets: json(row, 'targets_json') as string[],
    modelSolution: str(row, 'model_solution'),
    status: str(row, 'status') as ProblemRecord['status'], // CHECK constraint
    conclusion: optJson(row, 'conclusion_json') as ProblemConclusion | null,
    posedAt: str(row, 'posed_at'),
    concludedAt: optStr(row, 'concluded_at'),
  }
}

function text(value: unknown, field: string, limit: number, problems: string[]): string {
  const t = typeof value === 'string' ? value.trim() : ''
  if (t === '') problems.push(`${field} is required`)
  else if (t.length > limit) problems.push(`${field} is longer than ${limit} characters`)
  return t
}

function pick<T extends string>(value: unknown, allowed: readonly T[], field: string, problems: string[]): T | undefined {
  const v = typeof value === 'string' ? value.trim().replace(/^["']|["']$/gu, '') : value
  const found = allowed.find(a => a === v)
  if (found === undefined) problems.push(`${field} must be one of ${allowed.join(', ')}`)
  return found
}

/** Dependencies of the practice service. */
export interface PracticeServiceOptions {
  readonly store: HodosStore
  readonly graph: GraphRepository
  readonly clock?: Clock
  readonly ids?: IdGenerator
}

/** The practice-session service. */
export class PracticeService {
  private readonly store: HodosStore
  private readonly sql: SqlRunner
  private readonly graph: GraphRepository
  private readonly clock: Clock
  private readonly ids: IdGenerator

  /** @param options - dependencies. */
  constructor(options: PracticeServiceOptions) {
    this.store = options.store
    this.sql = options.store.sql
    this.graph = options.graph
    this.clock = options.clock ?? systemClock
    this.ids = options.ids ?? randomIds
  }

  private now(): string {
    return this.clock.now().toISOString()
  }

  // ---- sessions ----

  /**
   * Start a practice session on picked propositions (or none, for a free topic).
   * @param learnerId - the learner.
   * @param request - picked proposition ids, an optional title, and the host chat.
   * @returns the session.
   */
  start(learnerId: LearnerId, request: { readonly targets: readonly string[]; readonly title?: string; readonly hostSessionId: string | null }): PracticeSessionRecord {
    const known = new Map(this.graph.propositions(learnerId).map(p => [p.id, p]))
    const targets = [...new Set(request.targets)]
    if (targets.length > PRACTICE_LIMITS.targets) throw new HodosError('INVALID_INPUT', `pick at most ${PRACTICE_LIMITS.targets} propositions`)
    const unknown = targets.filter(t => !known.has(t))
    if (unknown.length > 0) throw new HodosError('NOT_FOUND', 'a picked proposition is not in your graph')
    const title = (request.title?.trim() || targets.map(t => known.get(t)?.name ?? t).slice(0, 4).join(', ') || 'Practice').slice(0, PRACTICE_LIMITS.titleChars)
    return this.store.transaction(() => {
      if (request.hostSessionId !== null && this.sessionForHost(request.hostSessionId) !== undefined) throw new HodosError('CONFLICT', 'this chat already holds a practice session')
      const at = this.now()
      const s: PracticeSessionRecord = { id: this.ids.next('prs'), learnerId, hostSessionId: request.hostSessionId, title, targets, status: 'active', createdAt: at, updatedAt: at }
      this.sql.run('INSERT INTO practice_sessions (id, learner_id, host_session_id, title, targets_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        s.id, s.learnerId, s.hostSessionId, s.title, JSON.stringify(s.targets), s.status, s.createdAt, s.updatedAt)
      return s
    })
  }

  /** @param hostSessionId - host chat. @returns its practice session, or undefined. */
  sessionForHost(hostSessionId: string): PracticeSessionRecord | undefined {
    const row = this.sql.get('SELECT * FROM practice_sessions WHERE host_session_id = ?', hostSessionId)
    return row === undefined ? undefined : sessionFromRow(row)
  }

  private session(id: string): PracticeSessionRecord {
    const row = this.sql.get('SELECT * FROM practice_sessions WHERE id = ?', id)
    if (row === undefined) throw new HodosError('NOT_FOUND', 'no such practice session')
    return sessionFromRow(row)
  }

  /**
   * A session owned by the learner.
   * @throws {HodosError} `NOT_FOUND` when it does not exist or is someone else's.
   */
  ownedSession(learnerId: string, sessionId: string): PracticeSessionRecord {
    const row = this.sql.get('SELECT * FROM practice_sessions WHERE id = ? AND learner_id = ?', sessionId, learnerId)
    if (row === undefined) throw new HodosError('NOT_FOUND', 'no such practice session')
    return sessionFromRow(row)
  }

  /** @param learnerId - learner. @returns their practice sessions, most recent first. */
  sessions(learnerId: string): PracticeSessionRecord[] {
    return this.sql.all('SELECT * FROM practice_sessions WHERE learner_id = ? ORDER BY updated_at DESC, id', learnerId).map(sessionFromRow)
  }

  /** Close a session. */
  close(learnerId: string, sessionId: string): void {
    this.store.transaction(() => {
      this.ownedSession(learnerId, sessionId)
      this.sql.run("UPDATE practice_sessions SET status = 'closed', updated_at = ? WHERE id = ?", this.now(), sessionId)
    })
  }

  private touch(sessionId: string): void {
    this.sql.run('UPDATE practice_sessions SET updated_at = ? WHERE id = ?', this.now(), sessionId)
  }

  // ---- problems ----

  private problems(sessionId: string): ProblemRecord[] {
    return this.sql.all('SELECT * FROM practice_problems WHERE session_id = ? ORDER BY seq', sessionId).map(problemFromRow)
  }

  private active(sessionId: string): ProblemRecord | undefined {
    const row = this.sql.get("SELECT * FROM practice_problems WHERE session_id = ? AND status = 'active' ORDER BY seq DESC LIMIT 1", sessionId)
    return row === undefined ? undefined : problemFromRow(row)
  }

  private thinking(problemId: string): Array<{ text: string; at: string }> {
    return this.sql.all('SELECT text, created_at FROM practice_thinking WHERE problem_id = ? ORDER BY seq', problemId).map(r => ({ text: str(r, 'text'), at: str(r, 'created_at') }))
  }

  /**
   * Pose a problem (the tutor). One problem may be active at a time.
   * @param sessionId - the session (resolved by the host from the chat).
   * @param input - untrusted tool input: statement, mode, target, modelSolution.
   * @returns the stored problem.
   */
  pose(sessionId: string, input: Readonly<Record<string, unknown>>): ProblemRecord {
    return this.store.transaction(() => {
      const session = this.session(sessionId)
      if (session.status !== 'active') throw new HodosError('INVALID_STATE', 'this practice session is closed')
      if (this.active(sessionId) !== undefined) throw new HodosError('INVALID_STATE', 'a problem is already active; conclude it before posing the next')
      const problems: string[] = []
      const statement = text(input.statement, 'statement', PRACTICE_LIMITS.statementChars, problems)
      const modelSolution = text(input.modelSolution, 'modelSolution (your full solution, committed before the learner sees the problem)', PRACTICE_LIMITS.solutionChars, problems)
      const mode = pick(input.mode, PRACTICE_MODES, 'mode', problems)
      const rawTargets = Array.isArray(input.target) ? input.target : input.target === undefined || input.target === null ? [] : [input.target]
      const propositions = this.graph.propositions(session.learnerId)
      const targets: string[] = []
      for (const t of rawTargets) {
        const id = typeof t === 'string' ? resolveProposition(t, propositions) : null
        if (id === null) problems.push(`target ${JSON.stringify(t)} is not a proposition of the learner's graph; use ids from the session context, or leave target out`)
        else if (!targets.includes(id)) targets.push(id)
      }
      if (problems.length > 0 || mode === undefined) throw new HodosError('INVALID_INPUT', `the problem was not posed: ${problems.join('; ')}`)
      const at = this.now()
      const id = this.ids.next('prb')
      this.sql.run("INSERT INTO practice_problems (id, session_id, statement, mode, targets_json, model_solution, status, posed_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        id, sessionId, statement, mode, JSON.stringify(targets), modelSolution, at)
      this.touch(sessionId)
      const row = this.sql.get('SELECT * FROM practice_problems WHERE id = ?', id)
      if (row === undefined) throw new HodosError('INTERNAL', 'problem not stored')
      return problemFromRow(row)
    })
  }

  /**
   * Conclude the active problem (the tutor).
   * @param sessionId - the session (resolved by the host from the chat).
   * @param input - untrusted tool input: outcome, verdict, rung, missClass, retest.
   * @returns the concluded problem.
   */
  conclude(sessionId: string, input: Readonly<Record<string, unknown>>): ProblemRecord {
    return this.store.transaction(() => {
      const problem = this.active(sessionId)
      if (problem === undefined) throw new HodosError('INVALID_STATE', 'no problem is active; pose one first')
      const problems: string[] = []
      const outcome = pick(input.outcome, TUTOR_OUTCOMES, 'outcome', problems)
      const verdict = text(input.verdict, 'verdict', PRACTICE_LIMITS.verdictChars, problems)
      const rung = input.rung === null || input.rung === undefined || input.rung === 'null' ? null : pick(input.rung, HINT_RUNGS, 'rung', problems) ?? null
      const missClass = input.missClass === null || input.missClass === undefined || input.missClass === 'null' ? null : pick(input.missClass, MISS_CLASSES, 'missClass', problems) ?? null
      const retest = input.retest === true || input.retest === 'true'
      if (problems.length > 0 || outcome === undefined) throw new HodosError('INVALID_INPUT', `the problem was not concluded: ${problems.join('; ')}`)
      return this.finish(problem, { outcome, verdict, rung, missClass, retest })
    })
  }

  private finish(problem: ProblemRecord, conclusion: ProblemConclusion): ProblemRecord {
    const at = this.now()
    this.sql.run("UPDATE practice_problems SET status = 'concluded', conclusion_json = ?, concluded_at = ? WHERE id = ?", JSON.stringify(conclusion), at, problem.id)
    this.touch(problem.sessionId)
    return { ...problem, status: 'concluded', conclusion, concludedAt: at }
  }

  private ownedProblem(learnerId: string, problemId: string): { problem: ProblemRecord; session: PracticeSessionRecord } {
    const row = this.sql.get('SELECT * FROM practice_problems WHERE id = ?', problemId)
    const problem = row === undefined ? undefined : problemFromRow(row)
    if (problem === undefined) throw new HodosError('NOT_FOUND', 'no such problem')
    const session = this.ownedSession(learnerId, problem.sessionId)
    return { problem, session }
  }

  /**
   * Submit the learner's thinking on the active problem.
   * @param learnerId - the learner.
   * @param problemId - the problem.
   * @param thinking - their work so far, or their answer.
   * @returns the message for the tutor.
   */
  submitThinking(learnerId: string, problemId: string, thinking: string): { session: PracticeSessionRecord; message: string } {
    const t = thinking.trim()
    if (t === '') throw new HodosError('INVALID_INPUT', 'write something first')
    if (t.length > PRACTICE_LIMITS.thinkingChars) throw new HodosError('INVALID_INPUT', `keep it under ${PRACTICE_LIMITS.thinkingChars} characters`)
    return this.store.transaction(() => {
      const { problem, session } = this.ownedProblem(learnerId, problemId)
      if (problem.status !== 'active') throw new HodosError('INVALID_STATE', 'this problem is concluded')
      this.sql.run('INSERT INTO practice_thinking (problem_id, text, created_at) VALUES (?, ?, ?)', problemId, t, this.now())
      this.touch(session.id)
      return { session, message: `Your thinking (problem ${problem.id}):\n${t}` }
    })
  }

  /**
   * Dismiss the active problem (the learner): it ends as surrendered, without a verdict.
   * @param learnerId - the learner.
   * @param problemId - the problem.
   * @returns the message for the tutor.
   */
  dismiss(learnerId: string, problemId: string): { session: PracticeSessionRecord; message: string } {
    return this.store.transaction(() => {
      const { problem, session } = this.ownedProblem(learnerId, problemId)
      if (problem.status !== 'active') throw new HodosError('INVALID_STATE', 'this problem is concluded')
      this.finish(problem, { outcome: 'dismissed', verdict: 'Dismissed by the learner.', rung: null, missClass: null, retest: false })
      return { session, message: `The learner dismissed problem ${problem.id}; treat it as surrendered. Wait for them to ask for the next problem.` }
    })
  }

  // ---- views ----

  private problemView(p: ProblemRecord): ProblemView {
    return {
      id: p.id, statement: p.statement, mode: p.mode, targets: p.targets, status: p.status, thinking: this.thinking(p.id), posedAt: p.posedAt,
      ...(p.conclusion === null ? {} : { conclusion: p.conclusion }),
      ...(p.status === 'concluded' ? { modelSolution: p.modelSolution } : {}),
    }
  }

  /**
   * The learner's view of a practice session.
   * @param learnerId - the owner.
   * @param sessionId - the session.
   * @returns the view; an active problem carries no model solution.
   */
  view(learnerId: string, sessionId: string): PracticeView {
    const session = this.ownedSession(learnerId, sessionId)
    const byId = new Map(this.graph.propositions(learnerId).map(p => [p.id, p]))
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      targets: session.targets.flatMap(t => {
        const p = byId.get(t)
        return p === undefined ? [] : [{ id: p.id, name: p.name, statement: p.statement }]
      }),
      problems: this.problems(session.id).map(p => this.problemView(p)),
    }
  }

  /**
   * The tutor's context: the picked material, the active problem and recent outcomes.
   * @param sessionId - the session.
   * @returns plain text for the system prompt.
   */
  tutorContext(sessionId: string): string {
    const session = this.session(sessionId)
    const propositions = this.graph.propositions(session.learnerId)
    const byId = new Map(propositions.map(p => [p.id, p]))
    const names = new Map(propositions.map(p => [p.id, p.name]))
    const lines = [`Practice session: ${session.title}`]
    if (session.targets.length === 0) lines.push('No propositions were picked: practise the topic the learner describes; leave target out of problems.')
    else {
      lines.push('Picked propositions (use these ids as targets):')
      for (const t of session.targets) {
        const p = byId.get(t)
        if (p !== undefined) lines.push(`[${p.id}] ${p.name}: ${p.statement}`)
      }
      const chains = chainsForSelection(session.targets, this.graph.chains(session.learnerId)).filter(c => c.premises.length > 0)
      if (chains.length > 0) lines.push('Reasoning chains among them:', ...chains.map(c => `- ${chainLine(c, names)}`))
    }
    const problems = this.problems(session.id)
    const active = problems.find(p => p.status === 'active')
    if (active !== undefined) {
      lines.push(`Active problem ${active.id} (${active.mode}): ${active.statement.slice(0, 400)}`)
      lines.push(`Your committed solution: ${active.modelSolution.slice(0, 2000)}`)
      const thinking = this.thinking(active.id)
      if (thinking.length > 0) lines.push(`The learner has submitted ${thinking.length} thinking trace(s) on it.`)
    }
    for (const p of problems.filter(q => q.status === 'concluded').slice(-6)) {
      const c = p.conclusion
      lines.push(`Concluded ${p.mode} problem on ${p.targets.join(', ') || 'the topic'}: ${c === null ? '?' : `${c.outcome}${c.rung === null ? '' : `, needed ${c.rung}`}${c.missClass === null ? '' : `, ${c.missClass} miss`}${c.retest ? ', retest' : ''}`}`)
    }
    return lines.join('\n')
  }
}
