import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BKT_PARAMS,
  DEFAULT_MASTERY_CONFIG,
  FsrsScheduler,
  applyItemObservation,
  bktUpdate,
  bktUpdateMulti,
  eloPMastered,
  eloUpdate,
  evaluateGate,
  gradeRetrieval,
  initialSkillState,
  oraclePMastered,
  type BktMode,
  type ItemObservation,
  type SkillState,
} from '../src/index.js'

interface GoldenStep { x: number; hint_level: number; b: number; mode: BktMode }
interface Golden {
  params: { p0: number; T: number; s0: number; g0: number; max_hint_level: number; p_eps: number; lambda: Record<BktMode, number> }
  single: Array<{ name: string; p0: number; steps: GoldenStep[]; expected: number[] }>
  multi: Array<{ name: string; p0: Record<string, number>; skills: Array<[string, number]>; steps: GoldenStep[]; expected: Array<Record<string, number>> }>
}

const golden = JSON.parse(readFileSync(new URL('./fixtures/bkt_golden.json', import.meta.url), 'utf8')) as Golden
const parity = JSON.parse(readFileSync(new URL('./fixtures/ts_fsrs_golden.json', import.meta.url), 'utf8')) as {
  sequence: Array<{ elapsed: number; grade: 1 | 2 | 3 | 4; stability: number; difficulty: number; interval: number }>
}

describe('BKT-lite matches the M0 reference implementation (golden vectors)', () => {
  it('uses the same default parameters', () => {
    expect(DEFAULT_BKT_PARAMS.p0).toBe(golden.params.p0)
    expect(DEFAULT_BKT_PARAMS.T).toBe(golden.params.T)
    expect(DEFAULT_BKT_PARAMS.s0).toBe(golden.params.s0)
    expect(DEFAULT_BKT_PARAMS.g0).toBe(golden.params.g0)
    expect(DEFAULT_BKT_PARAMS.maxHintLevel).toBe(golden.params.max_hint_level)
    expect(DEFAULT_BKT_PARAMS.lambda).toEqual(golden.params.lambda)
  })

  for (const c of golden.single) {
    it(`single-skill vector: ${c.name}`, () => {
      let p = c.p0
      c.steps.forEach((st, i) => {
        p = bktUpdate(p, { x: st.x, hintLevel: st.hint_level, b: st.b, mode: st.mode })
        expect(p).toBeCloseTo(c.expected[i] ?? Number.NaN, 12)
      })
    })
  }

  for (const c of golden.multi) {
    it(`multi-skill vector: ${c.name}`, () => {
      let p: Record<string, number> = { ...c.p0 }
      c.steps.forEach((st, i) => {
        p = bktUpdateMulti(p, c.skills, { x: st.x, hintLevel: st.hint_level, b: st.b, mode: st.mode })
        for (const [k, v] of Object.entries(c.expected[i] ?? {})) expect(p[k]).toBeCloseTo(v, 12)
      })
    })
  }
})

describe('hint discount', () => {
  it('a correct answer after the bottom-out hint counts as a failure', () => {
    const after = bktUpdate(0.5, { x: 1, hintLevel: 5, b: 0, mode: 'practice' })
    const wrong = bktUpdate(0.5, { x: 0, hintLevel: 0, b: 0, mode: 'practice' })
    expect(after).toBeCloseTo(wrong, 12)
  })

  it('assisted correct answers move P(L) less than unassisted ones', () => {
    const unassisted = bktUpdate(0.3, { x: 1, hintLevel: 0, b: 0, mode: 'practice' })
    const hinted = bktUpdate(0.3, { x: 1, hintLevel: 2, b: 0, mode: 'practice' })
    expect(hinted).toBeLessThan(unassisted)
  })

  it('choice items raise the guess floor so lucky answers count for less', () => {
    const open = bktUpdate(0.3, { x: 1, hintLevel: 0, b: 0, mode: 'practice' })
    const twoOptions = bktUpdate(0.3, { x: 1, hintLevel: 0, b: 0, mode: 'practice', options: 2 })
    expect(twoOptions).toBeLessThan(open)
  })
})

