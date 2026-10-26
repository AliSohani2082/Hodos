import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CourseSpec, LessonNode } from '@hodos/plugin-sdk'
import {
  assertNoLeak,
  blockLookup,
  brandId,
  HodosStore,
  lessonChecks,
  lessonPlainText,
  MIGRATIONS,
  parseLesson,
  PluginRegistry,
  presentExercise,
  projectLessonForStudent,
  SandboxRunner,
  scanForLeaks,
  secretFragments,
  stampBlockIds,
  validateCourse,
} from '../src/index.js'
import { createQuizPlugin, quizCourse } from '@hodos/testing'

const sandbox = new SandboxRunner()
const registry = new PluginRegistry({ sandbox, logger: { info: () => {}, warn: () => {}, error: () => {} } })
beforeAll(async () => { await registry.register(createQuizPlugin(), { trusted: true }) })
afterAll(() => sandbox.dispose())

function codes(source: string): string[] {
  return parseLesson(source, blockLookup(registry), 'l1').diagnostics.map(d => d.code)
}

function find(node: LessonNode, type: string): LessonNode | undefined {
  if (node.type === type) return node
  for (const c of node.children ?? []) {
    const hit = find(c, type)
    if (hit !== undefined) return hit
  }
  return undefined
}

describe('lesson IR', () => {
  const lesson = quizCourse().lessons[0]?.source ?? ''

  it('parses core and plugin blocks into a neutral tree', () => {
    const parsed = parseLesson(lesson, blockLookup(registry), 'lesson-add')
    expect(parsed.diagnostics.filter(d => d.severity === 'error')).toEqual([])
    const tree = parsed.tree
    if (tree === null) throw new Error('tree')
    expect(find(tree, 'callout')?.attributes.kind).toBe('tip')
    expect(find(tree, 'quiz-note')?.attributes.text).toBe('Numbers are fun.')
    expect(lessonChecks(tree)).toHaveLength(1)
  })

  it('rejects variables and functions (lessons are data)', () => {
    expect(codes('Hello {% $secret %}')).toContain('lesson/no-variables')
    expect(codes('{% callout title=$name %}\nx\n{% /callout %}')).toContain('lesson/no-variables')
    expect(codes('{% callout title=upper("x") %}\nx\n{% /callout %}')).toContain('lesson/no-variables')
  })

  it('rejects unsafe links, images and unknown blocks; keeps raw HTML inert', () => {
    expect(codes('[files](ftp://example.org/x)')).toContain('lesson/unsafe-link')
    expect(codes('[relative](../../etc/passwd)')).toContain('lesson/unsafe-link')
    // Markdown itself refuses javascript: links; the text stays inert.
    const js = parseLesson('[click](javascript:alert(1))', blockLookup(registry), 'l1').tree
    expect(js === null ? 'rejected' : JSON.stringify(js)).not.toContain('"type":"link"')
    expect(codes('[ok](https://example.org) and [mail](mailto:a@b.c)')).toEqual([])
    expect(codes('![x](https://example.org/x.png)')).toContain('lesson/no-images')
    expect(codes('{% iframe src="https://evil" /%}')).toContain('lesson/unknown-block')
    const parsed = parseLesson('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', blockLookup(registry), 'l1')
    const tree = parsed.tree
    if (tree === null) throw new Error('raw HTML should parse as text')
    const text = lessonPlainText(tree, blockLookup(registry))
    expect(text).toContain('<script>alert(1)</script>')
    expect(JSON.stringify(tree)).not.toMatch(/"type":"(html|script|img)/)
  })

  it('validates block attributes and duplicate ids', () => {
    expect(codes('{% check question="Q?" answer="a" /%}')).toContain('lesson/check-attributes')
    expect(codes('{% quiz-note id="dup" text="a" /%}\n\n{% quiz-note id="dup" text="b" /%}')).toContain('lesson/duplicate-id')
  })

  it('stamps stable block ids once', () => {
    const once = stampBlockIds(lesson, 'lesson-add')
    expect(stampBlockIds(lesson, 'lesson-add')).toBe(once)
    expect(stampBlockIds(once, 'lesson-add')).toBe(once)
    const ids = [...once.matchAll(/id="([^"]+)"/g)].map(m => m[1])
    expect(ids).toHaveLength(3)
    // Editing prose elsewhere keeps the stamped ids.
    const edited = once.replace('Read this short introduction.', 'Read this rewritten introduction.')
    expect([...stampBlockIds(edited, 'lesson-add').matchAll(/id="([^"]+)"/g)].map(m => m[1])).toEqual(ids)
  })

  it('projects lessons for the learner without answers, explanations or server fields', () => {
    const tree = parseLesson(lesson, blockLookup(registry), 'lesson-add').tree
    if (tree === null) throw new Error('tree')
    const projected = projectLessonForStudent(tree, blockLookup(registry))
    const check = find(projected, 'check')
    expect(check?.attributes.answer).toBeUndefined()
    expect(check?.attributes.explain).toBeUndefined()
    expect(check?.attributes.options).toHaveLength(2)
    expect(find(projected, 'quiz-note')?.attributes.secret).toBeUndefined()
    expect(JSON.stringify(projected)).not.toContain('server-only-note')
    const text = lessonPlainText(projected, blockLookup(registry))
    expect(text).toContain('Check: Is 2 + 2 equal to 4?')
    expect(text).toContain('Note: Numbers are fun.')
    expect(text).not.toContain('because that is the rule')
  })
})

describe('course validation', () => {
  const errors = async (course: CourseSpec, requireCoverage = false): Promise<string[]> =>
    (await validateCourse(course, registry, { requireCoverage })).filter(d => d.severity === 'error').map(d => d.code)

  it('accepts the fixture course', async () => {
    expect(await errors(quizCourse(), true)).toEqual([])
  })

  it('rejects malformed structure before anything else', async () => {
    const broken = { ...quizCourse(), items: 'nope', skills: [{ id: 'x' }] } as unknown as CourseSpec
    const found = await errors(broken)
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(c => c === 'course/shape')).toBe(true)
  })

  it('reports cycles, unknown references, missing environments and bad keys', async () => {
    const base = quizCourse()
    const cyclic: CourseSpec = { ...base, skills: base.skills.map(s => (s.id === 'quiz.add' ? { ...s, requires: ['quiz.mixed'] } : s)) }
    expect((await errors(cyclic)).some(c => c.startsWith('graph/'))).toBe(true)
    expect(await errors({ ...base, environments: ['missing.env'] })).toContain('course/missing-environment')
    const badKey: CourseSpec = { ...base, items: base.items.map(i => (i.id === 'add-p1' ? { ...i, key: { correct: 'z' } } : i)) }
    expect(await errors(badKey)).toContain('quiz/key')
    const unknownSkill: CourseSpec = { ...base, items: [...base.items, { ...base.items[0]!, id: 'stray', skills: [{ skillId: 'nope.nope', weight: 1 }] }] }
    expect(await errors(unknownSkill)).toContain('course/item-skill')
  })

  it('enforces coverage when required and warns otherwise', async () => {
    const base = quizCourse()
    const thin: CourseSpec = { ...base, items: base.items.filter(i => !(i.skills[0]?.skillId === 'quiz.mul' && i.modes.includes('checkpoint'))) }
    expect(await errors(thin, true)).toContain('course/coverage-checkpoint')
    const findings = await validateCourse(thin, registry, { requireCoverage: false })
    expect(findings.find(d => d.code === 'course/coverage-checkpoint')?.severity).toBe('warning')
  })
})

describe('store', () => {
  const learner = (store: HodosStore, id: string): void => store.insertLearner({ id: brandId<'LearnerId'>(id), displayName: id, settings: {}, createdAt: '2026-10-26T00:00:00.000Z' })

  it('migrates a new database and records the schema version', () => {
    const store = new HodosStore(':memory:')
    expect(store.schemaVersion).toBe(MIGRATIONS.at(-1)?.version)
    store.close()
  })

  it('rolls back a failed transaction and joins nested ones', () => {
    const store = new HodosStore(':memory:')
    expect(() => store.transaction(() => {
      learner(store, 'lrn_a')
      store.transaction(() => learner(store, 'lrn_b'))
      throw new Error('abort')
    })).toThrow('abort')
    expect(store.learner('lrn_a')).toBeUndefined()
    expect(store.learner('lrn_b')).toBeUndefined()
    store.transaction(() => learner(store, 'lrn_c'))
    expect(store.learner('lrn_c')?.displayName).toBe('lrn_c')
    store.close()
  })

  it('enforces foreign keys', () => {
    const store = new HodosStore(':memory:')
    expect(() => store.bindPrincipal('owner', brandId<'LearnerId'>('lrn_missing'))).toThrow()
    store.close()
  })

  it('persists across restarts in WAL mode and refuses to downgrade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hodos-store-'))
    const path = join(dir, 'hodos.db')
    const first = new HodosStore(path)
    learner(first, 'lrn_persist')
    first.bindPrincipal('owner', brandId<'LearnerId'>('lrn_persist'))
    first.close()
    expect(existsSync(path)).toBe(true)
    const second = new HodosStore(path)
    expect(second.learnerForPrincipal('owner')).toBe('lrn_persist')
    second.close()
    const newer = new HodosStore(path, [...MIGRATIONS, { version: 99, name: 'future', sql: 'CREATE TABLE future_table (x INTEGER)' }])
    newer.close()
    expect(() => new HodosStore(path)).toThrow(/newer than this Hodos/)
  })

  it('never lets a self-report overwrite a diagnostic prior', () => {
    const store = new HodosStore(':memory:')
    learner(store, 'lrn_p')
    store.savePrior('lrn_p', { skillId: 's1', prior: 0.8, source: 'diagnostic', diagnosedKnown: true }, 't')
    store.savePrior('lrn_p', { skillId: 's1', prior: 0.05, source: 'self-report', diagnosedKnown: false }, 't')
    expect(store.priors('lrn_p').get('s1')).toMatchObject({ prior: 0.8, source: 'diagnostic', diagnosedKnown: true })
    store.close()
  })
})

