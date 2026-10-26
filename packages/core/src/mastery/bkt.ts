/**
 * BKT-lite for `concept` and `procedure` skills: a line-by-line port of the
 * M0 reference (`spikes/m0-mastery-sim/mastery_sim/bkt_lite.py`, ADR-0005),
 * verified against its golden vectors.
 *
 * - difficulty-adjusted guess/slip: g = σ(logit(g0) − b), s = σ(logit(s0) + b)
 * - soft evidence with the hint discount: e = x · (1 − h)
 * - Jeffrey mixture: P_obs = e·post_c + (1 − e)·post_w
 * - transition: P_next = P_obs + (1 − P_obs)·T·λ_mode (practice 1, review 0.5, checkpoint 0)
 * - conjunctive multi-skill blame ∝ w_k · (1 − P_k)
 *
 * `P(L)` is an evidence index, not a calibrated probability (ADR-0005).
 * @module @hodos/core/mastery/bkt
 */

/** Modes that update BKT. Diagnostic answers initialize priors instead. */
export type BktMode = 'practice' | 'review' | 'checkpoint'

/** BKT-lite parameters (defaults from intelligent-tutoring.md §3.2). */
export interface BktParams {
  readonly p0: number
  readonly T: number
  readonly s0: number
  readonly g0: number
  readonly maxHintLevel: number
  readonly lambda: Readonly<Record<BktMode, number>>
}

/** Default parameters. */
export const DEFAULT_BKT_PARAMS: BktParams = {
  p0: 0.1,
  T: 0.15,
  s0: 0.1,
  g0: 0.15,
  maxHintLevel: 5,
  lambda: { practice: 1.0, review: 0.5, checkpoint: 0.0 },
}

/** P is clamped away from 0 and 1 so Bayes' rule can always move it. */
export const P_EPS = 1e-4

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))
const logit = (p: number): number => Math.log(p / (1 - p))

/**
 * Clamp a probability into [P_EPS, 1 − P_EPS].
 * @param p - probability.
 * @returns the clamped value.
 */
export function clampP(p: number): number {
  return Math.min(1 - P_EPS, Math.max(P_EPS, p))
}

/**
 * Guess and slip for an item.
 * @param params - BKT parameters; `g0` may be raised for choice items.
 * @param b - item difficulty in logits.
 * @returns `[guess, slip]`.
 */
export function itemGuessSlip(params: BktParams, b: number): [number, number] {
  return [sigmoid(logit(params.g0) - b), sigmoid(logit(params.s0) + b)]
}

/**
 * Guess floor for a choice item with `k` options: max(0.15, 1/k).
 * @param base - base guess parameter.
 * @param options - number of options, when the item is a choice item.
 * @returns the guess parameter to use.
 */
export function guessFor(base: number, options?: number): number {
  return options !== undefined && options > 0 ? Math.max(base, 1 / options) : base
}

/**
 * Hint fraction h in [0, 1]: highest hint level used over the ladder length.
 * @param hintLevel - highest level used (0 = none).
 * @param maxLevel - ladder length.
 * @returns the fraction; the bottom-out hint gives 1.
 * @throws {RangeError} when the level is outside 0..maxLevel.
 */
export function hintFraction(hintLevel: number, maxLevel: number): number {
  if (!Number.isInteger(hintLevel) || hintLevel < 0 || hintLevel > maxLevel) {
    throw new RangeError(`hint level ${hintLevel} outside 0..${maxLevel}`)
  }
  return hintLevel / maxLevel
}

/**
 * Evidence of unaided success.
 * @param x - graded score in [0, 1].
 * @param h - hint fraction in [0, 1].
 * @returns e = x · (1 − h).
 * @throws {RangeError} when x is outside [0, 1].
 */
export function evidence(x: number, h: number): number {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`score ${x} outside [0, 1]`)
  return x * (1 - h)
}

/**
 * Posterior of "knows the skill" after a correct and after a wrong answer.
 * @param p - prior P(L).
 * @param g - guess.
 * @param s - slip.
 * @returns `[postCorrect, postWrong]`.
 */
