// Aggregation, cluster bootstrap over tasks, and the §8.5 keep/switch decision rules (K1-K6, rules 1-5).
import { scoreGeneration, type GenRecord, type Scores } from './score.ts'
import { TASKS } from './tasks.ts'
import type { Arm, Model, Task } from './types.ts'

export interface Scored {
  rec: GenRecord
  task: Task
  s: Scores
}

export function scoreAll(recs: GenRecord[], tasks: Task[] = TASKS): Scored[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return recs
    .filter((r) => r.status === 'ok' && r.rounds.length > 0)
    .map((rec) => ({ rec, task: byId.get(rec.taskId)!, s: scoreGeneration(rec, byId.get(rec.taskId)!) }))
}

export type Metric = keyof Scores

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

export function cellMean(scored: Scored[], model: Model, arm: Arm, metric: Metric): number {
  return mean(scored.filter((x) => x.rec.model === model && x.rec.arm === arm).map((x) => x.s[metric]))
}
export const cellN = (scored: Scored[], model: Model, arm: Arm) => scored.filter((x) => x.rec.model === model && x.rec.arm === arm).length

/** Deterministic RNG so the bootstrap is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Interval {
  mean: number
  lo: number
  hi: number
  tasks: number
}

/**
 * Paired difference (Arm D minus Arm M) of a metric for one model: tasks are the resampling unit, because the
 * samples of a task are not independent. 95% percentile interval.
 */
export function pairedDiffBy(scored: Scored[], model: Model, get: (x: Scored) => number | undefined, opts: { b?: number; seed?: number; sign?: 1 | -1 } = {}): Interval {
  const { b = 10000, seed = 1, sign = 1 } = opts
  const perTask = new Map<string, { m: number[]; d: number[] }>()
  for (const x of scored) {
    if (x.rec.model !== model) continue
    const v = get(x)
    if (v === undefined || Number.isNaN(v)) continue
    const e = perTask.get(x.task.id) ?? { m: [], d: [] }
    ;(x.rec.arm === 'markdoc' ? e.m : e.d).push(v)
    perTask.set(x.task.id, e)
  }
  const diffs = [...perTask.values()].filter((e) => e.m.length && e.d.length).map((e) => sign * (mean(e.d) - mean(e.m)))
  if (!diffs.length) return { mean: NaN, lo: NaN, hi: NaN, tasks: 0 }
  const rnd = mulberry32(seed)
  const boots: number[] = []
  for (let i = 0; i < b; i++) {
    let sum = 0
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rnd() * diffs.length)]!
    boots.push(sum / diffs.length)
  }
  boots.sort((a, c) => a - c)
  return { mean: mean(diffs), lo: boots[Math.floor(0.025 * b)]!, hi: boots[Math.min(b - 1, Math.floor(0.975 * b))]!, tasks: diffs.length }
}

/** D minus M for a built-in metric (sign -1 gives M minus D). */
export const pairedDiff = (scored: Scored[], model: Model, metric: Metric, opts: { b?: number; seed?: number; sign?: 1 | -1 } = {}) =>
  pairedDiffBy(scored, model, (x) => x.s[metric], opts)

// ---------- decision rules ----------

export const PRIMARY: Model[] = ['claude-opus-5-5', 'claude-sonnet-5-5']

/** §8.5 thresholds. These are the spec author's proposal; adjust before the run, not after. */
export const THRESHOLDS = {
  K1_finalValid: 0.97,
  K2_firstPass: 0.8,
  K3_repairRounds: 0.6,
  K4_dropped: 0.01,
  K5_m2: 0.05,
  K5_m1: 0.1,
  K6_q1: -0.2,
  K6_q1lo: -0.3,
  K6_prefLo: 0.35,
  K6_prefHi: 0.65,
  SWITCH_m1: 0.08,
  SWITCH_m2: 0.03,
}

export interface Quality {
  /** Q1 judge score difference, Arm M minus Arm D, per model. */
  q1: Partial<Record<Model, Interval>>
  /** Q2 human preference for Arm M among decided pairs, 0..1. */
  q2prefM?: number
}

export interface Check {
  id: string
  label: string
  model?: Model
  arm?: Arm
  value: number | string
  pass: boolean | null // null = not evaluated
}

export interface ArmGate {
  pass: boolean
  checks: Check[]
}

function armGate(scored: Scored[], model: Model, arm: Arm): ArmGate {
  const T = THRESHOLDS
  const v = (m: Metric) => cellMean(scored, model, arm, m)
  const checks: Check[] = [
    { id: 'K1', label: 'final valid (M2) >= 97%', model, arm, value: v('m2'), pass: v('m2') >= T.K1_finalValid },
    { id: 'K2', label: 'first-pass valid (M1) >= 80%', model, arm, value: v('m1'), pass: v('m1') >= T.K2_firstPass },
    { id: 'K3', label: 'mean repair rounds (M3) <= 0.6', model, arm, value: v('m3'), pass: v('m3') <= T.K3_repairRounds },
    { id: 'K4', label: 'dropped-block rate (M4) <= 1%', model, arm, value: v('m4'), pass: v('m4') <= T.K4_dropped },
  ]
  return { pass: checks.every((c) => c.pass), checks }
}

