import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExerciseItem } from '@hodos/plugin-sdk'
import {
  HodosEngine,
  HodosError,
  HodosStore,
  manualClock,
  PluginRegistry,
  SandboxRunner,
  sequentialIds,
  type Actor,
  type AttemptView,
  type EngineConfig,
  type EngineEvent,
  type ExerciseView,
  type ManualClock,
} from '../src/index.js'
import { correctResponse, createQuizPlugin, quizCourse, wrongResponse, type QuizOptions } from './support/quiz-plugin.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => {}, warn: () => {}, error: () => {} }
const course = quizCourse()

/** Items of courses created inside tests. */
const extraItems = new Map<string, ExerciseItem>()

function itemOf(ex: { itemId: string }): ExerciseItem {
  const item = course.items.find(i => i.id === ex.itemId) ?? extraItems.get(ex.itemId)
  if (item === undefined) throw new Error(`unknown item ${ex.itemId}`)
  return item
}

interface Env {
  readonly clock: ManualClock
  readonly store: HodosStore
  readonly engine: HodosEngine
  readonly ui: Actor
  readonly agent: Actor
  readonly events: EngineEvent[]
}

async function setup(options: { path?: string; quiz?: QuizOptions; plugin?: boolean; clock?: ManualClock; config?: Partial<EngineConfig> } = {}): Promise<Env> {
  const clock = options.clock ?? manualClock(new Date('2026-10-26T09:00:00.000Z'))
  const store = new HodosStore(options.path ?? ':memory:')
  const registry = new PluginRegistry({ sandbox, logger: silent })
  if (options.plugin !== false) await registry.register(createQuizPlugin(options.quiz), { trusted: true })
  const engine = new HodosEngine({ store, registry, clock, ids: sequentialIds(), ...(options.config === undefined ? {} : { config: options.config }) })
  if (options.plugin !== false) expect(await engine.syncContentPacks()).toEqual([])
  const learnerId = engine.learnerForPrincipal('owner')
  const events: EngineEvent[] = []
  engine.onEvent(e => events.push(e))
  return { clock, store, engine, events, ui: { learnerId, channel: 'ui', sessionId: 'sess-1' }, agent: { learnerId, channel: 'agent', sessionId: 'sess-1' } }
}

async function answer(env: Env, actor: Actor, ex: ExerciseView, correct: boolean): Promise<AttemptView> {
  env.clock.advance(15_000)
  const item = itemOf(ex)
  if (item.kind === 'quiz.sequence') {
    const steps = (item.key as { steps: string[] }).steps
    if (!correct) return env.engine.submitAttempt(actor, { presentationId: ex.id, response: { token: 'wrong' } })
    let last: AttemptView | undefined
    for (const token of steps) last = await env.engine.submitAttempt(actor, { presentationId: ex.id, response: { token } })
    if (last === undefined) throw new Error('empty sequence')
    return last
  }
  return env.engine.submitAttempt(actor, { presentationId: ex.id, response: correct ? correctResponse(item) : wrongResponse(item), latencyMs: 4000 })
}

function next(env: Env, actor: Actor = env.ui): ExerciseView {
  const ex = env.engine.nextExercise(actor)
  if (ex === null) throw new Error('expected an exercise')
  return ex
}

/** Run the diagnostic: the learner knows addition and says "I don't know" otherwise. */
async function diagnose(env: Env): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const ex = env.engine.nextExercise(env.ui)
    if (ex === null || ex.mode !== 'diagnostic') return
    const knows = ex.skills.some(s => s.skillId === 'quiz.add')
    const result = knows ? await answer(env, env.ui, ex, true) : await env.engine.submitAttempt(env.ui, { presentationId: ex.id, response: { dontKnow: true } })
    expect(result.status).toBe('recorded')
    expect(result.feedback).toBeUndefined()
    expect(result.explanation).toBeUndefined()
  }
  throw new Error('diagnostic did not finish')
}

/** Practice correctly until the active skill only lacks checkpoint successes. */
async function practiceUntilReady(env: Env): Promise<number> {
  for (let n = 1; n <= 40; n++) {
    const ex = next(env)
    expect(ex.mode).toBe('practice')
    await answer(env, env.ui, ex, true)
    const action = env.engine.journey(env.ui).nextAction
    if (action.type === 'practice' && action.readyForCheckpoint) return n
  }
  throw new Error('never became ready for the checkpoint')
}

