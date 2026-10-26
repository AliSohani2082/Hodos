/**
 * Course authoring outside Hodos (for example with Claude Code): the
 * `hodos course` CLI prints the guide, validates and submits a course file,
 * and the host's inbox turns it into a draft awaiting the learner's approval.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createChessPlugin, tacticsCourse } from '@hodos/chess'
import { HodosEngine, HodosStore, PluginRegistry, SandboxRunner, type Actor } from '@hodos/core'
import { main, resolveDataDir, type CliIo } from '../../packages/dsh-adapter/src/cli.js'
import { CourseInbox, INBOX_DIR } from '../../packages/dsh-adapter/src/inbox.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

interface Run { readonly code: number; readonly out: string; readonly err: string }

async function hodos(args: readonly string[], env: Record<string, string> = {}): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = {
    out: t => { out.push(t) }, err: t => { err.push(t) }, env, cwd: process.cwd(),
    environments: () => Promise.resolve([createChessPlugin()]),
  }
  const code = await main(args, io)
  return { code, out: out.join('\n'), err: err.join('\n') }
}

function courseFile(patch: (course: ReturnType<typeof tacticsCourse>) => object = c => c): string {
  const base = { ...tacticsCourse(), id: 'chess.authored', version: '0.1.0', title: 'Authored tactics' }
  const file = join(mkdtempSync(join(tmpdir(), 'hodos-course-')), 'course.json')
  writeFileSync(file, JSON.stringify(patch(base)))
  return file
}

describe('hodos course CLI', () => {
  it('prints the authoring guide from the installed environments', async () => {
    const full = await hodos(['course', 'guide'])
    expect(full.code).toBe(0)
    expect(full.out).toContain('#### `chess.puzzle`: Chess puzzle')
    expect(full.out).toContain('Payload schema:')
    expect(full.out).toContain('`chess-position` (from hodos-chess)')
    const short = await hodos(['course', 'guide', '--no-schemas'])
    expect(short.out).not.toContain('Payload schema:')
  })

  it('validates a course and reports coded errors with targets', async () => {
    const ok = await hodos(['course', 'validate', courseFile()])
    expect(ok.code).toBe(0)
    expect(ok.out).toContain('chess.authored@0.1.0: 0 error(s)')
    const broken = await hodos(['course', 'validate', courseFile(c => ({
      ...c,
      items: c.items.map(i => (i.id === 'fork-corner-f7' ? { ...i, key: { line: ['Qh8'], theme: 'fork' } } : i)),
    }))])
    expect(broken.code).toBe(1)
    expect(broken.err).toContain('error: chess/illegal-line')
    expect(broken.err).toContain('[fork-corner-f7]')
    const notACourse = await hodos(['course', 'validate', courseFile(() => ({ hello: 'world' }))])
    expect(notACourse.code).toBe(1)
    expect(notACourse.err).toContain('does not have the shape of a course')
  })

  it('submits through the inbox into a draft the learner approves', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hodos-data-'))
    const submitted = await hodos(['course', 'submit', courseFile(), '--data-dir', dataDir])
    expect(submitted.code).toBe(0)
    const inboxDir = join(dataDir, INBOX_DIR)
    const waiting = readdirSync(inboxDir).filter(n => n.endsWith('.json'))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatch(/^chess\.authored@0\.1\.0-\d+\.json$/)
    expect((await hodos(['course', 'status', '--data-dir', dataDir])).out).toContain(`Waiting (imported while DeepSeek Harness runs with Hodos): ${waiting[0] ?? ''}`)

    // The host side: the running Hodos service scans the inbox.
    const registry = new PluginRegistry({ sandbox, logger: silent })
    await registry.register(createChessPlugin(), { trusted: true })
    const engine = new HodosEngine({ store: new HodosStore(':memory:'), registry })
    const actor: Actor = { learnerId: engine.learnerForPrincipal('owner'), channel: 'ui' }
    const inbox = new CourseInbox({ dir: inboxDir, propose: (p, source) => engine.proposeCourse(actor, p, { origin: 'import', source }), logger: silent })
    await inbox.prepare()
    expect((await inbox.scan()).map(o => o.status)).toEqual(['imported'])
    const drafts = engine.drafts()
    expect(drafts).toMatchObject([{ id: 'chess.authored', origin: 'import' }])
    expect(drafts[0]?.skills.map(s => s.id)).toEqual(tacticsCourse().skills.map(s => s.id))
    expect((await hodos(['course', 'status', '--data-dir', dataDir])).out).toContain('Imported as drafts')
    await engine.decideCourse(actor, { courseId: 'chess.authored', version: '0.1.0', approve: true })
    expect(engine.drafts()).toEqual([])
  })

  it('refuses to submit a course with errors', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hodos-data-'))
    const run = await hodos(['course', 'submit', courseFile(c => ({ ...c, goal: 'chess.nowhere' })), '--data-dir', dataDir])
    expect(run.code).toBe(1)
    expect(run.err).toContain('course/goal')
    expect(readdirSync(join(dataDir)).length).toBe(0)
  })

  it('finds the data directory like the DSH bundle does', () => {
    expect(resolveDataDir('/x/data', { HODOS_DATA_DIR: '/y' }, '/cwd')).toBe('/x/data')
    expect(resolveDataDir(undefined, { HODOS_DATA_DIR: '/y', DSH_HOME: '/z' }, '/cwd')).toBe('/y')
    expect(resolveDataDir(undefined, { DSH_HOME: '/z' }, '/cwd')).toBe('/z/hodos')
    expect(resolveDataDir(undefined, { DSH_HOME: '  ' }, '/cwd')).toBe(join(homedir(), '.dsh', 'hodos'))
    expect(resolveDataDir('rel', {}, '/cwd')).toBe('/cwd/rel')
  })

  it('explains its usage', async () => {
    expect((await hodos([])).code).toBe(2)
    expect((await hodos(['course', 'validate'])).err).toContain('needs a FILE')
    expect((await hodos(['--help'])).code).toBe(0)
  })
})