export type Verdict = 'keep' | 'iterate' | 'switch' | 'reconsider' | 'incomplete'

export interface Decision {
  verdict: Verdict
  rule: number
  reason: string
  gates: Record<string, ArmGate>
  relative: Check[]
  quality: Check[]
  diffs: Record<string, Interval>
}

export function decide(scored: Scored[], opts: { quality?: Quality; iterationUsed?: boolean; primary?: Model[] } = {}): Decision {
  const T = THRESHOLDS
  const primary = opts.primary ?? PRIMARY
  const gates: Record<string, ArmGate> = {}
  const diffs: Record<string, Interval> = {}
  const relative: Check[] = []
  const quality: Check[] = []
  const missing = primary.filter((m) => (['markdoc', 'directive'] as Arm[]).some((a) => cellN(scored, m, a) === 0))
  if (missing.length)
    return { verdict: 'incomplete', rule: 0, reason: `no data for ${missing.join(', ')}`, gates, relative, quality, diffs }

  for (const model of primary) {
    for (const arm of ['markdoc', 'directive'] as Arm[]) gates[`${model}/${arm}`] = armGate(scored, model, arm)
    const d1 = (diffs[`${model}/m1`] = pairedDiff(scored, model, 'm1'))
    const d2 = (diffs[`${model}/m2`] = pairedDiff(scored, model, 'm2'))
    relative.push(
      { id: 'K5a', label: 'upper 95% bound of (D - M) on M2 <= 5pp', model, value: d2.hi, pass: d2.hi <= T.K5_m2 },
      { id: 'K5b', label: 'upper 95% bound of (D - M) on M1 <= 10pp', model, value: d1.hi, pass: d1.hi <= T.K5_m1 },
    )
    const q = opts.quality?.q1[model]
    quality.push(
      q
        ? { id: 'K6a', label: 'Q1 mean (M - D) >= -0.2 and lower bound >= -0.3', model, value: q.mean, pass: q.mean >= T.K6_q1 && q.lo >= T.K6_q1lo }
        : { id: 'K6a', label: 'Q1 mean (M - D) >= -0.2 and lower bound >= -0.3', model, value: 'not measured', pass: null },
    )
  }
  const pref = opts.quality?.q2prefM
  quality.push({
    id: 'K6b', label: 'Q2 preference within 35% to 65% (tie)',
    value: pref ?? 'not measured', pass: pref === undefined ? null : pref >= T.K6_prefLo && pref <= T.K6_prefHi,
  })

  const mPass14 = primary.every((m) => gates[`${m}/markdoc`]!.pass)
  const dPass14 = primary.every((m) => gates[`${m}/directive`]!.pass)
  const anyBothFail = primary.some((m) => !gates[`${m}/markdoc`]!.pass && !gates[`${m}/directive`]!.pass)

  // Rule 5: both arms fail K1-K4.
  if (!mPass14 && !dPass14 && anyBothFail)
    return { verdict: 'reconsider', rule: 5, reason: 'both arms fail K1-K4 on a primary model: stop and reconsider (third arm, or JSON blocks for the exercise envelope only)', gates, relative, quality, diffs }

  // Rule 1: all of K1-K6 hold on both primary models.
  const rel = relative.every((c) => c.pass)
  const qual = quality.filter((c) => c.pass !== null)
  const qualAll = quality.every((c) => c.pass !== null)
  if (mPass14 && rel && qualAll && qual.every((c) => c.pass))
    return { verdict: 'keep', rule: 1, reason: 'K1-K6 all hold on both primary models', gates, relative, quality, diffs }

  // Rule 2: K1-K4 fail on Arm M only -> one prompt iteration.
  if (!mPass14 && !opts.iterationUsed)
    return { verdict: 'iterate', rule: 2, reason: 'Arm M fails K1-K4 on a primary model: one prompt iteration is allowed (edit guidance and examples, re-run the failing tasks, about $20), then re-decide', gates, relative, quality, diffs }

  // Rule 3: switch if D passes K1-K4 and beats M by margins on both primaries, interval excluding 0.
  const beats = primary.every((m) => {
    const a = diffs[`${m}/m1`]!
    const b = diffs[`${m}/m2`]!
    return a.mean >= T.SWITCH_m1 && a.lo > 0 && b.mean >= T.SWITCH_m2 && b.lo > 0
  })
  if (dPass14 && beats)
    return { verdict: 'switch', rule: 3, reason: 'Arm D passes K1-K4 and beats Arm M by >= 8pp on M1 and >= 3pp on M2 on both primary models, intervals excluding 0', gates, relative, quality, diffs }

  // Rule 4: ties and mixed results keep Markdoc.
  const caveats = [!mPass14 ? 'Arm M still misses K1-K4 after the allowed iteration' : '', !qualAll ? 'quality checks (K6) not all measured' : '', !rel ? 'K5 not met' : '']
    .filter(Boolean)
    .join('; ')
  return { verdict: 'keep', rule: 4, reason: `ties and mixed results keep Markdoc${caveats ? ` (note: ${caveats})` : ''}`, gates, relative, quality, diffs }
}
