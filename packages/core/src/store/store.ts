/**
 * SQLite persistence (`node:sqlite`, the engine DeepSeek Harness also uses).
 * WAL journaling, foreign keys on, versioned migrations, and explicit
 * `BEGIN IMMEDIATE` transactions. The store holds learners, host-session
 * bindings and courses; the learning, knowledge-graph and practice
 * repositories share its database through {@link HodosStore.sql}.
 * @module @hodos/core/store
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { CourseSpec, JsonObject } from '@hodos/plugin-sdk'
import { HodosError } from '../errors.js'
import { brandId, type LearnerId } from '../ids.js'
import { MIGRATIONS, type Migration } from './migrations.js'
import { json, num, optNum, optStr, str, type Row, type SqlRunner } from './rows.js'

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
    for (const m of migrations.toSorted((a, b) => a.version - b.version)) {
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

  /** Statements on this database for the repositories that share it (core-internal). */
  readonly sql: SqlRunner = {
    run: (sql, ...params) => this.run(sql, ...params),
    get: (sql, ...params) => this.get(sql, ...params),
    all: (sql, ...params) => this.all(sql, ...params),
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
      id: brandId<'LearnerId'>(str(row, 'id')), displayName: str(row, 'display_name'), settings: json(row, 'settings_json') as JsonObject, createdAt: str(row, 'created_at'),
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

  /** Bind a host session to a learner. */
  bindSession(sessionId: string, learnerId: LearnerId, at: string): void {
    this.run(`INSERT INTO session_bindings (session_id, learner_id, bound_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET learner_id = excluded.learner_id, bound_at = excluded.bound_at`,
    sessionId, learnerId, at)
  }

  /** @param sessionId - host session id. @returns the binding, or undefined. */
  sessionBinding(sessionId: string): { learnerId: LearnerId } | undefined {
    const row = this.get('SELECT learner_id FROM session_bindings WHERE session_id = ?', sessionId)
    return row === undefined ? undefined : { learnerId: brandId<'LearnerId'>(str(row, 'learner_id')) }
  }

  // ---- courses ----

  /**
   * @param course - course version to insert or replace (same id and version); a replacement keeps
   *   the first origin and creation time and takes the new content and proposer.
   */
  upsertCourse(course: CourseRecord): void {
    this.run(`INSERT INTO courses (id, version, status, origin, plugin_id, title, spec_json, proposed_by, created_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, version) DO UPDATE SET status = excluded.status, title = excluded.title, spec_json = excluded.spec_json, proposed_by = excluded.proposed_by, approved_at = excluded.approved_at`,
    course.id, course.version, course.status, course.origin, course.pluginId, course.title, JSON.stringify(course.spec), course.proposedBy, course.createdAt, course.approvedAt)
  }

  private courseFromRow(row: Row): CourseRecord {
    return {
      id: str(row, 'id'), version: str(row, 'version'), status: str(row, 'status') as CourseStatus, // CHECK constraint
      origin: str(row, 'origin') as CourseRecord['origin'], // CHECK constraint
      pluginId: optStr(row, 'plugin_id'), title: str(row, 'title'), spec: json(row, 'spec_json') as CourseSpec,
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
}