async function takeCheckpoint(env: Env, correct: boolean): Promise<AttemptView> {
  let last: AttemptView | undefined
  for (let i = 0; i < 5; i++) {
    const ex = env.engine.nextExercise(env.ui)
    if (ex === null || ex.mode !== 'checkpoint') break
    expect(ex.hintsAvailable).toBe(0)
    last = await answer(env, env.ui, ex, correct)
    expect(last.status).toBe('recorded')
    expect(last.feedback).toBeUndefined()
  }
  if (last === undefined) throw new Error('no checkpoint items')
  return last
}

describe('engine: the full learning journey', () => {
  it('diagnoses, plans, teaches, practises with hints, adapts after a failed checkpoint, passes it and resumes after restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hodos-engine-')), 'hodos.db')
    const env = await setup({ path })
    const { engine, ui, agent } = env

    const started = engine.startJourney(agent, { goal: 'Teach me arithmetic. I know addition but struggle with multiplication.', selfReport: [{ skill: 'addition', level: 'used-it' }] })
    expect(started.course.id).toBe('quiz-arithmetic')
    expect(started.phase).toBe('diagnostic')

    // Diagnostic answers come from the learner, never relayed by the tutor; no hints.
    const first = next(env)
    expect(first.mode).toBe('diagnostic')
    await expect(engine.submitAttempt(agent, { presentationId: first.id, response: correctResponse(itemOf(first)) })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    expect(() => engine.requestHint(ui, first.id)).toThrow(/not available in diagnostic/)
    await diagnose(env)

    let view = engine.journey(ui)
    expect(view.phase).toBe('planning')
    expect(view.diagnosedKnown).toEqual(['quiz.add'])
    expect(view.path.map(s => s.id)).toEqual(['quiz.mul', 'quiz.mixed'])
    expect(view.nextAction).toEqual({ type: 'approve-path' })

    // The tutor may approve the path of shipped content on the learner's behalf.
    view = engine.approvePath(agent)
    expect(view.phase).toBe('learning')
    expect(view.activeSkill?.id).toBe('quiz.mul')
    expect(view.stage).toBe('teach')

    // Lesson: formative checks gate completion; answers are withheld until answered.
    const lesson = engine.lesson(ui)
    expect(JSON.stringify(lesson)).not.toContain('because that is the rule')
    expect(lesson.canComplete).toBe(false)
    expect(() => engine.completeLesson(ui)).toThrow(/check questions first/)
    const checkId = lesson.lessons[0]?.checks[0]?.id ?? ''
    expect(engine.answerCheck(ui, { lessonId: 'lesson-mul', checkId, optionId: 'b' })).toMatchObject({ correct: false, explanation: 'Yes, because that is the rule.' })
    expect(engine.answerCheck(ui, { lessonId: 'lesson-mul', checkId, optionId: 'a' }).correct).toBe(true)
    view = engine.completeLesson(ui)
    expect(view.stage).toBe('practice')

    // Practice with the hint ladder: L1 first, stronger hints only after an attempt, paced.
    const practice = next(env)
    expect(practice.mode).toBe('practice')
    expect(practice.hints).toEqual([])
    expect(engine.requestHint(ui, practice.id).level).toBe(1)
    expect(() => engine.requestHint(ui, practice.id)).toThrow(/make an attempt/)
    const miss = await answer(env, ui, practice, false)
    expect(miss.status).toBe('incorrect')
    expect(miss.canRetry).toBe(true)
    expect(miss.explanation).toBeUndefined()
    expect(engine.requestHint(ui, practice.id).level).toBe(2)
    expect(() => engine.requestHint(ui, practice.id)).toThrow(HodosError)
    env.clock.advance(21_000)
    expect(engine.requestHint(ui, practice.id).level).toBe(3)
    const hit = await answer(env, ui, practice, true)
    expect(hit.status).toBe('correct')
    expect(hit.explanation).toContain('Worked explanation')
    expect(hit.reveal).toBeDefined()
    const assisted = env.store.evidenceFor(practice.id)
    expect(assisted.map(e => [e.attempt, e.countsForMastery, e.assisted])).toEqual([[1, true, true], [2, false, true]])

    await practiceUntilReady(env)

    // Checkpoint: no hints, no relayed answers, correctness withheld until the end.
    const checkpoint = engine.startCheckpoint(ui)
    expect(checkpoint.total).toBe(3)
    const cp1 = next(env)
    expect(cp1.mode).toBe('checkpoint')
    expect(() => engine.requestHint(ui, cp1.id)).toThrow(/not available in checkpoint/)
    await expect(engine.submitAttempt(agent, { presentationId: cp1.id, response: correctResponse(itemOf(cp1)) })).rejects.toMatchObject({ code: 'POLICY_DENIED' })
    const failed = await takeCheckpoint(env, false)
    expect(failed.checkpoint?.status).toBe('failed')
    expect(failed.checkpoint?.result?.items.every(i => i.explanation !== undefined)).toBe(true)
    expect(failed.checkpoint?.result?.adaptation).toMatchObject({ rest: false })
    view = engine.journey(ui)
    expect(view.stage).toBe('remedial')
    expect(view.activeSkill?.gateOpen).toBe(false)
    expect(engine.lesson(ui).lessons.some(l => l.origin === 'overlay')).toBe(true)
    view = engine.completeLesson(ui)
    expect(view.stage).toBe('practice')

    // A cooldown follows a failed checkpoint; then more practice before the next attempt.
    expect(() => engine.startCheckpoint(ui)).toThrow(/next checkpoint opens in/)
    env.clock.advance(61_000)
    await practiceUntilReady(env)
    expect(() => engine.startCheckpoint(ui)).not.toThrow()
    const passed = await takeCheckpoint(env, true)
    expect(passed.checkpoint?.status).toBe('passed')
    expect(passed.skill?.gateOpen).toBe(true)
    view = engine.journey(ui)
    expect(view.completed).toEqual(['quiz.mul'])
    expect(view.activeSkill?.id).toBe('quiz.mixed')
    expect(view.stage).toBe('teach')
    expect(env.events.some(e => e.type === 'checkpoint' && e.passed)).toBe(true)

    const before = env.store.skillStates(ui.learnerId)
    env.store.close()

    // Restart: a new process opens the same database.
    const restarted = await setup({ path, clock: env.clock })
    expect(restarted.ui.learnerId).toBe(ui.learnerId)
    const resumed = restarted.engine.resume(restarted.ui)
    expect(resumed?.activeSkill?.id).toBe('quiz.mixed')
    expect(resumed?.completed).toEqual(['quiz.mul'])
    expect(restarted.engine.progress(restarted.ui).skills.find(s => s.id === 'quiz.mul')?.status).toBe('mastered')

    // Derived state is a pure function of the evidence log.
    const replayed = restarted.engine.rebuildDerivedState(restarted.ui.learnerId)
    expect(replayed).toBeGreaterThan(10)
    expect(restarted.store.skillStates(restarted.ui.learnerId)).toEqual(before)
    restarted.store.close()
  }, 30_000)
})

