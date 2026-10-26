/**
 * Oracle estimator for `performance` skills graded by deterministic oracles
 * (tests, rule engines, verified move sequences). Mastery is the posterior
 * mean of a Beta(1, 1) success rate over recent unassisted attempts, and the
 * lower credible bound is reported as confidence.
 * @module @hodos/core/mastery/oracle
 */

/** Learner state for one skill. */
export interface OracleState {
  /** Recent unassisted outcomes, oldest first (window of 20). */
  readonly outcomes: readonly number[]
}

/** Window of outcomes kept. */
export const ORACLE_WINDOW = 20

/**
 * Record one outcome.
 * @param state - current state.
 * @param evidence - hint-discounted evidence in [0, 1].
 * @returns the next state.
 */
export function oracleUpdate(state: OracleState, evidence: number): OracleState {
  return { outcomes: [...state.outcomes, Math.min(1, Math.max(0, evidence))].slice(-ORACLE_WINDOW) }
}

/**
 * Posterior mean success rate under a Beta(a, b) prior.
 * @param state - the state.
 * @param prior - pseudo-counts `[successes, failures]`; default `[1, 1]`.
 * @returns the mean in (0, 1).
 */
export function oraclePMastered(state: OracleState, prior: readonly [number, number] = [1, 1]): number {
  const s = state.outcomes.reduce((a, b) => a + b, 0)
  const n = state.outcomes.length
  return (s + prior[0]) / (n + prior[0] + prior[1])
}

/**
 * Approximate lower bound (mean − 1 sd) of the Beta posterior.
 * @param state - the state.
 * @returns the bound, clamped to [0, 1].
 */
export function oracleLowerBound(state: OracleState): number {
  const s = state.outcomes.reduce((a, b) => a + b, 0)
  const a = s + 1
  const b = state.outcomes.length - s + 1
  const mean = a / (a + b)
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)))
  return Math.min(1, Math.max(0, mean - sd))
}

/**
 * Initial state carrying a prior as pseudo-outcomes (at most two, so the
 * diagnostic cannot stand in for real attempts).
 * @param prior - prior success rate in [0, 1].
 * @returns the state.
 */
export function oracleFromPrior(prior: number): OracleState {
  return prior >= 0.5 ? { outcomes: [Math.min(1, prior)] } : { outcomes: [] }
}
