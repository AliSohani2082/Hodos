/**
 * Integration: the Spanish basics course on the Hodos engine — validation with
 * full coverage, and a vocabulary journey from the goal to spaced review on a
 * moving clock.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createLanguagePlugin, KIND, SKILL, spanishCourse } from '@hodos/language'
import { HodosEngine, HodosStore, manualClock, PluginRegistry, SandboxRunner, validateCourse, type Actor, type AttemptView, type ExerciseView } from '@hodos/core'
import type { JsonObject, JsonValue } from '@hodos/plugin-sdk'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
const course = spanishCourse()

function correct(exercise: ExerciseView): JsonValue {
  const entry = course.items.find(i => i.id === exercise.itemId)
  if (entry === undefined) throw new Error(`unknown item ${exercise.itemId}`)
  const key = entry.key as JsonObject
  const answer = entry.kind === KIND.choice ? key.correct : Array.isArray(key.accepted) ? key.accepted[0] : undefined
  if (typeof answer !== 'string') throw new Error(`item ${entry.id} has no answer in its key`)
  return entry.kind === KIND.choice ? { choice: answer } : { text: answer }
}

async function setup(): Promise<{ engine: HodosEngine; ui: Actor; agent: Actor; clock: ReturnType<typeof manualClock> }> {
  const registry = new PluginRegistry({ sandbox, logger: silent })
  await registry.register(createLanguagePlugin(), { trusted: true })
  const clock = manualClock(new Date('2026-10-26T09:00:00Z'))
  const engine = new HodosEngine({ store: new HodosStore(':memory:'), registry, clock })
  expect(await engine.syncContentPacks()).toEqual([])
  const learnerId = engine.learnerForPrincipal('owner')
  return { engine, ui: { learnerId, channel: 'ui', sessionId: 's1' }, agent: { learnerId, channel: 'agent', sessionId: 's1' }, clock }
}

describe('Spanish basics on the Hodos engine', () => {
  it('validates with full coverage', async () => {
    const registry = new PluginRegistry({ sandbox, logger: silent })
    await registry.register(createLanguagePlugin(), { trusted: true })
    const findings = await validateCourse(course, registry, { requireCoverage: true })
    expect(findings.filter(f => f.severity === 'error')).toEqual([])
  })

  it('takes a learner from "I want to learn Spanish" to a mastered skill and spaced review', async () => {
    const { engine, ui, agent, clock } = await setup()
    const started = engine.startJourney(agent, { goal: 'I want to learn Spanish', skipDiagnostic: true })
    expect(started.course.id).toBe('spanish-basics')
    expect(started.path[0]?.id).toBe(SKILL.greetings)
    engine.approvePath(ui)

    // Lesson: phrases, then the check question.
    const lesson = engine.lesson(ui)
    expect(lesson.lessons[0]?.title).toBe('Greetings and courtesy')
    for (const l of lesson.lessons) for (const c of l.checks) engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    engine.completeLesson(ui)

    // Practice until Hodos recommends the checkpoint; one answer with a missing accent on the way.
    let almost: AttemptView | undefined
    for (let n = 0; n < 20; n++) {
      const view = engine.journey(ui)
      if (view.nextAction.type === 'practice' && view.nextAction.readyForCheckpoint) break
      const exercise = engine.nextExercise(ui)
      if (exercise === null) throw new Error('no practice exercise')
      const answer = correct(exercise)
      if (almost === undefined && typeof answer === 'object' && answer !== null && !Array.isArray(answer) && typeof answer.text === 'string' && /[áéíóú]/u.test(answer.text)) {
        almost = await engine.submitAttempt(ui, { presentationId: exercise.id, response: { text: answer.text.normalize('NFD').replace(/́/gu, '') } })
        if (almost.canRetry) await engine.submitAttempt(ui, { presentationId: exercise.id, response: answer })
        continue
      }
      await engine.submitAttempt(ui, { presentationId: exercise.id, response: answer })
      clock.advance(30_000)
    }
    expect(almost?.status).toBe('partial')
    expect(almost?.misconceptionFeedback?.[0]).toContain('accents')
    expect(engine.journey(ui).nextAction).toMatchObject({ type: 'practice', readyForCheckpoint: true })

    // The checkpoint, unassisted.
    engine.startCheckpoint(ui)
    for (let n = 0; n < 5; n++) {
      const exercise = engine.nextExercise(ui)
      if (exercise === null || exercise.mode !== 'checkpoint') break
      expect(exercise.hintsAvailable).toBe(0)
      await engine.submitAttempt(ui, { presentationId: exercise.id, response: correct(exercise) })
    }
    const after = engine.journey(ui)
    expect(after.completed).toContain(SKILL.greetings)
    const mastered = after.completedSkills.find(s => s.id === SKILL.greetings)
    expect(mastered?.status).toBe('mastered')
    expect(mastered?.dueAt).not.toBeNull()

    // Nothing is due yet; once the scheduled day comes, the skill is reviewed with practice items.
    expect(engine.dueReviews(ui)).toEqual([])
    clock.set(new Date(new Date(mastered?.dueAt ?? 0).getTime() + 60_000))
    expect(engine.dueReviews(ui).map(d => d.skillId)).toEqual([SKILL.greetings])
    engine.startReview(ui)
    const review = engine.nextExercise(ui)
    expect(review?.mode).toBe('review')
    expect(course.items.find(i => i.id === review?.itemId)?.modes).toContain('review')
    await engine.submitAttempt(ui, { presentationId: review?.id ?? '', response: correct(review as ExerciseView) })
    const rescheduled = engine.journey(ui).completedSkills.find(s => s.id === SKILL.greetings)
    expect(new Date(rescheduled?.dueAt ?? 0).getTime()).toBeGreaterThan(clock.now().getTime())
  })
})
