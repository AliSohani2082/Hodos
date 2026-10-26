/**
 * Token-bucket limits per learner and bucket (PRD AI-5b, TM-012). Buckets
 * bound hint requests, agent notices (model usage), content generation, code
 * runs and subagent delegations, so neither a learner nor a broken plugin can
 * trigger unbounded work.
 * @module @hodos/core/limits
 */
import type { Clock } from '../clock.js'
import { HodosError } from '../errors.js'

/** One bucket's capacity and refill rate. */
export interface BucketSpec {
  readonly capacity: number
  /** Tokens added per second. */
  readonly refillPerSec: number
}

/** Named buckets. */
export type BucketName = 'hint' | 'notify' | 'generate' | 'run' | 'delegate' | 'attempt'

/** Default limits. Hosts override them through configuration. */
export const DEFAULT_LIMITS: Readonly<Record<BucketName, BucketSpec>> = {
  hint: { capacity: 12, refillPerSec: 1 / 30 },
  notify: { capacity: 6, refillPerSec: 1 / 60 },
  generate: { capacity: 20, refillPerSec: 20 / 3600 },
  run: { capacity: 30, refillPerSec: 1 / 10 },
  delegate: { capacity: 3, refillPerSec: 3 / 86_400 },
  attempt: { capacity: 60, refillPerSec: 1 },
}

/** In-process token buckets. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()

  /**
   * @param clock - time source.
   * @param limits - bucket specifications.
   */
  constructor(private readonly clock: Clock, private readonly limits: Readonly<Record<BucketName, BucketSpec>> = DEFAULT_LIMITS) {}

  /**
   * Take one token or refuse.
   * @param learnerId - the learner (or another scope key).
   * @param bucket - bucket name.
   * @throws {HodosError} `RATE_LIMITED` with `retryAfterSec` when empty.
   */
  take(learnerId: string, bucket: BucketName): void {
    if (!this.tryTake(learnerId, bucket)) {
      const spec = this.limits[bucket]
      throw new HodosError('RATE_LIMITED', `too many ${bucket} requests; try again shortly`, {
        bucket, retryAfterSec: Math.ceil(1 / spec.refillPerSec),
      })
    }
  }

  /**
   * Take one token if available.
   * @param learnerId - the learner (or another scope key).
   * @param bucket - bucket name.
   * @returns whether a token was taken.
   */
  tryTake(learnerId: string, bucket: BucketName): boolean {
    const spec = this.limits[bucket]
    const key = `${learnerId}\u0000${bucket}`
    const now = this.clock.now().getTime()
    const state = this.buckets.get(key) ?? { tokens: spec.capacity, at: now }
    const tokens = Math.min(spec.capacity, state.tokens + ((now - state.at) / 1000) * spec.refillPerSec)
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now })
      return false
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now })
    return true
  }
}