describe('FSRS scheduling parity with ts-fsrs 5.4.2 (M0 fixture)', () => {
  it('reproduces stability, difficulty and interval for the reference sequence', () => {
    const scheduler = new FsrsScheduler(0.9)
    let now = new Date('2026-01-01T00:00:00Z')
    let card = null as ReturnType<FsrsScheduler['review']> | null
    for (const step of parity.sequence) {
      now = new Date(now.getTime() + step.elapsed * 86_400_000)
      card = scheduler.review(card, step.grade, now)
      expect(card.stability).toBeCloseTo(step.stability, 4)
      expect(card.difficulty).toBeCloseTo(step.difficulty, 4)
      expect(Math.round((new Date(card.due).getTime() - now.getTime()) / 86_400_000)).toBe(step.interval)
    }
  })

  it('retrievability decays with time and is ~0.9 at the due date', () => {
    const scheduler = new FsrsScheduler(0.9)
    const start = new Date('2026-01-01T00:00:00Z')
    const card = scheduler.review(scheduler.review(null, 3, start), 3, new Date(start.getTime() + 2 * 86_400_000))
    const due = new Date(card.due)
    expect(scheduler.retrievability(card, new Date(card.lastReview))).toBeCloseTo(1, 6)
    expect(scheduler.retrievability(card, due)).toBeGreaterThan(0.85)
    expect(scheduler.retrievability(card, due)).toBeLessThan(0.95)
  })

  it('maps graded retrievals to FSRS grades', () => {
    expect(gradeRetrieval({ evidence: 0.2, assisted: false, bottomOut: false })).toBe(1)
    expect(gradeRetrieval({ evidence: 1, assisted: false, bottomOut: true })).toBe(1)
    expect(gradeRetrieval({ evidence: 0.8, assisted: true, bottomOut: false })).toBe(2)
    expect(gradeRetrieval({ evidence: 1, assisted: false, bottomOut: false })).toBe(3)
    expect(gradeRetrieval({ evidence: 1, assisted: false, bottomOut: false, speedRatio: 0.3, confidence: 'sure' })).toBe(4)
  })
})

describe('Elo estimator', () => {
  it('moves ability toward the outcome with a decaying step', () => {
    const item = { b: 0, m: 0 }
    const win = eloUpdate({ theta: 0, n: 0 }, item, 1, 'practice')
    expect(win.state.theta).toBeCloseTo(0.4, 10)
    expect(win.item.b).toBeLessThan(0)
    const checkpoint = eloUpdate({ theta: 0, n: 0 }, item, 1, 'checkpoint')
    expect(checkpoint.item).toEqual(item)
    const later = eloUpdate({ theta: 0, n: 20 }, item, 1, 'practice')
    expect(later.state.theta).toBeLessThan(win.state.theta)
  })

  it('reports 0.5 exactly at 80% success on a target item', () => {
    expect(eloPMastered({ theta: Math.log(0.8 / 0.2), n: 5 })).toBeCloseTo(0.5, 10)
  })
})

describe('oracle estimator', () => {
  it('is the Beta(1,1) posterior mean', () => {
    expect(oraclePMastered({ outcomes: [] })).toBe(0.5)
    expect(oraclePMastered({ outcomes: [1, 1, 1] })).toBeCloseTo(0.8, 10)
  })
})