/** Propose, approve and start a one-skill course built from the given items. */
async function customJourney(env: Env, id: string, items: ExerciseItem[]): Promise<void> {
  const base = quizCourse()
  const addSkill = base.skills.find(s => s.id === 'quiz.add')
  if (addSkill === undefined) throw new Error('fixture')
  const tagged = items.map(i => ({ ...i, skills: [{ skillId: 'quiz.add', weight: 1 }] }))
  for (const item of tagged) extraItems.set(item.id, item)
  const spec = { ...base, id, title: id, keywords: [id], goal: 'quiz.add', skills: [addSkill], lessons: [], items: tagged }
  const proposal = await env.engine.proposeCourse(env.agent, spec)
  expect(proposal.errors).toEqual([])
  await env.engine.decideCourse(env.ui, { courseId: id, version: base.version, approve: true })
  env.engine.startJourney(env.ui, { goal: id, courseId: id, skipDiagnostic: true })
  env.engine.approvePath(env.ui)
  env.engine.completeLesson(env.ui)
}

describe('engine: policy and security', () => {
  async function learning(env: Env): Promise<void> {
    env.engine.startJourney(env.ui, { goal: 'arithmetic multiplication', skipDiagnostic: true })
    env.engine.approvePath(env.ui)
    const lesson = env.engine.lesson(env.ui)
    for (const l of lesson.lessons) for (const c of l.checks) env.engine.answerCheck(env.ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    env.engine.completeLesson(env.ui)
  }

  it('counts relayed answers and tutor contact as assisted', async () => {
    const env = await setup()
    await learning(env)
    const relayed = next(env)
    await answer(env, env.agent, relayed, true)
    const [evidence] = env.store.evidenceFor(relayed.id)
    expect(evidence).toMatchObject({ assisted: true, hintLevel: 3, channel: 'agent', assistance: { relay: true } })

    const contacted = next(env)
    expect(env.engine.recordTutorContact(env.ui.learnerId)).toBe(1)
    await answer(env, env.ui, contacted, true)
    expect(env.store.evidenceFor(contacted.id)[0]).toMatchObject({ assisted: true, hintLevel: 2, assistance: { tutorContact: true } })
  })

  it('does not count checkpoint answers given after the learner talked to the tutor', async () => {
    const env = await setup()
    await learning(env)
    await practiceUntilReady(env)
    env.engine.startCheckpoint(env.ui)
    expect(env.engine.tutorContext(env.ui).text).toContain('Do NOT give hints')
    next(env)
    env.engine.recordTutorContact(env.ui.learnerId)
    const result = await takeCheckpoint(env, true)
    expect(result.checkpoint?.status).toBe('failed')
    expect(result.checkpoint?.result?.unmet.join(' ')).toMatch(/checkpoint successes/)
  })

  it('suggests a break once the daily adaptation budget for a skill is spent', async () => {
    const env = await setup({ config: { maxAdaptationsPerSkillPerDay: 0 } })
    await learning(env)
    await practiceUntilReady(env)
    env.engine.startCheckpoint(env.ui)
    const result = await takeCheckpoint(env, false)
    expect(result.checkpoint?.result?.adaptation).toMatchObject({ rest: true, insertedPrerequisites: [] })
    expect(env.engine.journey(env.ui).nextAction.type).toBe('rest')
    // The next day the remedial step is offered again.
    env.clock.advance(24 * 3600 * 1000)
    expect(env.engine.journey(env.ui).nextAction).toEqual({ type: 'remedial', skillId: 'quiz.add' })
  })

  it('never lets an AI-rubric grader open a gate', async () => {
    const env = await setup({ quiz: { method: 'ai-rubric' } })
    await learning(env)
    await practiceUntilReady(env)
    env.engine.startCheckpoint(env.ui)
    const result = await takeCheckpoint(env, true)
    expect(result.checkpoint?.status).toBe('failed')
    expect(env.store.skillStates(env.ui.learnerId).get('quiz.add')?.checkpointSuccesses).toEqual([])
  })

  it('redacts grader feedback that would reveal the key', async () => {
    const env = await setup({ quiz: { leakFeedback: true } })
    const text = quizCourse().items.find(i => i.id === 'mul-t1')
    if (text === undefined) throw new Error('fixture')
    await customJourney(env, 'quiz-leaky', [1, 2, 3].map(n => ({ ...text, id: `leaky-${n}` })))
    const ex = next(env)
    const result = await answer(env, env.ui, ex, false)
    expect(result.status).toBe('incorrect')
    expect(result.feedback).toBe('Not quite. Try again or ask for a hint.')
    expect(JSON.stringify(result)).not.toContain((text.key as { answer: string }).answer)
    expect(env.store.securityEvents().map(e => e.type)).toContain('feedback-redacted')
    // Once the answer is released (correct answer), feedback passes unchanged.
    const right = await answer(env, env.ui, ex, true)
    expect(right.feedback).toContain('The answer is')
  })

  it('refuses a failing grader without recording evidence or leaking its message', async () => {
    const env = await setup({ quiz: { throwWithKey: true } })
    await learning(env)
    const ex = next(env)
    const error = await answer(env, env.ui, ex, true).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'UNAVAILABLE', message: 'grading failed for this exercise; your attempt was not counted' })
    expect(env.store.evidenceFor(ex.id)).toEqual([])
    expect(env.store.securityEvents().map(e => e.type)).toContain('grader-rejected')
  })

  it('isolates learners: identity comes from the actor, not from ids in arguments', async () => {
    const env = await setup()
    await learning(env)
    const ex = next(env)
    const intruder: Actor = { learnerId: env.engine.learnerForPrincipal('someone-else'), channel: 'ui' }
    await expect(env.engine.submitAttempt(intruder, { presentationId: ex.id, response: correctResponse(itemOf(ex)) })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(() => env.engine.requestHint(intruder, ex.id)).toThrow(/another learner/)
    expect(() => env.engine.journey(intruder, env.engine.journey(env.ui).id)).toThrow(/another learner/)
    expect(() => env.engine.journey(intruder)).toThrow(/no learning journey/)
    expect(env.store.securityEvents().filter(e => e.type === 'forbidden-access')).toHaveLength(3)
  })

  it('keeps answer keys out of exercise views, tutor context and exports', async () => {
    const env = await setup()
    await learning(env)
    const ex = next(env)
    const item = itemOf(ex)
    const secrets = [JSON.stringify(item.key), item.explanation ?? '', 'internal-note']
    const context = env.engine.tutorContext(env.ui)
    for (const value of [ex, context, env.engine.exportData(env.ui), env.engine.progress(env.ui), env.engine.journey(env.ui)]) {
      const json = JSON.stringify(value)
      for (const s of secrets) expect(json).not.toContain(s)
    }
    expect(context.text).toContain('never state the answer directly')
    expect(ex.fallbackText).toContain('What is')
  })

  it('runs stepwise exercises with server-held progress', async () => {
    const env = await setup()
    const sequence = quizCourse().items.find(i => i.id === 'mixed-s1')
    if (sequence === undefined) throw new Error('fixture')
    await customJourney(env, 'quiz-steps', [1, 2, 3].map(n => ({ ...sequence, id: `steps-${n}` })))
    expect(env.engine.lesson(env.ui, { skillId: 'quiz.add' }).lessons[0]?.origin).toBe('generated')

    const ex = next(env)
    expect(ex.kind).toBe('quiz.sequence')
    const first = await env.engine.submitAttempt(env.ui, { presentationId: ex.id, response: { token: 'multiply' } })
    expect(first).toMatchObject({ status: 'continue', progress: { entered: ['multiply'] }, message: 'Good. Next step?' })
    // The open exercise resumes with the server-held progress.
    expect(next(env)).toMatchObject({ id: ex.id, progress: { entered: ['multiply'] } })
    expect((await env.engine.submitAttempt(env.ui, { presentationId: ex.id, response: { token: 'twelve' } })).status).toBe('continue')
    const done = await env.engine.submitAttempt(env.ui, { presentationId: ex.id, response: { token: 'fourteen' } })
    expect(done).toMatchObject({ status: 'correct', canRetry: false })
    expect(env.store.evidenceFor(ex.id)).toHaveLength(1)
    await expect(env.engine.submitAttempt(env.ui, { presentationId: ex.id, response: { token: 'again' } })).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('degrades gracefully when the environment plugin is missing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hodos-missing-')), 'hodos.db')
    const env = await setup({ path })
    await learning(env)
    const ex = next(env)
    env.store.close()
    const bare = await setup({ path, plugin: false, clock: env.clock })
    const view = bare.engine.journey(bare.ui)
    expect(view.environments).toEqual([{ id: 'quiz.card', available: false }])
    expect(() => bare.engine.nextExercise(bare.ui)).toThrow(/not installed/)
    await expect(bare.engine.submitAttempt(bare.ui, { presentationId: ex.id, response: { choice: 'a' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(bare.engine.progress(bare.ui).total).toBe(3)
    expect(bare.engine.tutorContext(bare.ui).text).toContain('Hodos learning context')
    expect(bare.engine.lesson(bare.ui).lessons[0]?.origin).toBe('generated')
    bare.store.close()
  })

  it('keeps agent-proposed courses as drafts until the learner approves them', async () => {
    const env = await setup()
    const malformed = await env.engine.proposeCourse(env.agent, { id: 'x', items: 'none' })
    expect(malformed.stored).toBe(false)
    expect(malformed.errors.length).toBeGreaterThan(0)
    const proposal = { ...quizCourse(), id: 'quiz-custom', title: 'Custom quiz', keywords: ['custom'] }
    const stored = await env.engine.proposeCourse(env.agent, proposal)
    expect(stored).toMatchObject({ stored: true, errors: [] })
    expect(env.engine.drafts().map(d => d.id)).toEqual(['quiz-custom'])
    expect(env.engine.catalog().map(c => c.id)).not.toContain('quiz-custom')
    await expect(env.engine.decideCourse(env.agent, { courseId: 'quiz-custom', version: '1.0.0', approve: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await env.engine.decideCourse(env.ui, { courseId: 'quiz-custom', version: '1.0.0', approve: true })
    expect(env.engine.catalog().map(c => c.id)).toContain('quiz-custom')
    env.engine.startJourney(env.agent, { goal: 'custom', courseId: 'quiz-custom', skipDiagnostic: true })
    expect(() => env.engine.approvePath(env.agent)).toThrow(/learner must approve/)
    expect(env.engine.approvePath(env.ui).phase).toBe('learning')
  })

  it('bounds tutor notices and delegations per learner', async () => {
    const env = await setup()
    const allowed = Array.from({ length: 10 }, () => env.engine.allowNotice(env.ui.learnerId)).filter(Boolean).length
    expect(allowed).toBe(6)
    env.engine.chargeDelegation(env.ui.learnerId)
    env.engine.chargeDelegation(env.ui.learnerId)
    env.engine.chargeDelegation(env.ui.learnerId)
    expect(() => env.engine.chargeDelegation(env.ui.learnerId)).toThrow(/too many delegate/)
  })
})
