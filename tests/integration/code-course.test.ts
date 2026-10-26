/**
 * Integration: the Python tracing course on the Hodos engine — full-coverage
 * validation, a lesson with code snippets, misconception feedback through
 * the leak guard, and code-writing exercises appearing only with a runner.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createCodePlugin, KIND, SKILL, tracingCourse, type CodeRunner } from '@hodos/code'
import { HodosEngine, HodosStore, PluginRegistry, SandboxRunner, validateCourse, type Actor } from '@hodos/core'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function registry(runner?: CodeRunner): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(createCodePlugin(runner === undefined ? {} : { runner }), { trusted: true })
  return r
}

describe('Python tracing course on the Hodos engine', () => {
  it('validates with full coverage, lessons included', async () => {
    expect((await validateCourse(tracingCourse(), await registry(), { requireCoverage: true })).filter(f => f.severity === 'error')).toEqual([])
  })

  it('teaches with code snippets and explains a misreading in practice', async () => {
    const engine = new HodosEngine({ store: new HodosStore(':memory:'), registry: await registry() })
    expect(await engine.syncContentPacks()).toEqual([])
    const learnerId = engine.learnerForPrincipal('owner')
    const ui: Actor = { learnerId, channel: 'ui', sessionId: 's1' }
    const started = engine.startJourney({ ...ui, channel: 'agent' }, { goal: 'I want to learn to read Python code', skipDiagnostic: true })
    expect(started.course.id).toBe('python-tracing')
    expect(started.path.map(s => s.id)).toEqual(Object.values(SKILL))
    engine.approvePath(ui)
    const lesson = engine.lesson(ui)
    expect(Object.values(lesson.lessons[0]?.blocks ?? {})[0]).toMatchObject({ type: 'code-snippet', renderer: { pluginId: 'hodos-code', rendererId: 'code-view' } })
    for (const l of lesson.lessons) for (const c of l.checks) engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    engine.completeLesson(ui)
    const exercise = engine.nextExercise(ui)
    expect(exercise).toMatchObject({ kind: KIND.predict, responseKind: 'lines', renderer: { rendererId: 'code-view' } })
    expect(exercise?.fallbackText).toContain('1 | print(')
    // Every expressions item has an integer-division misreading; answer with it.
    const item = tracingCourse().items.find(i => i.id === exercise?.itemId)
    const key = item?.key
    const listed = typeof key === 'object' && key !== null && !Array.isArray(key) && Array.isArray(key.misconceptions) ? key.misconceptions : []
    const wrong = listed.flatMap(m => (typeof m === 'object' && m !== null && !Array.isArray(m) && typeof m.output === 'string' && typeof m.id === 'string' ? [{ output: m.output, id: m.id }] : []))[0]
    expect(wrong).toBeDefined()
    const attempt = await engine.submitAttempt(ui, { presentationId: exercise?.id ?? '', response: { text: wrong?.output ?? '' } })
    expect(attempt.status).toBe('incorrect')
    expect(attempt.misconceptionFeedback?.length).toBe(1)
    expect(JSON.stringify(attempt)).not.toContain(item?.explanation ?? '<none>')
  })

  it('offers code-writing exercises only when the host supplies a runner', async () => {
    expect((await registry()).graderInfo(KIND.write)).toBeUndefined()
    const runner: CodeRunner = { isolation: 'test table (executes nothing)', languages: ['python'], run: r => Promise.resolve(r.inputs.map(() => ({ status: 'ok' as const, stdout: '6\n', stderr: '' }))) }
    const withRunner = await registry(runner)
    expect(withRunner.graderInfo(KIND.write)).toEqual({ id: 'code.runner-grader', method: 'oracle', trusted: true })
    const grade = await withRunner.grade({
      kind: KIND.write, mode: 'practice', attempt: 1, skills: [{ skillId: SKILL.functions, weight: 1 }],
      payload: { prompt: 'Print 6.', language: 'python' }, key: { tests: [{ input: '', output: '6' }] }, response: { code: 'print(6)' },
    })
    expect(grade).toMatchObject({ correct: true, score: 1 })
  })
})
