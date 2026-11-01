/**
 * Storage of learning sessions, their questions, transcript and per-node
 * mastery, in the Hodos store's database (schema version 2).
 *
 * Question bodies hold answer keys and committed answers; they are read only
 * by the learning service, which projects them before anything leaves the
 * server.
 * @module @hodos/core/learn/repository
 */
import type { JsonValue } from '@hodos/plugin-sdk'
import { brandId, type LearnerId } from '../ids.js'
import type { MemoryCard } from '../mastery/fsrs.js'
import { json, num, optJson, optStr, str, type Row, type SqlRunner } from '../store/rows.js'
import type { HodosStore } from '../store/store.js'
import type { PlanTree } from './plan.js'
import type { QuestionBody, QuestionRole, QuestionSpec, QuestionVerdict } from './question.js'
import type { LearnPhase, ProbeAssessment } from './session.js'

/** A stored learning session. */
export interface LearnSessionRecord {
  readonly id: string
  readonly learnerId: LearnerId
  /** The host chat the session runs in. */
  readonly hostSessionId: string | null
  readonly goal: string
  readonly phase: LearnPhase
  readonly assessment: ProbeAssessment | null
  readonly plan: PlanTree | null
  readonly planSource: string | null
  /** How many times the plan was written. */
  readonly planVersion: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Where a question came from: written by the model, or drawn from an installed course. */
export type QuestionOrigin = 'model' | 'bank'

/** Lifecycle of a question. A newer question supersedes one left open. */
export type QuestionStatus = 'open' | 'answered' | 'superseded'

/** A stored question with its server-only body. */
export interface QuestionRecord {
  readonly seq: number
  readonly id: string
  readonly sessionId: string
  readonly spec: QuestionSpec
  readonly origin: QuestionOrigin
  readonly status: QuestionStatus
  /** Server-held progress of a stepwise interface question. */
  readonly progress: JsonValue | null
  readonly response: JsonValue | null
  readonly answerText: string | null
  readonly thinking: string | null
  readonly verdict: QuestionVerdict | null
  readonly askedAt: string
  readonly answeredAt: string | null
}

/** One transcript entry: prose the teacher wrote or the learner sent. */
export interface TranscriptEntry {
  readonly seq: number
  readonly sessionId: string
  readonly role: 'teacher' | 'learner'
  readonly text: string
  readonly createdAt: string
}

/** The mastery estimate and review schedule of one plan node. */
export interface NodeStateRecord {
  readonly sessionId: string
  readonly nodeId: string
  readonly learnerId: LearnerId
  readonly pMastered: number
  readonly card: MemoryCard | null
  readonly dueAt: string | null
  readonly observations: number
  readonly updatedAt: string
}

function sessionFromRow(row: Row): LearnSessionRecord {
  return {
    id: str(row, 'id'),
    learnerId: brandId<'LearnerId'>(str(row, 'learner_id')),
    hostSessionId: optStr(row, 'host_session_id'),
    goal: str(row, 'goal'),
    phase: str(row, 'phase') as LearnPhase, // CHECK constraint
    assessment: optJson(row, 'assessment_json') as ProbeAssessment | null,
    plan: optJson(row, 'plan_json') as PlanTree | null,
    planSource: optStr(row, 'plan_source'),
    planVersion: num(row, 'plan_version'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  }
}

function questionFromRow(row: Row): QuestionRecord {
  const nodeId = optStr(row, 'node_id')
  const details = optStr(row, 'details')
  return {
    seq: num(row, 'seq'),
    id: str(row, 'id'),
    sessionId: str(row, 'session_id'),
    spec: {
      role: str(row, 'role') as QuestionRole, // CHECK constraint
      ...(nodeId === null ? {} : { nodeId }),
      prompt: str(row, 'prompt'),
      ...(details === null ? {} : { details }),
      body: json(row, 'body_json') as QuestionBody,
    },
    origin: str(row, 'origin') as QuestionOrigin, // CHECK constraint
    status: str(row, 'status') as QuestionStatus, // CHECK constraint
    progress: optJson(row, 'progress_json') as JsonValue | null,
    response: optJson(row, 'response_json') as JsonValue | null,
    answerText: optStr(row, 'answer_text'),
    thinking: optStr(row, 'thinking'),
    verdict: optJson(row, 'verdict_json') as QuestionVerdict | null,
    askedAt: str(row, 'asked_at'),
    answeredAt: optStr(row, 'answered_at'),
  }
}

function nodeStateFromRow(row: Row): NodeStateRecord {
  return {
    sessionId: str(row, 'session_id'),
    nodeId: str(row, 'node_id'),
    learnerId: brandId<'LearnerId'>(str(row, 'learner_id')),
    pMastered: num(row, 'p_mastered'),
    card: optJson(row, 'card_json') as MemoryCard | null,
    dueAt: optStr(row, 'due_at'),
    observations: num(row, 'observations'),
    updatedAt: str(row, 'updated_at'),
  }
}

const jsonOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value))

