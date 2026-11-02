import { afterAll, describe, expect, it } from 'vitest'
import {
  CourseLibrary,
  HodosStore,
  manualClock,
  PluginRegistry,
  SandboxRunner,
  sequentialIds,
  type Actor,
} from '../src/index.js'
import { CORE_PLUGIN_API_VERSION, SDK_VERSION } from '@hodos/plugin-sdk'
import { createQuizPlugin, quizCourse } from '@hodos/testing'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => {}, warn: () => {}, error: () => {} }

interface Env {
  readonly store: HodosStore
  readonly registry: PluginRegistry
  readonly courses: CourseLibrary
  readonly ui: Actor
  readonly agent: Actor
}

async function setup(options: { plugin?: boolean } = {}): Promise<Env> {
  const store = new HodosStore(':memory:')
  const registry = new PluginRegistry({ sandbox, logger: silent })
  if (options.plugin !== false) await registry.register(createQuizPlugin(), { trusted: true })
  const courses = new CourseLibrary({ store, registry, clock: manualClock(new Date('2026-10-27T09:00:00.000Z')), ids: sequentialIds() })
  expect(await courses.syncContentPacks()).toEqual([])
  const learnerId = courses.learnerForPrincipal('owner')
  return { store, registry, courses, ui: { learnerId, channel: 'ui', sessionId: 'sess-1' }, agent: { learnerId, channel: 'agent', sessionId: 'sess-1' } }
}

