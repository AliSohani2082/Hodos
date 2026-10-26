/**
 * SQLite persistence (`node:sqlite`, the engine DeepSeek Harness also uses).
 * WAL journaling, foreign keys on, versioned migrations, and explicit
 * `BEGIN IMMEDIATE` transactions. Observed evidence is append-only and kept
 * separate from derived skill state, which can be rebuilt from it.
 * @module @hodos/core/store
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { CourseSpec, ExerciseMode, GradeResult, JsonObject, JsonValue, LearningLoop, SkillKind, SkillWeight } from '@hodos/plugin-sdk'
import type { DiagnosticConfig, DiagnosticEstimate, DiagnosticNode, DiagnosticObservation } from '../diagnostic/diagnostic.js'
import { HodosError } from '../errors.js'
import { brandId, type JourneyId, type LearnerId } from '../ids.js'
import type { SkillState } from '../mastery/skill-state.js'
import type { JourneyEvent, JourneyState } from '../protocol/journey.js'
import { MIGRATIONS, type Migration } from './migrations.js'

type Row = Record<string, unknown>

function str(row: Row, col: string): string {
  const v = row[col]
  if (typeof v !== 'string') throw new HodosError('INTERNAL', `stored column ${col} is not text`)
  return v
}
function optStr(row: Row, col: string): string | null {
  const v = row[col]
  return typeof v === 'string' ? v : null
}
function num(row: Row, col: string): number {
  const v = row[col]
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  throw new HodosError('INTERNAL', `stored column ${col} is not numeric`)
}
function optNum(row: Row, col: string): number | null {
  const v = row[col]
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}
function json<T>(row: Row, col: string): T {
  try {
    return JSON.parse(str(row, col)) as T // stored by this module from typed values
  } catch (error) {
    throw new HodosError('INTERNAL', `stored column ${col} holds invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function optJson<T>(row: Row, col: string): T | null {
  return optStr(row, col) === null ? null : json<T>(row, col)
}

/** Stored learner. */
export interface LearnerRecord {
  readonly id: LearnerId
  readonly displayName: string
  readonly settings: JsonObject
  readonly createdAt: string
}

/** Course lifecycle states. */
export type CourseStatus = 'approved' | 'draft' | 'rejected'

/** Stored course version. */
export interface CourseRecord {
  readonly id: string
  readonly version: string
  readonly status: CourseStatus
  readonly origin: 'pack' | 'agent' | 'import'
  readonly pluginId: string | null
  readonly title: string
  readonly spec: CourseSpec
  readonly proposedBy: string | null
  readonly createdAt: string
  readonly approvedAt: string | null
}

/** Stored journey. */
export interface JourneyRecord {
  readonly id: JourneyId
  readonly learnerId: LearnerId
  readonly courseId: string
  readonly courseVersion: string
  readonly goalText: string
  readonly state: JourneyState
  readonly createdAt: string
  readonly updatedAt: string
}

/** Stored presentation (one exercise shown to a learner). */
export interface PresentationRecord {
  readonly id: string
  readonly learnerId: LearnerId
  readonly journeyId: string | null
  readonly courseId: string
  readonly courseVersion: string
  readonly itemId: string
  readonly skillId: string
  readonly mode: ExerciseMode
  readonly status: 'open' | 'completed' | 'abandoned'
  readonly attempts: number
  /** Whether the first attempt was correct (null before any attempt). */
  readonly firstCorrect: boolean | null
  readonly hintLevel: number
  /** Hint level at the time of the latest attempt (attempts since last hint = hintLevel unchanged). */
  readonly hintsAtLastAttempt: number
  readonly lastHintAt: string | null
  readonly tutorContact: boolean
  /** Whether the answer and explanation may be shown. */
  readonly released: boolean
  readonly progress: JsonValue | null
  readonly checkpointId: string | null
  readonly diagnosticId: string | null
  readonly presentedAt: string
  readonly completedAt: string | null
}

/** Assistance received before an attempt. */
export interface Assistance {
  readonly hints: number
  readonly relay: boolean
  readonly tutorContact: boolean
}

/** One skill tag frozen into evidence, with what the mastery model needs about the skill. */
export interface SkillFacts extends SkillWeight {
  readonly kind: SkillKind
  readonly loop: LearningLoop
  /** Items in the skill's deck (drill skills). */
  readonly deckSize?: number
  readonly fluencyTargetSec?: number
}

