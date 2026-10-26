/**
 * Elo-style estimator for `pattern` (and decision-item `judgment`) skills
 * (intelligent-tutoring.md §3.3):
 *
 *   p = σ(θ − b);  θ += K(n)·(r − p),  K(n) = 0.8 / (1 + 0.05·n)
 *   pMastered = σ(θ − b_target − logit(0.8))
 *
 * `r` is the hint-discounted evidence. Item difficulty drifts only from
 * practice evidence and freezes after 200 updates. Items are selected with a
 * lagged θ (frozen per session) to avoid adaptive-selection bias.
 * @module @hodos/core/mastery/elo
 */

/** Learner state for one skill. */
export interface EloState {
  /** Ability in logits. */
  readonly theta: number
  /** Number of updates applied. */
  readonly n: number
}

/** Calibrated difficulty of one item. */
export interface ItemCalibration {
  readonly b: number
  /** Number of practice updates applied to `b`. */
  readonly m: number
}

/** Elo configuration. */
export interface EloParams {
  /** Initial ability. */
  readonly theta0: number
  /** Target item difficulty for mastery. */
  readonly bTarget: number
  /** Probability of success on a target item that counts as mastery. */
  readonly targetSuccess: number
  /** Updates after which item difficulty freezes. */
  readonly itemFreezeAfter: number
}

/** Defaults. */
export const DEFAULT_ELO_PARAMS: EloParams = { theta0: -1, bTarget: 0, targetSuccess: 0.8, itemFreezeAfter: 200 }

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))
const logit = (p: number): number => Math.log(p / (1 - p))

/**
 * Decaying update step.
 * @param n - prior updates.
 * @returns K(n) = 0.8 / (1 + 0.05·n).
 */
export function kFactor(n: number): number {
  return 0.8 / (1 + 0.05 * n)
}

/**
 * Probability of success.
 * @param theta - learner ability.
 * @param b - item difficulty.
 * @returns σ(θ − b).
 */
export function expectedSuccess(theta: number, b: number): number {
  return sigmoid(theta - b)
}

/**
 * Apply one graded response.
 * @param state - learner state.
 * @param item - item calibration.
 * @param r - evidence in [0, 1] after the hint discount.
 * @param mode - practice updates the item; other modes do not.
 * @param params - parameters.
 * @returns the next learner state and item calibration.
 */
export function eloUpdate(
  state: EloState,
  item: ItemCalibration,
  r: number,
  mode: 'practice' | 'review' | 'checkpoint',
  params: EloParams = DEFAULT_ELO_PARAMS,
): { state: EloState; item: ItemCalibration } {
  const p = expectedSuccess(state.theta, item.b)
  const theta = state.theta + kFactor(state.n) * (r - p)
  const drift = mode === 'practice' && item.m < params.itemFreezeAfter
  return {
    state: { theta, n: state.n + 1 },
    item: drift ? { b: item.b - kFactor(item.m) * (r - p), m: item.m + 1 } : item,
  }
}

/**
 * Mastery index: σ(θ − b_target − logit(targetSuccess)). Equals 0.5 exactly
 * when the learner's success probability on a target item is `targetSuccess`.
 * @param state - learner state.
 * @param params - parameters.
 * @returns pMastered in (0, 1).
 */
export function eloPMastered(state: EloState, params: EloParams = DEFAULT_ELO_PARAMS): number {
  return sigmoid(state.theta - params.bTarget - logit(params.targetSuccess))
}

/**
 * Initial state from a prior probability of mastery (diagnostic or self-report).
 * @param prior - prior pMastered in (0, 1).
 * @param params - parameters.
 * @returns the state whose pMastered equals the prior.
 */
export function eloFromPrior(prior: number, params: EloParams = DEFAULT_ELO_PARAMS): EloState {
  const p = Math.min(0.99, Math.max(0.01, prior))
  return { theta: logit(p) + params.bTarget + logit(params.targetSuccess), n: 0 }
}

/**
 * Median of the most recent latencies.
 * @param latenciesMs - latencies in chronological order.
 * @param window - how many recent values to use (default 10).
 * @returns the median in milliseconds, or null when empty.
 */
export function recentMedian(latenciesMs: readonly number[], window = 10): number | null {
  const recent = latenciesMs.slice(-window).filter(v => Number.isFinite(v) && v >= 0).toSorted((a, b) => a - b)
  if (recent.length === 0) return null
  const mid = Math.floor(recent.length / 2)
  return recent.length % 2 === 1 ? recent[mid] ?? null : ((recent[mid - 1] ?? 0) + (recent[mid] ?? 0)) / 2
}