describe('course library', () => {
  it('resolves principals and host sessions to learners, creating them once', async () => {
    const env = await setup()
    expect(env.courses.learnerForPrincipal('owner')).toBe(env.ui.learnerId)
    const other = env.courses.learnerForPrincipal('someone-else')
    expect(other).not.toBe(env.ui.learnerId)
    // An unbound host session belongs to the default principal, and stays bound.
    expect(env.courses.learnerForSession('dsh-1', 'owner')).toBe(env.ui.learnerId)
    expect(env.courses.learnerForSession('dsh-1', 'someone-else')).toBe(env.ui.learnerId)
    env.store.close()
  })

  it('imports content packs as approved courses, once per version', async () => {
    const env = await setup()
    expect(env.courses.catalog()).toEqual([expect.objectContaining({ id: 'quiz-arithmetic', version: '1.0.0', available: true })])
    expect(await env.courses.syncContentPacks()).toEqual([])
    expect(env.store.courses('approved')).toHaveLength(1)
    env.store.close()
  })

  it('security: does not let a proposal from another source replace a waiting draft', async () => {
    const env = await setup()
    const imported = { ...quizCourse(), id: 'quiz-inbox', title: 'Inbox quiz' }
    expect(await env.courses.proposeCourse(env.ui, imported, { origin: 'import', source: 'inbox:quiz-inbox.json' })).toMatchObject({ stored: true })
    // The tutor proposes other content under the same id and version while the learner is reviewing the import.
    const swapped = await env.courses.proposeCourse(env.agent, { ...imported, title: 'Swapped quiz' })
    expect(swapped).toMatchObject({ stored: false })
    expect(swapped.errors.join(' ')).toMatch(/another source/)
    expect(env.courses.drafts()).toEqual([expect.objectContaining({ id: 'quiz-inbox', title: 'Inbox quiz', origin: 'import' })])
    // The same source may still revise its own draft.
    expect(await env.courses.proposeCourse(env.ui, { ...imported, title: 'Inbox quiz, revised' }, { origin: 'import', source: 'inbox:quiz-inbox-2.json' })).toMatchObject({ stored: true })
    expect(env.courses.drafts()).toEqual([expect.objectContaining({ id: 'quiz-inbox', title: 'Inbox quiz, revised', origin: 'import' })])
    env.store.close()
  })

  it('security: keeps the verification claims of trusted plugins\' packs only', async () => {
    const env = await setup()
    expect(env.store.course('quiz-arithmetic', '1.0.0')?.spec.items.some(i => (i.provenance?.verifiedBy ?? []).length > 0)).toBe(true)
    // A sandboxed plugin that ships a course claiming checks it cannot prove.
    const claimed = { ...quizCourse(), id: 'quiz-claimed', title: 'Claimed quiz', items: quizCourse().items.map(i => ({ ...i, provenance: { source: 'authored' as const, verifiedBy: ['stockfish'], author: 'someone' } })) }
    await env.registry.register({
      manifest: { id: 'third-party-pack', version: '1.0.0', displayName: 'Third-party pack', requiresCore: `^${CORE_PLUGIN_API_VERSION}`, sdkVersion: SDK_VERSION, capabilities: { contentPacks: ['claimed-pack'] } },
      register(ctx) { ctx.registerContentPack({ id: 'claimed-pack', version: '1.0.0', title: 'Claimed pack', courses: [claimed] }) },
    }, { trusted: false })
    expect(await env.courses.syncContentPacks()).toEqual([])
    const items = env.store.course('quiz-claimed', '1.0.0')?.spec.items ?? []
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(i => i.provenance?.verifiedBy === undefined && i.provenance?.source === 'authored' && i.provenance.author === 'someone')).toBe(true)
    env.store.close()
  })

  it('marks a course unavailable when its environment is not installed', async () => {
    const env = await setup({ plugin: false })
    env.store.upsertCourse({
      id: 'quiz-arithmetic', version: '1.0.0', status: 'approved', origin: 'pack', pluginId: 'hodos-quiz', title: 'Quiz arithmetic',
      spec: quizCourse(), proposedBy: null, createdAt: 't', approvedAt: 't',
    })
    expect(env.courses.catalog()).toEqual([expect.objectContaining({ id: 'quiz-arithmetic', available: false })])
    env.store.close()
  })

  it('security: keeps proposed courses as drafts, with their own provenance, until the learner approves them', async () => {
    const env = await setup()
    const malformed = await env.courses.proposeCourse(env.agent, { id: 'x', items: 'none' })
    expect(malformed.stored).toBe(false)
    expect(malformed.errors.length).toBeGreaterThan(0)
    const base = quizCourse()
    // A claim inside the proposal is not taken over.
    const proposal = { ...base, id: 'quiz-custom', title: 'Custom quiz', items: base.items.map(i => ({ ...i, provenance: { source: 'authored' as const, verifiedBy: ['someone'] } })) }
    expect(await env.courses.proposeCourse(env.agent, proposal)).toMatchObject({ stored: true, errors: [] })
    expect(env.courses.drafts()).toEqual([expect.objectContaining({ id: 'quiz-custom', origin: 'agent', proposedBy: 'agent' })])
    expect(JSON.stringify(env.courses.drafts())).not.toContain('"key"')
    expect(env.store.course('quiz-custom', '1.0.0')?.spec.items.every(i => i.provenance?.source === 'generated' && i.provenance.verifiedBy === undefined)).toBe(true)
    expect(env.courses.catalog().map(c => c.id)).not.toContain('quiz-custom')
    await expect(env.courses.decideCourse(env.agent, { courseId: 'quiz-custom', version: '1.0.0', approve: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await env.courses.decideCourse(env.ui, { courseId: 'quiz-custom', version: '1.0.0', approve: true })
    expect(env.courses.catalog().map(c => c.id)).toContain('quiz-custom')
    expect(env.courses.drafts()).toEqual([])
    // An approved version is immutable.
    expect((await env.courses.proposeCourse(env.agent, proposal)).errors).toEqual([expect.stringContaining('course/version-exists')])
    env.store.close()
  })

  it('rejects a draft for good and refuses decisions on courses that are not drafts', async () => {
    const env = await setup()
    await env.courses.proposeCourse(env.ui, { ...quizCourse(), id: 'quiz-imported' }, { origin: 'import', source: 'inbox:quiz.json' })
    expect(env.courses.drafts()).toEqual([expect.objectContaining({ id: 'quiz-imported', origin: 'import', proposedBy: 'inbox:quiz.json' })])
    await env.courses.decideCourse(env.ui, { courseId: 'quiz-imported', version: '1.0.0', approve: false })
    expect(env.courses.drafts()).toEqual([])
    expect(env.courses.catalog().map(c => c.id)).not.toContain('quiz-imported')
    await expect(env.courses.decideCourse(env.ui, { courseId: 'quiz-imported', version: '1.0.0', approve: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    env.store.close()
  })

  it('security: bounds model-written proposals and delegations per learner', async () => {
    const env = await setup()
    env.courses.chargeDelegation(env.ui.learnerId)
    env.courses.chargeDelegation(env.ui.learnerId)
    env.courses.chargeDelegation(env.ui.learnerId)
    expect(() => env.courses.chargeDelegation(env.ui.learnerId)).toThrow(/too many delegate/)
    for (let i = 0; i < 20; i++) await env.courses.proposeCourse(env.agent, { id: `x${i}` })
    await expect(env.courses.proposeCourse(env.agent, { id: 'one-more' })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    // Inbox imports are not model calls: the learner put the file there and approves it.
    expect((await env.courses.proposeCourse(env.ui, { ...quizCourse(), id: 'quiz-file' }, { origin: 'import', source: 'inbox:f.json' })).stored).toBe(true)
    env.store.close()
  })

  it('writes the authoring guide for the installed environments', async () => {
    const env = await setup()
    expect(env.courses.authoringGuide({ schemas: false })).toContain('quiz')
    env.store.close()
  })
})
