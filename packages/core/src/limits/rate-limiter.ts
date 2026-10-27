/**
 * Token-bucket limits per learner and bucket (PRD AI-5b, TM-012). Buckets
 * bound model-written course proposals and subagent delegations, so neither
 * a learner nor a broken plugin can trigger unbounded work. (The model calls
 * of learning sessions have their own daily budget in the knowledge service.)
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
export type BucketName = 'generate' | 'delegate'

/** Default limits. Hosts override them through configuration. */
export const DEFAULT_LIMITS: Readonly<Record<BucketName, BucketSpec>> = {
  generate: { capacity: 20, refillPerSec: 20 / 3600 },
  delegate: { capacity: 3, refillPerSec: 3 / 86_400 },
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