/** Item facts frozen into evidence so derived state can be rebuilt without the plugin or course. */
export interface ItemFacts {
  readonly skills: readonly SkillFacts[]
  readonly difficulty: number
  /** Elo difficulty used for this observation (calibrated, instance-wide). */
  readonly calibratedB: number
  readonly guessable: boolean
  readonly options?: number
  readonly expectedTimeSec?: number
  /** Graded by an advisory method (AI rubric): cannot count as a checkpoint success. */
  readonly advisory?: boolean
}

/** One append-only evidence record (a graded attempt). */
export interface EvidenceRecord {
  readonly seq: number
  readonly id: string
  readonly learnerId: LearnerId
  readonly journeyId: string | null
  readonly presentationId: string
  readonly courseId: string
  readonly courseVersion: string
  readonly itemId: string
  readonly kind: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly graderId: string
  readonly graderTrusted: boolean
  readonly mode: ExerciseMode
  readonly attempt: number
  readonly countsForMastery: boolean
  readonly response: JsonValue
  readonly grade: GradeResult
  readonly hintLevel: number
  readonly assisted: boolean
  readonly assistance: Assistance
  readonly channel: 'ui' | 'agent' | 'system'
  readonly latencyMs: number | null
  readonly confidence: 'sure' | 'unsure' | null
  readonly itemFacts: ItemFacts
  readonly createdAt: string
}

/** Stored checkpoint session. */
export interface CheckpointRecord {
  readonly id: string
  readonly learnerId: LearnerId
  readonly journeyId: string
  readonly skillId: string
  readonly status: 'active' | 'passed' | 'failed' | 'abandoned'
  readonly itemIds: readonly string[]
  /** The learner messaged the tutor while the checkpoint was active. */
  readonly tutorContact: boolean
  readonly result: JsonObject | null
  readonly startedAt: string
  readonly completedAt: string | null
}

/** Stored diagnostic session. */
export interface DiagnosticRecord {
  readonly id: string
  readonly learnerId: LearnerId
  readonly journeyId: string
  readonly status: 'active' | 'completed' | 'skipped'
  readonly scope: readonly DiagnosticNode[]
  readonly config: DiagnosticConfig
  readonly observations: readonly DiagnosticObservation[]
  readonly result: DiagnosticEstimate | null
  readonly createdAt: string
  readonly completedAt: string | null
}

/** Stored adaptive-layer lesson. */
export interface OverlayRecord {
  readonly id: string
  readonly learnerId: LearnerId
  readonly journeyId: string | null
  readonly skillId: string
  readonly kind: 'lesson' | 'remedial'
  readonly title: string
  readonly source: string
  readonly author: string
  readonly createdAt: string
}

/** Stored prior for a skill (diagnostic or self-report). */
export interface PriorRecord {
  readonly skillId: string
  readonly prior: number
  readonly source: 'diagnostic' | 'self-report'
  readonly diagnosedKnown: boolean
}

function presentationFromRow(row: Row): PresentationRecord {
  const fc = optNum(row, 'first_correct')
  return {
    id: str(row, 'id'),
    learnerId: brandId<'LearnerId'>(str(row, 'learner_id')),
    journeyId: optStr(row, 'journey_id'),
    courseId: str(row, 'course_id'),
    courseVersion: str(row, 'course_version'),
    itemId: str(row, 'item_id'),
    skillId: str(row, 'skill_id'),
    mode: str(row, 'mode') as ExerciseMode, // constrained on write
    status: str(row, 'status') as PresentationRecord['status'], // CHECK constraint
    attempts: num(row, 'attempts'),
    firstCorrect: fc === null ? null : fc === 1,
    hintLevel: num(row, 'hint_level'),
    hintsAtLastAttempt: num(row, 'hints_at_last_attempt'),
    lastHintAt: optStr(row, 'last_hint_at'),
    tutorContact: num(row, 'tutor_contact') === 1,
    released: num(row, 'released') === 1,
    progress: optJson<JsonValue>(row, 'progress_json'),
    checkpointId: optStr(row, 'checkpoint_id'),
    diagnosticId: optStr(row, 'diagnostic_id'),
    presentedAt: str(row, 'presented_at'),
    completedAt: optStr(row, 'completed_at'),
  }
}