describe('student-view projection and leak guard', () => {
  const course = quizCourse()
  const choice = course.items.find(i => i.id === 'add-p1')!
  const text = course.items.find(i => i.id === 'add-t1')!

  it('removes server-only payload fields and the key', () => {
    const kind = registry.kind(choice.kind)
    const exercise = presentExercise({ presentationId: 'prs_1', item: choice, kind, mode: 'practice', attempt: 1, hintsAvailable: 5 })
    const json = JSON.stringify(exercise)
    expect(json).not.toContain('internal-note-add-p1')
    expect(json).not.toContain('"key"')
    expect(json).not.toContain('Hint one')
    expect(exercise.payload).toMatchObject({ prompt: 'What is 2 + 2?' })
  })

  it('collects key, explanation, unreleased hints and server fields as secrets', () => {
    const secrets = secretFragments(text, registry.kind(text.kind), { hintLevel: 0, answer: false })
    expect(secrets).toEqual(expect.arrayContaining(['Text explanation for add-t1.', 'Text hint for add-t1.']))
    const released = secretFragments(text, registry.kind(text.kind), { hintLevel: 1, answer: true })
    expect(released).toEqual([])
    const choiceSecrets = secretFragments(choice, registry.kind(choice.kind), { hintLevel: 2, answer: false })
    expect(choiceSecrets).toContain('internal-note-add-p1')
    expect(choiceSecrets).toContain('Hint three for add-p1: try a smaller example first.')
    expect(choiceSecrets).not.toContain('Hint one for add-p1: what does the operation mean?')
  })

  it('treats what the learner already sees as visible', () => {
    const steps = course.items.find(i => i.id === 'mixed-s1')!
    const before = secretFragments(steps, registry.kind(steps.kind), { hintLevel: 0, answer: false })
    expect(before).toContain('multiply')
    const after = secretFragments(steps, registry.kind(steps.kind), { hintLevel: 0, answer: false }, [{ entered: ['multiply'] }])
    expect(after).not.toContain('multiply')
    expect(after).toContain('fourteen')
  })

  it('detects canaries raw, JSON-escaped and case-folded, without false positives in ids', () => {
    const canary = 'CANARY "quoted" answer'
    expect(scanForLeaks({ feedback: `here: ${canary}` }, [canary])).toEqual([canary])
    expect(scanForLeaks({ nested: { deep: [`canary "QUOTED" answer`] } }, [canary])).toEqual([canary])
    expect(scanForLeaks({ id: 'prs_ab1024cd', at: '2026-10-24T10:24:00Z' }, ['1024'])).toEqual([])
    expect(scanForLeaks({ feedback: 'The answer is 1024.' }, ['1024'])).toEqual(['1024'])
    expect(scanForLeaks('Nf3+ wins', ['Nf3+'])).toEqual(['Nf3+'])
  })

  it('blocks a leak without echoing the secret', () => {
    let message = ''
    try {
      assertNoLeak({ text: 'the answer is Madrid' }, ['Madrid'], 'test path')
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).toBe('blocked an answer-key leak on test path')
  })
})
