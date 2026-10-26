/**
 * Integration: the chess environment on the Hodos core engine — course
 * validation with full coverage and the start of the demo journey.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createChessPlugin, SKILL, tacticsCourse } from '@hodos/chess'
import { HodosEngine, HodosStore, PluginRegistry, SandboxRunner, validateCourse, type Actor } from '@hodos/core'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => {}, warn: () => {}, error: () => {} }
const course = tacticsCourse()

describe('course on the Hodos engine', () => {
  it('validates with full coverage and starts the demo journey at knight forks', async () => {
    const registry = new PluginRegistry({ sandbox, logger: silent })
    await registry.register(createChessPlugin(), { trusted: true })
    const findings = await validateCourse(course, registry, { requireCoverage: true })
    expect(findings.filter(f => f.severity === 'error')).toEqual([])

    const engine = new HodosEngine({ store: new HodosStore(':memory:'), registry })
    expect(await engine.syncContentPacks()).toEqual([])
    const learnerId = engine.learnerForPrincipal('owner')
    const ui: Actor = { learnerId, channel: 'ui', sessionId: 's1' }
    const view = engine.startJourney({ ...ui, channel: 'agent' }, {
      goal: 'Teach me chess tactics. I know the basic rules but struggle with knight forks.',
      selfReport: [{ skill: 'basic rules', level: 'used-it' }, { skill: 'knight forks', level: 'heard-of' }],
    })
    expect(view.course.id).toBe('chess-tactics')
    expect(view.phase).toBe('diagnostic')
    // The learner knows the rules and does not know the rest.
    for (let i = 0; i < 15; i++) {
      const ex = engine.nextExercise(ui)
      if (ex === null || ex.mode !== 'diagnostic') break
      const rules = ex.skills.some(s => s.skillId === SKILL.rules)
      const it = course.items.find(x => x.id === ex.itemId)
      const key = (it?.key as { line?: string[] } | undefined)?.line?.[0] ?? ''
      await engine.submitAttempt(ui, { presentationId: ex.id, response: rules ? { move: key } : { dontKnow: true } })
    }
    const planned = engine.journey(ui)
    expect(planned.phase).toBe('planning')
    expect(planned.diagnosedKnown).toEqual([SKILL.rules])
    expect(planned.path[0]?.id).toBe(SKILL.knightFork)
    engine.approvePath(ui)
    const lesson = engine.lesson(ui)
    expect(lesson.lessons[0]?.title).toBe('Knight forks')
    const block = Object.values(lesson.lessons[0]?.blocks ?? {})[0]
    expect(block).toMatchObject({ type: 'chess-position', renderer: { pluginId: 'hodos-chess', rendererId: 'chess-board' } })
    expect(JSON.stringify(lesson)).not.toContain('A knight moves two squares one way')
  })
})
