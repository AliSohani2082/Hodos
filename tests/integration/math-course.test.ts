/**
 * Integration: the algebra courses on the Hodos engine — full-coverage
 * validation, and a practice step with misconception feedback.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createMathPlugin, expressionsCourse, linesCourse, SKILL } from '@hodos/math'
import { HodosEngine, HodosStore, PluginRegistry, SandboxRunner, validateCourse, type Actor } from '@hodos/core'
import { jsonObject, jsonString } from '../support/json.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function registry(): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(createMathPlugin(), { trusted: true })
  return r
}

describe('algebra courses on the Hodos engine', () => {
  it('validate with full coverage, lessons included', async () => {
    const r = await registry()
    for (const course of [expressionsCourse(), linesCourse()]) {
      expect((await validateCourse(course, r, { requireCoverage: true })).filter(f => f.severity === 'error'), course.id).toEqual([])
    }
  })

  it('finds the course for a goal and explains a misconception in practice', async () => {
    const engine = new HodosEngine({ store: new HodosStore(':memory:'), registry: await registry() })
    expect(await engine.syncContentPacks()).toEqual([])
    const learnerId = engine.learnerForPrincipal('owner')
    const ui: Actor = { learnerId, channel: 'ui', sessionId: 's1' }
    const started = engine.startJourney({ ...ui, channel: 'agent' }, { goal: 'I want to practise expanding brackets and factoring', skipDiagnostic: true })
    expect(started.course.id).toBe('algebra-expressions')
    expect(started.path.map(s => s.id)).toEqual([SKILL.simplify, SKILL.expand, SKILL.factor])
    engine.approvePath(ui)
    const lesson = engine.lesson(ui)
    expect(Object.values(lesson.lessons[0]?.blocks ?? {})[0]).toMatchObject({ type: 'math-formula', renderer: { pluginId: 'hodos-math', rendererId: 'math-view' } })
    for (const l of lesson.lessons) for (const c of l.checks) engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    engine.completeLesson(ui)
    // A simplify item: answer it unsimplified first.
    const exercise = engine.nextExercise(ui)
    expect(exercise?.renderer).toMatchObject({ rendererId: 'math-view' })
    const formula = jsonString(jsonObject(exercise?.payload, 'the exercise payload').formula, 'the formula')
    const attempt = await engine.submitAttempt(ui, { presentationId: exercise?.id ?? '', response: { text: formula } })
    expect(attempt.status).toBe('partial')
    expect(attempt.misconceptionFeedback?.[0]).toContain('combine like terms')
  })
})
