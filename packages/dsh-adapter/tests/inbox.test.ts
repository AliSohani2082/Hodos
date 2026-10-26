/**
 * The course inbox with a real engine and store: files become drafts (with
 * provenance set by Hodos), bad files are rejected with a report, and the
 * inbox never follows links or reads oversized files.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HodosEngine, HodosStore, PluginRegistry, SandboxRunner, type Actor } from '@hodos/core'
import { createQuizPlugin, quizCourse } from '@hodos/testing'
import { CourseInbox, MAX_INBOX_FILE_BYTES } from '../src/inbox.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function setup(): Promise<{ engine: HodosEngine; store: HodosStore; inbox: CourseInbox; dir: string; actor: Actor }> {
  const registry = new PluginRegistry({ sandbox, logger: silent })
  await registry.register(createQuizPlugin(), { trusted: true })
  const store = new HodosStore(':memory:')
  const engine = new HodosEngine({ store, registry })
  const actor: Actor = { learnerId: engine.learnerForPrincipal('owner'), channel: 'ui' }
  const dir = join(mkdtempSync(join(tmpdir(), 'hodos-inbox-')), 'inbox')
  const inbox = new CourseInbox({ dir, propose: (proposal, source) => engine.proposeCourse(actor, proposal, { origin: 'import', source }), logger: silent })
  await inbox.prepare()
  return { engine, store, inbox, dir, actor }
}

const draftCourse = (version: string): object => ({
  ...quizCourse(), id: 'quiz.inbox', version, title: 'Inbox quiz',
  items: quizCourse().items.map(i => ({ ...i, provenance: { source: 'authored', verifiedBy: ['human', 'stockfish'] } })),
})

describe('course inbox', () => {
  it('imports a course file as a draft and moves it to imported/', async () => {
    const { engine, inbox, dir } = await setup()
    writeFileSync(join(dir, 'quiz.inbox@0.1.0-1.json'), JSON.stringify(draftCourse('0.1.0')))
    const [outcome] = await inbox.scan()
    expect(outcome).toMatchObject({ file: 'quiz.inbox@0.1.0-1.json', status: 'imported', courseId: 'quiz.inbox', version: '0.1.0' })
    expect(readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([])
    expect(readdirSync(join(dir, 'imported'))).toHaveLength(1)
    const [draft] = engine.drafts()
    expect(draft).toMatchObject({ id: 'quiz.inbox', origin: 'import', proposedBy: 'inbox:quiz.inbox@0.1.0-1.json' })
  })

  it('replaces provenance claims, and the learner still decides', async () => {
    const { engine, store, inbox, dir, actor } = await setup()
    writeFileSync(join(dir, 'a.json'), JSON.stringify(draftCourse('0.1.0')))
    await inbox.scan()
    const stored = store.course('quiz.inbox', '0.1.0')
    expect(stored).toMatchObject({ status: 'draft', origin: 'import' })
    expect(stored?.spec.items.length).toBeGreaterThan(0)
    for (const item of stored?.spec.items ?? []) expect(item.provenance).toEqual({ source: 'imported' })
    await expect(engine.decideCourse({ ...actor, channel: 'agent' }, { courseId: 'quiz.inbox', version: '0.1.0', approve: true })).rejects.toThrow(/only the learner/)
    await engine.decideCourse(actor, { courseId: 'quiz.inbox', version: '0.1.0', approve: true })
    expect(store.course('quiz.inbox', '0.1.0')?.status).toBe('approved')
  })

  it('rejects invalid JSON and invalid courses with a report next to the file', async () => {
    const { engine, inbox, dir } = await setup()
    writeFileSync(join(dir, 'broken.json'), '{ "id": ')
    const bad = { ...draftCourse('0.1.0'), goal: 'quiz.nowhere' }
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify(bad))
    const outcomes = await inbox.scan()
    expect(outcomes.map(o => [o.file, o.status])).toEqual([['broken.json', 'rejected'], ['invalid.json', 'rejected']])
    expect(outcomes[1]?.errors.join('\n')).toContain('course/goal')
    const rejected = readdirSync(join(dir, 'rejected'))
    expect(rejected.filter(n => n.endsWith('.json'))).toHaveLength(2)
    const report = readFileSync(join(dir, 'rejected', rejected.find(n => n.endsWith('invalid.json.errors.txt')) ?? ''), 'utf8')
    expect(report).toContain('course/goal')
    expect(engine.drafts()).toEqual([])
  })

  it('does not follow symbolic links, skips partial and foreign files, and caps the size', async () => {
    const { inbox, dir } = await setup()
    const outside = join(dir, '..', 'outside.json')
    writeFileSync(outside, JSON.stringify(draftCourse('0.2.0')))
    symlinkSync(outside, join(dir, 'link.json'))
    writeFileSync(join(dir, 'writing.json.tmp'), JSON.stringify(draftCourse('0.3.0')))
    writeFileSync(join(dir, 'notes.txt'), 'not a course')
    writeFileSync(join(dir, 'huge.json'), `{"pad":"${'x'.repeat(MAX_INBOX_FILE_BYTES)}"}`)
    const outcomes = await inbox.scan()
    expect(outcomes.map(o => [o.file, o.status])).toEqual([['huge.json', 'rejected'], ['link.json', 'rejected']])
    expect(outcomes[0]?.errors[0]).toContain('larger than')
    // The link's target is untouched; the partial file and the text file wait where they are.
    expect(readFileSync(outside, 'utf8')).toContain('"0.2.0"')
    expect(existsSync(join(dir, 'writing.json.tmp'))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
  })

  it('does not charge the model-proposal budget for imports', async () => {
    const { engine, inbox, dir } = await setup()
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `c${String(i).padStart(2, '0')}.json`), JSON.stringify(draftCourse(`0.${i}.0`)))
    const outcomes = [...await inbox.scan(), ...await inbox.scan(), ...await inbox.scan()]
    expect(outcomes).toHaveLength(25)
    expect(outcomes.every(o => o.status === 'imported')).toBe(true)
    expect(engine.drafts()).toHaveLength(25)
  })
})
