/**
 * The course inbox: course files placed in `<dataDir>/inbox` — normally by
 * `hodos course submit`, for example after writing a course with Claude
 * Code — are validated by the engine and stored as drafts that wait for the
 * learner's approval in the workspace. Nothing in a file is executed: it is
 * parsed as JSON and goes through the same validation as any proposal.
 * Processed files move to `imported/` or `rejected/`; a rejected file gets a
 * `.errors.txt` report next to it.
 * @module @hodos/dsh/inbox
 */
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Inbox directory name inside the Hodos data directory. */
export const INBOX_DIR = 'inbox'

/** Largest course file the inbox reads. */
export const MAX_INBOX_FILE_BYTES = 2 * 1024 * 1024

/** Files handled per scan; the rest wait for the next one. */
export const MAX_FILES_PER_SCAN = 10

/** Names the inbox picks up: plain `.json` files (`.tmp` files being written are skipped). */
export const INBOX_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,150}\.json$/

/** What happened to one inbox file. */
export interface InboxOutcome {
  readonly file: string
  readonly status: 'imported' | 'rejected'
  readonly courseId?: string
  readonly version?: string
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

/** What the inbox needs from its host. */
export interface InboxDeps {
  /** The inbox directory. */
  readonly dir: string
  /** Validate and store a proposal as a draft (the engine's `proposeCourse` with origin `import`). */
  propose(proposal: unknown, source: string): Promise<{ stored: boolean; courseId: string; version: string; errors: string[]; warnings: string[] }>
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly now?: () => Date
}

/** Read one file without following a symbolic link, within the size cap. */
async function readRegularFile(path: string): Promise<{ text: string } | { problem: string }> {
  let handle
  try {
    // O_NOFOLLOW: a symbolic link fails here instead of being followed (where the platform supports it).
    handle = await open(path, constants.O_RDONLY | ('O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0))
  } catch (_unreadable) {
    return { problem: 'the file cannot be opened (symbolic links are not followed)' }
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { problem: 'not a regular file' }
    if (info.size > MAX_INBOX_FILE_BYTES) return { problem: `larger than ${MAX_INBOX_FILE_BYTES} bytes` }
    return { text: await handle.readFile('utf8') }
  } finally {
    await handle.close()
  }
}

/** The course inbox of one Hodos data directory. */
export class CourseInbox {
  private scanning = false

  /** @param deps - directory, proposal function and logger. */
  constructor(private readonly deps: InboxDeps) {}

  /** Create the inbox directories (owner-only). */
  async prepare(): Promise<void> {
    for (const sub of ['imported', 'rejected']) await mkdir(join(this.deps.dir, sub), { recursive: true, mode: 0o700 })
  }

  /**
   * Import the waiting files once. Concurrent calls return immediately.
   * @returns what happened to each file handled.
   */
  async scan(): Promise<InboxOutcome[]> {
    if (this.scanning) return []
    this.scanning = true
    try {
      const names = (await readdir(this.deps.dir).catch(() => [] as string[])).filter(n => INBOX_FILE_NAME.test(n)).sort().slice(0, MAX_FILES_PER_SCAN)
      const outcomes: InboxOutcome[] = []
      for (const name of names) outcomes.push(await this.importFile(name))
      return outcomes
    } finally {
      this.scanning = false
    }
  }

  private stamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
  }

  private async importFile(name: string): Promise<InboxOutcome> {
    const path = join(this.deps.dir, name)
    const read = await readRegularFile(path)
    if ('problem' in read) return this.reject(name, [read.problem], [])
    let proposal: unknown
    try {
      proposal = JSON.parse(read.text)
    } catch (_invalid) {
      return this.reject(name, ['the file is not valid JSON'], [])
    }
    let result: Awaited<ReturnType<InboxDeps['propose']>>
    try {
      result = await this.deps.propose(proposal, `inbox:${name}`)
    } catch (error) {
      return this.reject(name, [error instanceof Error ? error.message : 'the course could not be imported'], [])
    }
    if (!result.stored) return this.reject(name, result.errors, result.warnings, result.courseId, result.version)
    await rename(path, join(this.deps.dir, 'imported', `${this.stamp()}-${name}`))
    this.deps.logger.info(`course inbox: ${name} is now draft ${result.courseId}@${result.version}, waiting for approval`)
    return { file: name, status: 'imported', courseId: result.courseId, version: result.version, errors: [], warnings: result.warnings }
  }

  private async reject(name: string, errors: readonly string[], warnings: readonly string[], courseId?: string, version?: string): Promise<InboxOutcome> {
    const target = join(this.deps.dir, 'rejected', `${this.stamp()}-${name}`)
    const report = [
      `${name} was not imported.`,
      '',
      'Errors:',
      ...errors.map(e => `- ${e}`),
      ...(warnings.length === 0 ? [] : ['', 'Warnings:', ...warnings.map(w => `- ${w}`)]),
      '',
    ].join('\n')
    try {
      await rename(join(this.deps.dir, name), target)
    } catch (_gone) {
      // A file that cannot be moved (for example a link that was not followed) is removed instead.
      await unlink(join(this.deps.dir, name)).catch(() => undefined)
    }
    await writeFile(`${target}.errors.txt`, report, { mode: 0o600 })
    this.deps.logger.warn(`course inbox: ${name} was rejected (${errors.length} error(s))`)
    return {
      file: name, status: 'rejected', errors, warnings,
      ...(courseId === undefined || courseId === '' ? {} : { courseId }),
      ...(version === undefined || version === '' ? {} : { version }),
    }
  }
}