function evidenceFromRow(row: Row): EvidenceRecord {
  return {
    seq: num(row, 'seq'),
    id: str(row, 'id'),
    learnerId: brandId<'LearnerId'>(str(row, 'learner_id')),
    journeyId: optStr(row, 'journey_id'),
    presentationId: str(row, 'presentation_id'),
    courseId: str(row, 'course_id'),
    courseVersion: str(row, 'course_version'),
    itemId: str(row, 'item_id'),
    kind: str(row, 'kind'),
    pluginId: str(row, 'plugin_id'),
    pluginVersion: str(row, 'plugin_version'),
    graderId: str(row, 'grader_id'),
    graderTrusted: num(row, 'grader_trusted') === 1,
    mode: str(row, 'mode') as ExerciseMode, // constrained on write
    attempt: num(row, 'attempt'),
    countsForMastery: num(row, 'counts_for_mastery') === 1,
    response: json<JsonValue>(row, 'response_json'),
    grade: json<GradeResult>(row, 'grade_json'),
    hintLevel: num(row, 'hint_level'),
    assisted: num(row, 'assisted') === 1,
    assistance: json<Assistance>(row, 'assistance_json'),
    channel: str(row, 'channel') as EvidenceRecord['channel'], // constrained on write
    latencyMs: optNum(row, 'latency_ms'),
    confidence: optStr(row, 'confidence') as EvidenceRecord['confidence'], // constrained on write
    itemFacts: json<ItemFacts>(row, 'item_facts_json'),
    createdAt: str(row, 'created_at'),
  }
}

/** The Hodos store. One instance per database file. */
export class HodosStore {
  private readonly db: DatabaseSync
  private depth = 0