describe('mastery gates (security: gates cannot be bypassed)', () => {
  const config = DEFAULT_MASTERY_CONFIG
  const scheduler = new FsrsScheduler(config.targetRetention)
  const ctx = { config, scheduler, skillContext: () => ({}) }
  const at = new Date('2026-03-01T10:00:00Z')

  const observe = (state: SkillState, overrides: Partial<ItemObservation>): SkillState => {
    const obs: ItemObservation = {
      itemId: 'i1', mode: 'practice', skills: [{ skillId: state.skillId, score: 1, weight: 1 }], hintLevel: 0,
      assisted: false, difficulty: 0, guessable: false, countsForMastery: true, misconceptions: [], at, ...overrides,
    }
    const next = applyItemObservation(new Map([[state.skillId, state]]), obs, ctx).get(state.skillId)
    if (next === undefined) throw new Error('missing state')
    return next
  }

  it('practice alone never opens a BKT gate, however high P(L) goes', () => {
    let s = initialSkillState('s', 'concept', 'explain-check', config)
    for (let i = 1; i <= 8; i++) s = observe(s, { itemId: `i${i}` })
    expect(s.est.estimator === 'bkt' && s.est.p).toBeGreaterThan(0.95)
    expect(s.gateOpen).toBe(false)
    expect(evaluateGate(s, {}, config).unmet.join(' ')).toMatch(/checkpoint/)
  })

  it('requires three distinct guessable checkpoint successes, or one guess-resistant one', () => {
    let guessable = initialSkillState('s', 'concept', 'explain-check', config)
    for (let i = 1; i <= 4; i++) guessable = observe(guessable, { itemId: `p${i}` })
    guessable = observe(guessable, { itemId: 'c1', mode: 'checkpoint', guessable: true })
    guessable = observe(guessable, { itemId: 'c2', mode: 'checkpoint', guessable: true })
    expect(guessable.gateOpen).toBe(false)
    guessable = observe(guessable, { itemId: 'c2', mode: 'checkpoint', guessable: true })
    expect(guessable.gateOpen).toBe(false)
    guessable = observe(guessable, { itemId: 'c3', mode: 'checkpoint', guessable: true })
    expect(guessable.gateOpen).toBe(true)

    let resistant = initialSkillState('s', 'concept', 'explain-check', config)
    for (let i = 1; i <= 4; i++) resistant = observe(resistant, { itemId: `p${i}` })
    resistant = observe(resistant, { itemId: 'c1', mode: 'checkpoint', guessable: false })
    expect(resistant.gateOpen).toBe(true)
    expect(resistant.card).not.toBeNull()
  })

  it('assisted checkpoint answers never count as unassisted successes', () => {
    let s = initialSkillState('s', 'concept', 'explain-check', config)
    for (let i = 1; i <= 4; i++) s = observe(s, { itemId: `p${i}` })
    s = observe(s, { itemId: 'c1', mode: 'checkpoint', assisted: true, hintLevel: config.tutorContactHintLevel })
    expect(s.checkpointSuccesses).toEqual([])
    expect(s.gateOpen).toBe(false)
  })

  it('a self-reported prior never opens the gate and is discounted', () => {
    const s = initialSkillState('s', 'concept', 'explain-check', config, { p: 0.99, source: 'self-report' })
    expect(s.pMastered).toBeLessThan(0.6)
    expect(evaluateGate(s, {}, config).open).toBe(false)
  })

  it('requires evidence from three distinct items', () => {
    let s = initialSkillState('s', 'pattern', 'recognize-fast', config, { p: 0.9, source: 'diagnostic' })
    s = observe(s, { itemId: 'c1', mode: 'checkpoint' })
    expect(s.gateOpen).toBe(false)
    expect(evaluateGate(s, {}, config).unmet.join(' ')).toMatch(/3 distinct items/)
  })

  it('first-miss retries do not create mastery evidence', () => {
    const s0 = initialSkillState('s', 'concept', 'explain-check', config)
    const s1 = observe(s0, { countsForMastery: false })
    expect(s1.est).toEqual(s0.est)
    expect(s1.masteryItems).toEqual([])
  })

  it('Elo gates enforce the fluency target', () => {
    let s = initialSkillState('s', 'pattern', 'recognize-fast', config)
    const slowCtx = { ...ctx, skillContext: () => ({ fluencyTargetSec: 20 }) }
    for (let i = 1; i <= 12; i++) {
      s = applyItemObservation(new Map([['s', s]]), {
        itemId: `i${i}`, mode: i > 10 ? 'checkpoint' : 'practice', skills: [{ skillId: 's', score: 1, weight: 1 }], hintLevel: 0,
        assisted: false, difficulty: 0.5, guessable: false, countsForMastery: true, misconceptions: [], at, latencyMs: 45_000,
      }, slowCtx).get('s') ?? s
    }
    expect(s.gateOpen).toBe(false)
    expect(evaluateGate(s, { fluencyTargetSec: 20 }, config).unmet.join(' ')).toMatch(/fluency/)
  })

  it('fact skills need most of the deck acquired plus checkpoint recalls', () => {
    let s = initialSkillState('vocab', 'fact', 'drill', config)
    const factCtx = { ...ctx, skillContext: () => ({ deckSize: 4 }) }
    const apply = (itemId: string, mode: ItemObservation['mode'], score: number): void => {
      s = applyItemObservation(new Map([['vocab', s]]), {
        itemId, mode, skills: [{ skillId: 'vocab', score, weight: 1 }], hintLevel: 0, assisted: false,
        difficulty: 0, guessable: false, countsForMastery: true, misconceptions: [], at,
      }, factCtx).get('vocab') ?? s
    }
    for (const id of ['w1', 'w2', 'w3']) apply(id, 'practice', 1)
    expect(s.gateOpen).toBe(false)
    apply('w4', 'practice', 1)
    expect(evaluateGate(s, { deckSize: 4 }, config).unmet.join(' ')).toMatch(/checkpoint recall/)
    for (const id of ['w1', 'w2', 'w3']) apply(id, 'checkpoint', 1)
    expect(s.gateOpen).toBe(true)
    expect(s.pMastered).toBeGreaterThan(0.9)
  })
})
