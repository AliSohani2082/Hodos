/**
 * Mastery policy configuration. Hosts may tune these values; plugins cannot.
 * @module @hodos/core/mastery/config
 */
import type { GateStrictness } from '@hodos/plugin-sdk'
import { DEFAULT_BKT_PARAMS, type BktParams } from './bkt.js'
import { DEFAULT_ELO_PARAMS, type EloParams } from './elo.js'

/** Mastery thresholds and evidence rules. */
export interface MasteryConfig {
  /** BKT gate threshold θ (lenient 0.90 / standard 0.95 / strict 0.98). */
  readonly theta: number
  /** Minimum distinct items with mastery evidence before any gate opens. */
  readonly minDistinctItems: number
  /** Evidence at or above this counts as a checkpoint success. */
  readonly checkpointSuccessEvidence: number
  /** Distinct unassisted checkpoint successes required when only guessable items succeeded. */
  readonly checkpointSuccessesGuessable: number
  /** Distinct unassisted checkpoint successes required when a guess-resistant item succeeded. */
  readonly checkpointSuccessesGuessResistant: number
  /** Elo mastery index needed (0.5 ⇔ 80% success on a target item). */
  readonly eloThreshold: number
  /** Oracle posterior mean needed for performance skills. */
  readonly oracleTarget: number
  /** Distinct unassisted checkpoint successes for performance skills. */
  readonly oracleCheckpointSuccesses: number
  /** Share of a fact skill's items that must be acquired. */
  readonly factAcquiredShare: number
  /** Hint level charged to answers relayed through the tutor agent. */
  readonly relayHintLevel: number
  /** Hint level charged when the learner messaged the tutor during an attempt. */
  readonly tutorContactHintLevel: number
  /** Prerequisites whose retrievability falls below this are reviewed first. */
  readonly refreshRetrievability: number
  readonly targetRetention: number
  readonly bkt: BktParams
  readonly elo: EloParams
}

/** Map a strictness level to θ. */
export const THETA_BY_STRICTNESS: Readonly<Record<GateStrictness, number>> = {
  lenient: 0.9,
  standard: 0.95,
  strict: 0.98,
}

/** Defaults (PRD MS-1..MS-5, ADR-0005). */
export const DEFAULT_MASTERY_CONFIG: MasteryConfig = {
  theta: THETA_BY_STRICTNESS.standard,
  minDistinctItems: 3,
  checkpointSuccessEvidence: 0.8,
  checkpointSuccessesGuessable: 3,
  checkpointSuccessesGuessResistant: 1,
  eloThreshold: 0.5,
  oracleTarget: 0.8,
  oracleCheckpointSuccesses: 2,
  factAcquiredShare: 0.9,
  relayHintLevel: 3,
  tutorContactHintLevel: 2,
  refreshRetrievability: 0.7,
  targetRetention: 0.9,
  bkt: DEFAULT_BKT_PARAMS,
  elo: DEFAULT_ELO_PARAMS,
}