  /**
   * Open (and migrate) a database.
   * @param path - file path, or `:memory:` for tests.
   * @param migrations - migrations to apply (defaults to the shipped set).
   */
  constructor(readonly path: string, migrations: readonly Migration[] = MIGRATIONS) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON')
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = FULL')
    }
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate(migrations)
  }

  private migrate(migrations: readonly Migration[]): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const applied = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map(r => num(r, 'version')))
    const latestKnown = Math.max(0, ...migrations.map(m => m.version))
    const latestApplied = Math.max(0, ...applied)
    if (latestApplied > latestKnown) {
      throw new HodosError('UNAVAILABLE', `database schema version ${latestApplied} is newer than this Hodos (${latestKnown}); refusing to downgrade`)
    }
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue
      this.transaction(() => {
        this.db.exec(m.sql)
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString())
      })
    }
  }

  /** Applied schema version. */
  get schemaVersion(): number {
    const row = this.db.prepare('SELECT max(version) AS v FROM schema_migrations').get()
    return row === undefined ? 0 : optNum(row, 'v') ?? 0
  }

  /**
   * Run a function in one transaction (nested calls join the outer one).
   * @param fn - synchronous work.
   * @returns the function's result.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1
      try {
        return fn()
      } finally {
        this.depth -= 1
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth = 0
    }
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params)
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params)
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params)
  }

  /** Close the database. */
  close(): void {
    this.db.close()
  }

  // ---- learners and identity ----

  /** @param learner - learner to insert. */
  insertLearner(learner: LearnerRecord): void {
    this.run('INSERT INTO learners (id, display_name, settings_json, created_at) VALUES (?, ?, ?, ?)', learner.id, learner.displayName, JSON.stringify(learner.settings), learner.createdAt)
  }

  /** @param id - learner id. @returns the learner, or undefined. */
  learner(id: string): LearnerRecord | undefined {
    const row = this.get('SELECT * FROM learners WHERE id = ?', id)
    return row === undefined ? undefined : {
      id: brandId<'LearnerId'>(str(row, 'id')), displayName: str(row, 'display_name'), settings: json<JsonObject>(row, 'settings_json'), createdAt: str(row, 'created_at'),
    }
  }

  /** @param principal - authenticated principal key. @returns its learner id, or undefined. */
  learnerForPrincipal(principal: string): LearnerId | undefined {
    const row = this.get('SELECT learner_id FROM principal_learners WHERE principal = ?', principal)
    return row === undefined ? undefined : brandId<'LearnerId'>(str(row, 'learner_id'))
  }

  /** @param principal - principal key. @param learnerId - learner. */
  bindPrincipal(principal: string, learnerId: LearnerId): void {
    this.run('INSERT INTO principal_learners (principal, learner_id) VALUES (?, ?) ON CONFLICT(principal) DO UPDATE SET learner_id = excluded.learner_id', principal, learnerId)
  }

  /** Bind a host session to a learner and optionally a journey. */
  bindSession(sessionId: string, learnerId: LearnerId, journeyId: string | null, at: string): void {
    this.run(`INSERT INTO session_bindings (session_id, learner_id, journey_id, bound_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET learner_id = excluded.learner_id, journey_id = COALESCE(excluded.journey_id, session_bindings.journey_id), bound_at = excluded.bound_at`,
    sessionId, learnerId, journeyId, at)
  }

  /** @param sessionId - host session id. @returns the binding, or undefined. */
  sessionBinding(sessionId: string): { learnerId: LearnerId; journeyId: string | null } | undefined {
    const row = this.get('SELECT learner_id, journey_id FROM session_bindings WHERE session_id = ?', sessionId)
    return row === undefined ? undefined : { learnerId: brandId<'LearnerId'>(str(row, 'learner_id')), journeyId: optStr(row, 'journey_id') }
  }

  /** @param journeyId - journey. @returns the host sessions bound to it. */
  sessionsForJourney(journeyId: string): string[] {
    return this.all('SELECT session_id FROM session_bindings WHERE journey_id = ? ORDER BY bound_at DESC', journeyId).map(r => str(r, 'session_id'))
  }

  // ---- courses ----

  /** @param course - course version to insert or replace (same id and version). */
  upsertCourse(course: CourseRecord): void {
    this.run(`INSERT INTO courses (id, version, status, origin, plugin_id, title, spec_json, proposed_by, created_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, version) DO UPDATE SET status = excluded.status, title = excluded.title, spec_json = excluded.spec_json, approved_at = excluded.approved_at`,
    course.id, course.version, course.status, course.origin, course.pluginId, course.title, JSON.stringify(course.spec), course.proposedBy, course.createdAt, course.approvedAt)
  }

  private courseFromRow(row: Row): CourseRecord {
    return {
      id: str(row, 'id'), version: str(row, 'version'), status: str(row, 'status') as CourseStatus, // CHECK constraint
      origin: str(row, 'origin') as CourseRecord['origin'], // CHECK constraint
      pluginId: optStr(row, 'plugin_id'), title: str(row, 'title'), spec: json<CourseSpec>(row, 'spec_json'),
      proposedBy: optStr(row, 'proposed_by'), createdAt: str(row, 'created_at'), approvedAt: optStr(row, 'approved_at'),
    }
  }

  /** @param id - course id. @param version - version. @returns the course version, or undefined. */
  course(id: string, version: string): CourseRecord | undefined {
    const row = this.get('SELECT * FROM courses WHERE id = ? AND version = ?', id, version)
    return row === undefined ? undefined : this.courseFromRow(row)
  }

  /** @param status - optional status filter. @returns course versions, newest first. */
  courses(status?: CourseStatus): CourseRecord[] {
    const rows = status === undefined
      ? this.all('SELECT * FROM courses ORDER BY created_at DESC')
      : this.all('SELECT * FROM courses WHERE status = ? ORDER BY created_at DESC', status)
    return rows.map(r => this.courseFromRow(r))
  }

  /** @param id - course id. @param version - version. @param status - new status. @param at - time. */
  setCourseStatus(id: string, version: string, status: CourseStatus, at: string): void {
    this.run('UPDATE courses SET status = ?, approved_at = ? WHERE id = ? AND version = ?', status, status === 'approved' ? at : null, id, version)
  }

  // ---- journeys ----

  /** @param journey - journey to insert. */
  insertJourney(journey: JourneyRecord): void {
    this.run('INSERT INTO journeys (id, learner_id, course_id, course_version, goal_text, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      journey.id, journey.learnerId, journey.courseId, journey.courseVersion, journey.goalText, JSON.stringify(journey.state), journey.createdAt, journey.updatedAt)
  }

  private journeyFromRow(row: Row): JourneyRecord {
    return {
      id: brandId<'JourneyId'>(str(row, 'id')), learnerId: brandId<'LearnerId'>(str(row, 'learner_id')), courseId: str(row, 'course_id'),
      courseVersion: str(row, 'course_version'), goalText: str(row, 'goal_text'), state: json<JourneyState>(row, 'state_json'),
      createdAt: str(row, 'created_at'), updatedAt: str(row, 'updated_at'),
    }
  }

  /** @param id - journey id. @returns the journey, or undefined. */
  journey(id: string): JourneyRecord | undefined {
    const row = this.get('SELECT * FROM journeys WHERE id = ?', id)
    return row === undefined ? undefined : this.journeyFromRow(row)
  }

  /** @param learnerId - learner. @returns journeys, most recently updated first. */
  journeys(learnerId: string): JourneyRecord[] {
    return this.all('SELECT * FROM journeys WHERE learner_id = ? ORDER BY updated_at DESC, rowid DESC', learnerId).map(r => this.journeyFromRow(r))
  }

  /** Persist a journey state change together with its event. */
  appendJourneyEvent(journeyId: string, event: JourneyEvent, state: JourneyState, channel: string, at: string): void {
    this.run('INSERT INTO journey_events (journey_id, event_json, actor_channel, created_at) VALUES (?, ?, ?, ?)', journeyId, JSON.stringify(event), channel, at)
    this.run('UPDATE journeys SET state_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(state), at, journeyId)
  }

  /** @param journeyId - journey. @returns its events in order. */
  journeyEvents(journeyId: string): Array<{ event: JourneyEvent; channel: string; createdAt: string }> {
    return this.all('SELECT event_json, actor_channel, created_at FROM journey_events WHERE journey_id = ? ORDER BY seq', journeyId)
      .map(r => ({ event: json<JourneyEvent>(r, 'event_json'), channel: str(r, 'actor_channel'), createdAt: str(r, 'created_at') }))
  }

  /** Touch a journey's update time (e.g. on activity). */
  touchJourney(journeyId: string, at: string): void {
    this.run('UPDATE journeys SET updated_at = ? WHERE id = ?', at, journeyId)
  }

  // ---- presentations ----

  /** @param p - presentation to insert. */
  insertPresentation(p: PresentationRecord): void {
    this.run(`INSERT INTO presentations (id, learner_id, journey_id, course_id, course_version, item_id, skill_id, mode, status, attempts, first_correct,
      hint_level, hints_at_last_attempt, last_hint_at, tutor_contact, released, progress_json, checkpoint_id, diagnostic_id, presented_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.id, p.learnerId, p.journeyId, p.courseId, p.courseVersion, p.itemId, p.skillId, p.mode, p.status, p.attempts,
    p.firstCorrect === null ? null : p.firstCorrect ? 1 : 0, p.hintLevel, p.hintsAtLastAttempt, p.lastHintAt, p.tutorContact ? 1 : 0,
    p.released ? 1 : 0, p.progress === null ? null : JSON.stringify(p.progress), p.checkpointId, p.diagnosticId, p.presentedAt, p.completedAt)
  }

  /** @param p - full updated presentation (same id). */
  updatePresentation(p: PresentationRecord): void {
    this.run(`UPDATE presentations SET status = ?, attempts = ?, first_correct = ?, hint_level = ?, hints_at_last_attempt = ?, last_hint_at = ?,
      tutor_contact = ?, released = ?, progress_json = ?, completed_at = ? WHERE id = ?`,
    p.status, p.attempts, p.firstCorrect === null ? null : p.firstCorrect ? 1 : 0, p.hintLevel, p.hintsAtLastAttempt, p.lastHintAt,
    p.tutorContact ? 1 : 0, p.released ? 1 : 0, p.progress === null ? null : JSON.stringify(p.progress), p.completedAt, p.id)
  }

  /** @param id - presentation id. @returns the presentation, or undefined. */
  presentation(id: string): PresentationRecord | undefined {
    const row = this.get('SELECT * FROM presentations WHERE id = ?', id)
    return row === undefined ? undefined : presentationFromRow(row)
  }

  /** @param learnerId - learner. @returns open presentations, newest first. */
  openPresentations(learnerId: string): PresentationRecord[] {
    return this.all("SELECT * FROM presentations WHERE learner_id = ? AND status = 'open' ORDER BY presented_at DESC, rowid DESC", learnerId).map(presentationFromRow)
  }

  /** @param learnerId - learner. @param limit - max rows. @returns recent presentations, newest first. */
  recentPresentations(learnerId: string, limit = 50): PresentationRecord[] {
    return this.all('SELECT * FROM presentations WHERE learner_id = ? ORDER BY presented_at DESC, rowid DESC LIMIT ?', learnerId, limit).map(presentationFromRow)
  }

  /** @param checkpointId - checkpoint. @returns its presentations in order. */
  checkpointPresentations(checkpointId: string): PresentationRecord[] {
    return this.all('SELECT * FROM presentations WHERE checkpoint_id = ? ORDER BY presented_at, rowid', checkpointId).map(presentationFromRow)
  }

  /**
   * Mark every open presentation and active checkpoint of a learner as having had tutor contact.
   * @param learnerId - learner.
   * @returns the number of presentations and checkpoints marked.
   */
  markTutorContact(learnerId: string): number {
    const p = this.db.prepare("UPDATE presentations SET tutor_contact = 1 WHERE learner_id = ? AND status = 'open'").run(learnerId)
    const c = this.db.prepare("UPDATE checkpoints SET tutor_contact = 1 WHERE learner_id = ? AND status = 'active'").run(learnerId)
    return Number(p.changes) + Number(c.changes)
  }

  // ---- evidence ----

  /** @param e - evidence without its sequence number. @returns the assigned sequence. */
  appendEvidence(e: Omit<EvidenceRecord, 'seq'>): number {
    const result = this.db.prepare(`INSERT INTO evidence (id, learner_id, journey_id, presentation_id, course_id, course_version, item_id, kind, plugin_id,
      plugin_version, grader_id, grader_trusted, mode, attempt, counts_for_mastery, response_json, grade_json, hint_level, assisted, assistance_json,
      channel, latency_ms, confidence, item_facts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.id, e.learnerId, e.journeyId, e.presentationId, e.courseId, e.courseVersion, e.itemId, e.kind, e.pluginId, e.pluginVersion, e.graderId,
        e.graderTrusted ? 1 : 0, e.mode, e.attempt, e.countsForMastery ? 1 : 0, JSON.stringify(e.response), JSON.stringify(e.grade), e.hintLevel,
        e.assisted ? 1 : 0, JSON.stringify(e.assistance), e.channel, e.latencyMs, e.confidence, JSON.stringify(e.itemFacts), e.createdAt)
    return Number(result.lastInsertRowid)
  }

  /** @param learnerId - learner. @param afterSeq - exclusive lower bound. @returns evidence in order. */
  evidence(learnerId: string, afterSeq = 0): EvidenceRecord[] {
    return this.all('SELECT * FROM evidence WHERE learner_id = ? AND seq > ? ORDER BY seq', learnerId, afterSeq).map(evidenceFromRow)
  }

  /** @param presentationId - presentation. @returns its evidence in order. */
  evidenceFor(presentationId: string): EvidenceRecord[] {
    return this.all('SELECT * FROM evidence WHERE presentation_id = ? ORDER BY seq', presentationId).map(evidenceFromRow)
  }

  /** Record a hint reveal. */
  appendHint(learnerId: string, presentationId: string, level: number, channel: string, at: string): void {
    this.run('INSERT INTO hint_events (learner_id, presentation_id, level, channel, created_at) VALUES (?, ?, ?, ?, ?)', learnerId, presentationId, level, channel, at)
  }

  /** @param learnerId - learner. @returns number of hints revealed. */
  hintCount(learnerId: string): number {
    const row = this.get('SELECT count(*) AS n FROM hint_events WHERE learner_id = ?', learnerId)
    return row === undefined ? 0 : num(row, 'n')
  }

  // ---- derived skill state ----

  /** @param learnerId - learner. @returns stored skill states by skill id. */
  skillStates(learnerId: string): Map<string, SkillState> {
    return new Map(this.all('SELECT skill_id, state_json FROM skill_states WHERE learner_id = ?', learnerId)
      .map(r => [str(r, 'skill_id'), json<SkillState>(r, 'state_json')]))
  }

  /** @param learnerId - learner. @returns the highest evidence sequence reflected in derived state. */
  derivedThrough(learnerId: string): number {
    const row = this.get('SELECT max(derived_through_seq) AS s FROM skill_states WHERE learner_id = ?', learnerId)
    return row === undefined ? 0 : optNum(row, 's') ?? 0
  }

  /** Write derived states. */
  saveSkillStates(learnerId: string, states: Iterable<SkillState>, throughSeq: number, at: string): void {
    const stmt = this.db.prepare(`INSERT INTO skill_states (learner_id, skill_id, state_json, p_mastered, gate_open, derived_through_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(learner_id, skill_id) DO UPDATE SET state_json = excluded.state_json, p_mastered = excluded.p_mastered,
      gate_open = excluded.gate_open, derived_through_seq = excluded.derived_through_seq, updated_at = excluded.updated_at`)
    for (const s of states) stmt.run(learnerId, s.skillId, JSON.stringify(s), s.pMastered, s.gateOpen ? 1 : 0, throughSeq, at)
  }

  /** Delete all derived state of a learner (evidence is kept). */
  clearDerived(learnerId: string): void {
    this.run('DELETE FROM skill_states WHERE learner_id = ?', learnerId)
  }

  /** @param learnerId - learner. @returns stored priors by skill. */
  priors(learnerId: string): Map<string, PriorRecord> {
    return new Map(this.all('SELECT * FROM skill_priors WHERE learner_id = ?', learnerId).map(r => [str(r, 'skill_id'), {
      skillId: str(r, 'skill_id'), prior: num(r, 'prior'), source: str(r, 'source') as PriorRecord['source'], // CHECK constraint
      diagnosedKnown: num(r, 'diagnosed_known') === 1,
    }]))
  }

  /** Save a prior; a diagnostic prior replaces a self-report, never the reverse. */
  savePrior(learnerId: string, prior: PriorRecord, at: string): void {
    this.run(`INSERT INTO skill_priors (learner_id, skill_id, prior, source, diagnosed_known, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(learner_id, skill_id) DO UPDATE SET prior = excluded.prior, source = excluded.source, diagnosed_known = excluded.diagnosed_known
      WHERE skill_priors.source = 'self-report' OR excluded.source = 'diagnostic'`,
    learnerId, prior.skillId, prior.prior, prior.source, prior.diagnosedKnown ? 1 : 0, at)
  }

  /** @param key - item calibration key. @returns calibration, or undefined. */
  calibration(key: string): { b: number; m: number } | undefined {
    const row = this.get('SELECT b, m FROM item_calibration WHERE item_key = ?', key)
    return row === undefined ? undefined : { b: num(row, 'b'), m: num(row, 'm') }
  }

  /** Save an item calibration. */
  saveCalibration(key: string, value: { b: number; m: number }): void {
    this.run('INSERT INTO item_calibration (item_key, b, m) VALUES (?, ?, ?) ON CONFLICT(item_key) DO UPDATE SET b = excluded.b, m = excluded.m', key, value.b, value.m)
  }

  // ---- checkpoints, diagnostics, overlays, checks, environment state ----

  /** @param c - checkpoint to insert. */
  insertCheckpoint(c: CheckpointRecord): void {
    this.run('INSERT INTO checkpoints (id, learner_id, journey_id, skill_id, status, item_ids_json, tutor_contact, result_json, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, c.learnerId, c.journeyId, c.skillId, c.status, JSON.stringify(c.itemIds), c.tutorContact ? 1 : 0, c.result === null ? null : JSON.stringify(c.result), c.startedAt, c.completedAt)
  }

  /** Finish a checkpoint. */
  finishCheckpoint(id: string, status: CheckpointRecord['status'], result: JsonObject, at: string): void {
    this.run('UPDATE checkpoints SET status = ?, result_json = ?, completed_at = ? WHERE id = ?', status, JSON.stringify(result), at, id)
  }

  private checkpointFromRow(row: Row): CheckpointRecord {
    return {
      id: str(row, 'id'), learnerId: brandId<'LearnerId'>(str(row, 'learner_id')), journeyId: str(row, 'journey_id'), skillId: str(row, 'skill_id'),
      status: str(row, 'status') as CheckpointRecord['status'], // CHECK constraint
      itemIds: json<string[]>(row, 'item_ids_json'), tutorContact: num(row, 'tutor_contact') === 1, result: optJson<JsonObject>(row, 'result_json'),
      startedAt: str(row, 'started_at'), completedAt: optStr(row, 'completed_at'),
    }
  }

  /** @param id - checkpoint id. @returns the checkpoint, or undefined. */
  checkpoint(id: string): CheckpointRecord | undefined {
    const row = this.get('SELECT * FROM checkpoints WHERE id = ?', id)
    return row === undefined ? undefined : this.checkpointFromRow(row)
  }

  /**
   * @param learnerId - learner. @param skillId - skill. @param since - ISO time (inclusive).
   * @returns how many of the learner's checkpoints for the skill failed since then.
   */
  failedCheckpointsSince(learnerId: string, skillId: string, since: string): number {
    const row = this.get("SELECT count(*) AS n FROM checkpoints WHERE learner_id = ? AND skill_id = ? AND status = 'failed' AND completed_at >= ?", learnerId, skillId, since)
    return row === undefined ? 0 : num(row, 'n')
  }

  /** @param journeyId - journey. @returns checkpoints, newest first. */
  checkpoints(journeyId: string): CheckpointRecord[] {
    return this.all('SELECT * FROM checkpoints WHERE journey_id = ? ORDER BY started_at DESC, rowid DESC', journeyId).map(r => this.checkpointFromRow(r))
  }

  /** @param d - diagnostic to insert. */
  insertDiagnostic(d: DiagnosticRecord): void {
    this.run('INSERT INTO diagnostics (id, learner_id, journey_id, status, scope_json, config_json, observations_json, result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      d.id, d.learnerId, d.journeyId, d.status, JSON.stringify(d.scope), JSON.stringify(d.config), JSON.stringify(d.observations),
      d.result === null ? null : JSON.stringify(d.result), d.createdAt, d.completedAt)
  }

  /** Update a diagnostic's answers and status. */
  updateDiagnostic(id: string, status: DiagnosticRecord['status'], observations: readonly DiagnosticObservation[], result: DiagnosticEstimate | null, completedAt: string | null): void {
    this.run('UPDATE diagnostics SET status = ?, observations_json = ?, result_json = ?, completed_at = ? WHERE id = ?',
      status, JSON.stringify(observations), result === null ? null : JSON.stringify(result), completedAt, id)
  }

  /** @param journeyId - journey. @returns its latest diagnostic, or undefined. */
  diagnosticForJourney(journeyId: string): DiagnosticRecord | undefined {
    const row = this.get('SELECT * FROM diagnostics WHERE journey_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', journeyId)
    return row === undefined ? undefined : {
      id: str(row, 'id'), learnerId: brandId<'LearnerId'>(str(row, 'learner_id')), journeyId: str(row, 'journey_id'),
      status: str(row, 'status') as DiagnosticRecord['status'], // CHECK constraint
      scope: json<DiagnosticNode[]>(row, 'scope_json'), config: json<DiagnosticConfig>(row, 'config_json'),
      observations: json<DiagnosticObservation[]>(row, 'observations_json'), result: optJson<DiagnosticEstimate>(row, 'result_json'),
      createdAt: str(row, 'created_at'), completedAt: optStr(row, 'completed_at'),
    }
  }

  /** @param o - overlay to insert. */
  insertOverlay(o: OverlayRecord): void {
    this.run('INSERT INTO overlays (id, learner_id, journey_id, skill_id, kind, title, source, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      o.id, o.learnerId, o.journeyId, o.skillId, o.kind, o.title, o.source, o.author, o.createdAt)
  }

  /** @param learnerId - learner. @param id - overlay id. @returns the learner's overlay, or undefined. */
  overlay(learnerId: string, id: string): OverlayRecord | undefined {
    return this.overlayRows('SELECT * FROM overlays WHERE learner_id = ? AND id = ?', learnerId, id)[0]
  }

  private overlayRows(sql: string, ...params: SQLInputValue[]): OverlayRecord[] {
    return this.all(sql, ...params).map(r => ({
      id: str(r, 'id'), learnerId: brandId<'LearnerId'>(str(r, 'learner_id')), journeyId: optStr(r, 'journey_id'), skillId: str(r, 'skill_id'),
      kind: str(r, 'kind') as OverlayRecord['kind'], // CHECK constraint
      title: str(r, 'title'), source: str(r, 'source'), author: str(r, 'author'), createdAt: str(r, 'created_at'),
    }))
  }

  /** @param learnerId - learner. @param skillId - skill. @returns overlays, oldest first. */
  overlays(learnerId: string, skillId: string): OverlayRecord[] {
    return this.overlayRows('SELECT * FROM overlays WHERE learner_id = ? AND skill_id = ? ORDER BY created_at, rowid', learnerId, skillId)
  }

  /** Record a formative lesson check answer. */
  saveCheckAnswer(learnerId: string, lessonId: string, checkId: string, correct: boolean, at: string): void {
    this.run(`INSERT INTO lesson_checks (learner_id, lesson_id, check_id, correct, answered_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(learner_id, lesson_id, check_id) DO UPDATE SET correct = MAX(lesson_checks.correct, excluded.correct), answered_at = excluded.answered_at`,
    learnerId, lessonId, checkId, correct ? 1 : 0, at)
  }

  /** @param learnerId - learner. @param lessonId - lesson. @returns answered checks. */
  checkAnswers(learnerId: string, lessonId: string): Map<string, boolean> {
    return new Map(this.all('SELECT check_id, correct FROM lesson_checks WHERE learner_id = ? AND lesson_id = ?', learnerId, lessonId)
      .map(r => [str(r, 'check_id'), num(r, 'correct') === 1]))
  }

  /** Store environment-specific state for a learner. */
  setEnvState(learnerId: string, pluginId: string, key: string, value: JsonValue, at: string): void {
    this.run(`INSERT INTO env_state (learner_id, plugin_id, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(learner_id, plugin_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    learnerId, pluginId, key, JSON.stringify(value), at)
  }

  /** @returns stored environment state, or undefined. */
  envState(learnerId: string, pluginId: string, key: string): JsonValue | undefined {
    const row = this.get('SELECT value_json FROM env_state WHERE learner_id = ? AND plugin_id = ? AND key = ?', learnerId, pluginId, key)
    return row === undefined ? undefined : json<JsonValue>(row, 'value_json')
  }

  /** Record a security-relevant event (leak blocked, forbidden access, rejected plugin output). */
  securityEvent(type: string, learnerId: string | null, details: JsonObject, at: string): void {
    this.run('INSERT INTO security_events (type, learner_id, details_json, created_at) VALUES (?, ?, ?, ?)', type, learnerId, JSON.stringify(details), at)
  }

  /** @returns security events, oldest first. */
  securityEvents(): Array<{ type: string; learnerId: string | null; details: JsonObject; createdAt: string }> {
    return this.all('SELECT * FROM security_events ORDER BY seq').map(r => ({
      type: str(r, 'type'), learnerId: optStr(r, 'learner_id'), details: json<JsonObject>(r, 'details_json'), createdAt: str(r, 'created_at'),
    }))
  }
}
