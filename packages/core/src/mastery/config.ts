/**
 * Mastery thresholds. Hosts choose one with their strictness setting;
 * plugins cannot change it.
 * @module @hodos/core/mastery/config
 */
import type { GateStrictness } from '@hodos/plugin-sdk'

/** The mastery threshold θ of each strictness level. */
export const THETA_BY_STRICTNESS: Readonly<Record<GateStrictness, number>> = {
  lenient: 0.9,
  standard: 0.95,
  strict: 0.98,
}

/** The default threshold (standard strictness). */
export const DEFAULT_THETA = THETA_BY_STRICTNESS.standard
