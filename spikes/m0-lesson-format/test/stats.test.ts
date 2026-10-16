import { describe, expect, test } from 'bun:test'
import type { GenRecord, Scores } from '../src/score.ts'
import { decide, pairedDiff, type Scored } from '../src/stats.ts'
import type { Arm, Model, Task } from '../src/types.ts'

const base: Scores = {
  m1: 1, m2: 1, m3: 0, m4: 0, m4silent: 0, m5first: 1, m6first: 0, m7: 3000,
  checklist: 1, literals: 1, nesting: 1, firstDiagnostics: 0,
}

/** n tasks; for each (model, arm) the first `fail1` tasks fail first pass, the first `fail2` of those never recover. */
function synth(rates: Partial<Record<`${Model}/${Arm}`, { fail1: number; fail2: number; dropped?: number }>>, n = 36): Scored[] {
  const out: Scored[] = []
  const models: Model[] = ['claude-opus-5-5', 'claude-sonnet-5-5']
  for (const model of models)
    for (const arm of ['markdoc', 'directive'] as Arm[])
      for (let t = 0; t < n; t++) {
        const r = rates[`${model}/${arm}`] ?? { fail1: 0, fail2: 0 }
        const failed1 = t < r.fail1
        const failed2 = t < r.fail2
        const s: Scores = { ...base, m1: failed1 ? 0 : 1, m2: failed2 ? 0 : 1, m3: failed2 ? 3 : failed1 ? 1 : 0, m4: t < (r.dropped ?? 0) ? 1 : 0 }
        for (let k = 1; k <= 3; k++)
          out.push({ rec: { model, arm, taskId: `t${t}`, sample: k } as GenRecord, task: { id: `t${t}` } as Task, s })
      }
  return out
}

describe('paired cluster bootstrap', () => {
  test('identical arms give a zero difference with an interval around zero', () => {
    const d = pairedDiff(synth({}), 'claude-opus-5-5', 'm1')
    expect(d.mean).toBe(0)
    expect(d.lo).toBe(0)
    expect(d.hi).toBe(0)
    expect(d.tasks).toBe(36)
  })
  test('a consistent gap has an interval that excludes zero', () => {
    const d = pairedDiff(synth({ 'claude-opus-5-5/markdoc': { fail1: 12, fail2: 0 } }), 'claude-opus-5-5', 'm1')
    expect(d.mean).toBeCloseTo(12 / 36, 5) // D - M = +33pp
    expect(d.lo).toBeGreaterThan(0.1)
  })
  test('deterministic', () => {
    const s = synth({ 'claude-opus-5-5/markdoc': { fail1: 5, fail2: 1 } })
    expect(pairedDiff(s, 'claude-opus-5-5', 'm1')).toEqual(pairedDiff(s, 'claude-opus-5-5', 'm1'))
  })
})

describe('decision rules (§8.5)', () => {
  test('rule 1: both pass everything -> keep (needs quality data)', () => {
    const quality = { q1: { 'claude-opus-5-5': { mean: -0.05, lo: -0.15, hi: 0.05, tasks: 36 }, 'claude-sonnet-5-5': { mean: 0, lo: -0.1, hi: 0.1, tasks: 36 } }, q2prefM: 0.5 }
    const d = decide(synth({}), { quality })
    expect(d.verdict).toBe('keep')
    expect(d.rule).toBe(1)
  })
  test('without quality data rule 1 cannot be asserted, but good Markdoc still keeps (rule 4) with a note', () => {
    const d = decide(synth({}))
    expect(d.verdict).toBe('keep')
    expect(d.rule).toBe(4)
    expect(d.reason).toContain('quality checks')
  })
  test('rule 2: Arm M fails K1-K4 only -> one prompt iteration', () => {
    const d = decide(synth({ 'claude-sonnet-5-5/markdoc': { fail1: 12, fail2: 3 } }))
    expect(d.verdict).toBe('iterate')
    expect(d.rule).toBe(2)
  })
  test('rule 3: after the iteration, D clearly better and passing -> switch', () => {
    const rates = {
      'claude-opus-5-5/markdoc': { fail1: 12, fail2: 6 },
      'claude-sonnet-5-5/markdoc': { fail1: 12, fail2: 6 },
    }
    const d = decide(synth(rates), { iterationUsed: true })
    expect(d.verdict).toBe('switch')
    expect(d.rule).toBe(3)
  })
  test('rule 3 demands an interval that excludes 0: 3 of 36 tasks is a point estimate, not evidence', () => {
    const rates = {
      'claude-opus-5-5/markdoc': { fail1: 10, fail2: 3 },
      'claude-sonnet-5-5/markdoc': { fail1: 10, fail2: 3 },
    }
    const d = decide(synth(rates), { iterationUsed: true })
    expect(d.diffs['claude-opus-5-5/m2']!.mean).toBeGreaterThanOrEqual(0.03)
    expect(d.diffs['claude-opus-5-5/m2']!.lo).toBe(0)
    expect(d.verdict).toBe('keep')
    expect(d.rule).toBe(4)
  })
  test('rule 3 needs both primary models: one model showing no gap blocks the switch', () => {
    const d = decide(synth({ 'claude-opus-5-5/markdoc': { fail1: 10, fail2: 3 } }), { iterationUsed: true })
    expect(d.verdict).toBe('keep')
    expect(d.rule).toBe(4)
  })
  test('rule 4: ties keep Markdoc', () => {
    const d = decide(synth({ 'claude-opus-5-5/markdoc': { fail1: 2, fail2: 0 }, 'claude-opus-5-5/directive': { fail1: 2, fail2: 0 } }))
    expect(d.verdict).toBe('keep')
  })
  test('rule 5: both arms fail K1-K4 -> reconsider', () => {
    const bad = { fail1: 20, fail2: 8 }
    const d = decide(synth({ 'claude-opus-5-5/markdoc': bad, 'claude-opus-5-5/directive': bad }), { iterationUsed: true })
    expect(d.verdict).toBe('reconsider')
    expect(d.rule).toBe(5)
  })
  test('K4: a few silent drops fail the Markdoc gate', () => {
    const d = decide(synth({ 'claude-opus-5-5/markdoc': { fail1: 0, fail2: 0, dropped: 3 } }))
    expect(d.gates['claude-opus-5-5/markdoc']!.checks.find((c) => c.id === 'K4')!.pass).toBe(false)
    expect(d.verdict).toBe('iterate')
  })
  test('K5: a gap that is not yet decisive but whose upper bound passes 10pp blocks rule 1', () => {
    const quality = { q1: { 'claude-opus-5-5': { mean: 0, lo: -0.1, hi: 0.1, tasks: 36 }, 'claude-sonnet-5-5': { mean: 0, lo: -0.1, hi: 0.1, tasks: 36 } }, q2prefM: 0.5 }
    const d = decide(synth({ 'claude-opus-5-5/markdoc': { fail1: 7, fail2: 0 } }), { quality })
    expect(d.relative.find((c) => c.id === 'K5b' && c.model === 'claude-opus-5-5')!.pass).toBe(false)
    expect(d.rule).not.toBe(1)
  })
  test('missing data is reported as incomplete, not a verdict', () => {
    const d = decide(synth({}).filter((x) => x.rec.model !== 'claude-sonnet-5-5'))
    expect(d.verdict).toBe('incomplete')
  })
})