/** Learning-session tables of a Hodos store. */
export class LearnRepository {
  private readonly sql: SqlRunner

  /** @param store - the store whose database holds the tables. */
  constructor(readonly store: HodosStore) {
    this.sql = store.sql
  }

  /**
   * Run work in one transaction.
   * @param fn - synchronous work.
   * @returns its result.
   */
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  // ---- sessions ----

  /** @param s - the session to insert. */
  insertSession(s: LearnSessionRecord): void {
    this.sql.run(`INSERT INTO learn_sessions (id, learner_id, host_session_id, goal, phase, assessment_json, plan_json, plan_source, plan_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id, s.learnerId, s.hostSessionId, s.goal, s.phase, jsonOrNull(s.assessment), jsonOrNull(s.plan), s.planSource, s.planVersion, s.createdAt, s.updatedAt)
  }

  /** @param s - the session with its new phase, assessment and plan. */
  updateSession(s: LearnSessionRecord): void {
    this.sql.run('UPDATE learn_sessions SET phase = ?, assessment_json = ?, plan_json = ?, plan_source = ?, plan_version = ?, updated_at = ? WHERE id = ?',
      s.phase, jsonOrNull(s.assessment), jsonOrNull(s.plan), s.planSource, s.planVersion, s.updatedAt, s.id)
  }

  /** @param id - session id. @returns the session, or undefined. */
  session(id: string): LearnSessionRecord | undefined {
    const row = this.sql.get('SELECT * FROM learn_sessions WHERE id = ?', id)
    return row === undefined ? undefined : sessionFromRow(row)
  }

  /** @param hostSessionId - host chat id. @returns the learning session in that chat, or undefined. */
  sessionForHost(hostSessionId: string): LearnSessionRecord | undefined {
    const row = this.sql.get('SELECT * FROM learn_sessions WHERE host_session_id = ?', hostSessionId)
    return row === undefined ? undefined : sessionFromRow(row)
  }

  /** @param learnerId - learner. @returns their sessions, most recently active first. */
  sessions(learnerId: string): LearnSessionRecord[] {
    return this.sql.all('SELECT * FROM learn_sessions WHERE learner_id = ? ORDER BY updated_at DESC, id', learnerId).map(sessionFromRow)
  }

  // ---- questions ----

  /** @param q - the question to insert (its seq is assigned). */
  insertQuestion(q: Omit<QuestionRecord, 'seq'>): void {
    this.sql.run(`INSERT INTO learn_questions (id, session_id, role, node_id, prompt, details, body_json, origin, status, progress_json, response_json, answer_text, thinking, verdict_json, asked_at, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    q.id, q.sessionId, q.spec.role, q.spec.nodeId ?? null, q.spec.prompt, q.spec.details ?? null, JSON.stringify(q.spec.body), q.origin, q.status,
    jsonOrNull(q.progress), jsonOrNull(q.response), q.answerText, q.thinking, jsonOrNull(q.verdict), q.askedAt, q.answeredAt)
  }

  /** @param q - the question with its new status, progress and answer. */
  updateQuestion(q: QuestionRecord): void {
    this.sql.run('UPDATE learn_questions SET status = ?, progress_json = ?, response_json = ?, answer_text = ?, thinking = ?, verdict_json = ?, answered_at = ? WHERE id = ?',
      q.status, jsonOrNull(q.progress), jsonOrNull(q.response), q.answerText, q.thinking, jsonOrNull(q.verdict), q.answeredAt, q.id)
  }

  /** @param id - question id. @returns the question, or undefined. */
  question(id: string): QuestionRecord | undefined {
    const row = this.sql.get('SELECT * FROM learn_questions WHERE id = ?', id)
    return row === undefined ? undefined : questionFromRow(row)
  }

  /** @param sessionId - session. @returns its open questions, oldest first. */
  openQuestions(sessionId: string): QuestionRecord[] {
    return this.sql.all("SELECT * FROM learn_questions WHERE session_id = ? AND status = 'open' ORDER BY seq", sessionId).map(questionFromRow)
  }

  /** @param sessionId - session. @returns every question, oldest first. */
  questions(sessionId: string): QuestionRecord[] {
    return this.sql.all('SELECT * FROM learn_questions WHERE session_id = ? ORDER BY seq', sessionId).map(questionFromRow)
  }

  /** @param sessionId - session. @returns plan node ids of the questions asked, oldest first. */
  taggedNodes(sessionId: string): string[] {
    return this.sql.all('SELECT node_id FROM learn_questions WHERE session_id = ? AND node_id IS NOT NULL ORDER BY seq', sessionId).map(r => str(r, 'node_id'))
  }

  // ---- transcript ----

  /** Append one transcript entry. */
  appendTranscript(sessionId: string, role: TranscriptEntry['role'], text: string, at: string): void {
    this.sql.run('INSERT INTO learn_transcript (session_id, role, text, created_at) VALUES (?, ?, ?, ?)', sessionId, role, text, at)
  }

  /** @param sessionId - session. @param afterSeq - exclusive lower bound. @returns entries in order. */
  transcript(sessionId: string, afterSeq = 0): TranscriptEntry[] {
    return this.sql.all('SELECT * FROM learn_transcript WHERE session_id = ? AND seq > ? ORDER BY seq', sessionId, afterSeq).map(row => ({
      seq: num(row, 'seq'),
      sessionId: str(row, 'session_id'),
      role: str(row, 'role') as TranscriptEntry['role'], // CHECK constraint
      text: str(row, 'text'),
      createdAt: str(row, 'created_at'),
    }))
  }

  // ---- node mastery ----

  /** @param s - the node state to insert or replace. */
  saveNodeState(s: NodeStateRecord): void {
    this.sql.run(`INSERT INTO learn_node_states (session_id, node_id, learner_id, p_mastered, card_json, due_at, observations, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, node_id) DO UPDATE SET p_mastered = excluded.p_mastered, card_json = excluded.card_json, due_at = excluded.due_at, observations = excluded.observations, updated_at = excluded.updated_at`,
    s.sessionId, s.nodeId, s.learnerId, s.pMastered, jsonOrNull(s.card), s.dueAt, s.observations, s.updatedAt)
  }

  /** @param sessionId - session. @param nodeId - plan node. @returns its state, or undefined. */
  nodeState(sessionId: string, nodeId: string): NodeStateRecord | undefined {
    const row = this.sql.get('SELECT * FROM learn_node_states WHERE session_id = ? AND node_id = ?', sessionId, nodeId)
    return row === undefined ? undefined : nodeStateFromRow(row)
  }

  /** @param sessionId - session. @returns every node state of the session. */
  nodeStates(sessionId: string): NodeStateRecord[] {
    return this.sql.all('SELECT * FROM learn_node_states WHERE session_id = ? ORDER BY node_id', sessionId).map(nodeStateFromRow)
  }

  /** @param learnerId - learner. @param now - ISO time. @returns node states due for review, most overdue first. */
  dueNodes(learnerId: string, now: string): NodeStateRecord[] {
    return this.sql.all('SELECT * FROM learn_node_states WHERE learner_id = ? AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at', learnerId, now).map(nodeStateFromRow)
  }
}