export function posteriors(p: number, g: number, s: number): [number, number] {
  const postC = (p * (1 - s)) / (p * (1 - s) + (1 - p) * g)
  const postW = (p * s) / (p * s + (1 - p) * (1 - g))
  return [postC, postW]
}

/** One observation fed to the estimator. */
export interface BktObservation {
  /** Graded score in [0, 1]. */
  readonly x: number
  /** Highest hint level used before the answer (0..maxHintLevel). */
  readonly hintLevel: number
  /** Item difficulty in logits. */
  readonly b: number
  readonly mode: BktMode
  /** Number of options for a choice item; raises the guess floor. */
  readonly options?: number
}

function paramsFor(params: BktParams, options?: number): BktParams {
  return options === undefined ? params : { ...params, g0: guessFor(params.g0, options) }
}

/**
 * One observation on a single skill.
 * @param p - current P(L).
 * @param obs - the observation.
 * @param params - parameters.
 * @returns the new P(L).
 */
export function bktUpdate(p: number, obs: BktObservation, params: BktParams = DEFAULT_BKT_PARAMS): number {
  const prm = paramsFor(params, obs.options)
  const pc = clampP(p)
  const [g, s] = itemGuessSlip(prm, obs.b)
  const e = evidence(obs.x, hintFraction(obs.hintLevel, prm.maxHintLevel))
  const [postC, postW] = posteriors(pc, g, s)
  const pObs = e * postC + (1 - e) * postW
  return clampP(pObs + (1 - pObs) * prm.T * prm.lambda[obs.mode])
}

/**
 * Conjunctive blame shares for a failed multi-skill item.
 * @param p - current P(L) per skill.
 * @param skills - `[skillId, weight]` pairs.
 * @returns normalized shares ∝ w_k · (1 − P_k).
 */
export function blameShares(p: Readonly<Record<string, number>>, skills: ReadonlyArray<readonly [string, number]>): Record<string, number> {
  const raw = skills.map(([k, w]) => [k, w * (1 - clampP(p[k] ?? DEFAULT_BKT_PARAMS.p0))] as const)
  const total = raw.reduce((sum, [, v]) => sum + v, 0)
  return Object.fromEntries(raw.map(([k, v]) => [k, total > 0 ? v / total : 1 / raw.length]))
}

/**
 * One observation on an item tagged with several weighted skills. Success
 * moves each skill toward its correct-posterior by its weight; failure moves
 * each toward its wrong-posterior by its blame share. The transition is
 * scaled by the skill weight. With one skill of weight 1 this equals {@link bktUpdate}.
 * @param p - current P(L) per skill (missing skills start at p0).
 * @param skills - `[skillId, weight]` pairs, weights in (0, 1].
 * @param obs - the observation.
 * @param params - parameters.
 * @returns the updated map (skills not tagged are carried over).
 * @throws {RangeError} for a weight outside (0, 1].
 */
export function bktUpdateMulti(
  p: Readonly<Record<string, number>>,
  skills: ReadonlyArray<readonly [string, number]>,
  obs: BktObservation,
  params: BktParams = DEFAULT_BKT_PARAMS,
): Record<string, number> {
  for (const [, w] of skills) if (!(w > 0 && w <= 1)) throw new RangeError(`skill weight ${w} outside (0, 1]`)
  const prm = paramsFor(params, obs.options)
  const [g, s] = itemGuessSlip(prm, obs.b)
  const e = evidence(obs.x, hintFraction(obs.hintLevel, prm.maxHintLevel))
  const blame = blameShares(p, skills)
  const out: Record<string, number> = { ...p }
  for (const [k, w] of skills) {
    const pk = clampP(p[k] ?? prm.p0)
    const [postC, postW] = posteriors(pk, g, s)
    const success = pk + w * (postC - pk)
    const failure = pk + (blame[k] ?? 0) * (postW - pk)
    const pObs = e * success + (1 - e) * failure
    out[k] = clampP(pObs + (1 - pObs) * prm.T * prm.lambda[obs.mode] * w)
  }
  return out
}
