/**
 * Structured errors raised by the core. Messages are safe to show to a
 * learner or a model: they never contain answer keys or other learners' data.
 * @module @hodos/core/errors
 */
import { unreachable } from '@hodos/plugin-sdk'

/** Error codes. Hosts map them to HTTP statuses and tool results. */
export type HodosErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'POLICY_DENIED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'CONFLICT'
  | 'INTERNAL'

/** A typed failure with a stable code and optional safe details. */
export class HodosError extends Error {
  override readonly name = 'HodosError'

  /**
   * @param code - stable error code.
   * @param message - learner- and model-safe explanation.
   * @param details - optional safe structured context.
   */
  constructor(
    readonly code: HodosErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message)
  }
}

/**
 * Map an error code to an HTTP status.
 * @param code - the error code.
 * @returns the matching HTTP status.
 */
export function httpStatusOf(code: HodosErrorCode): number {
  switch (code) {
    case 'NOT_FOUND': return 404
    case 'FORBIDDEN': return 403
    case 'INVALID_INPUT': return 400
    case 'INVALID_STATE': return 409
    case 'CONFLICT': return 409
    case 'POLICY_DENIED': return 403
    case 'RATE_LIMITED': return 429
    case 'UNAVAILABLE': return 503
    case 'INTERNAL': return 500
    default: return unreachable(code, 'error code')
  }
}
