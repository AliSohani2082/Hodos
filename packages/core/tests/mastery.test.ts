import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BKT_PARAMS,
  FsrsScheduler,
  bktUpdate,
  bktUpdateMulti,
  gradeRetrieval,
  type BktMode,
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
