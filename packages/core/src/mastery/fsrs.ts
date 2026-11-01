/**
 * FSRS-6 scheduling through `ts-fsrs` (5.4.2) at the memory-state level, so
 * skill cards can enter Review state directly when a gate opens (ADR-0005).
 * Day-granular, fuzz disabled for reproducibility; parity with the M0 fixture
 * is tested.
 * @module @hodos/core/mastery/fsrs
 */
import { fsrs, type FSRS } from 'ts-fsrs'

/** FSRS grades. */
export type FsrsGrade = 1 | 2 | 3 | 4

/** Persisted memory state of one card (a skill or a fact item). */
export interface MemoryCard {
  readonly stability: number
  readonly difficulty: number
  /** ISO time of the last review. */
  readonly lastReview: string
  /** ISO time the next review is due. */
  readonly due: string
  readonly reps: number
  readonly lapses: number
}

const DAY_MS = 86_400_000

/**
 * Whole days between two instants, floored, never negative.
 * @param from - earlier time.
 * @param to - later time.
 * @returns elapsed days.
 */
export function elapsedDays(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS))
}

/** FSRS scheduler for skill and item cards. */
export class FsrsScheduler {
  private readonly engine: FSRS

  /**
   * @param targetRetention - requested retention in [0.80, 0.97]; default 0.90.
   * @throws {RangeError} when the retention is outside the accepted range.
   */
  constructor(readonly targetRetention = 0.9) {
    if (!(targetRetention >= 0.8 && targetRetention <= 0.97)) {
      throw new RangeError(`target retention ${targetRetention} outside [0.80, 0.97]`)
    }
    this.engine = fsrs({ request_retention: targetRetention, enable_fuzz: false })
  }

  /**
   * Apply one review.
   * @param card - current card, or null for a first review.
   * @param grade - FSRS grade.
   * @param now - review time.
   * @returns the next card.
   */
  review(card: MemoryCard | null, grade: FsrsGrade, now: Date): MemoryCard {
    const elapsed = card === null ? 0 : elapsedDays(new Date(card.lastReview), now)
    const memory = card === null ? null : { stability: card.stability, difficulty: card.difficulty }
    const next = this.engine.next_state(memory, elapsed, grade)
    // Fuzz is disabled, so the elapsed-days argument does not change the interval.
    const interval = Math.max(1, this.engine.next_interval(next.stability, 0))
    return {
      stability: next.stability,
      difficulty: next.difficulty,
      lastReview: now.toISOString(),
      due: new Date(now.getTime() + interval * DAY_MS).toISOString(),
      reps: (card?.reps ?? 0) + 1,
      lapses: (card?.lapses ?? 0) + (grade === 1 && card !== null ? 1 : 0),
    }
  }

  /**
   * Interval in days the scheduler would assign for a stability.
   * @param stability - memory stability in days.
   * @param elapsed - days since the last review.
   * @returns whole days.
   */
  interval(stability: number, elapsed = 0): number {
    return this.engine.next_interval(stability, elapsed)
  }

  /**
   * Retrievability R(now): the predicted probability of recall.
   * @param card - the card.
   * @param now - evaluation time.
   * @returns R in (0, 1].
   */
  retrievability(card: MemoryCard, now: Date): number {
    return this.engine.forgetting_curve(elapsedDays(new Date(card.lastReview), now), card.stability)
  }
}

/** Facts used to grade one retrieval for FSRS. */
export interface RetrievalFacts {
  /** Evidence after the hint discount, in [0, 1]. */
  readonly evidence: number
  /** Whether any assistance was used (hint, tutor contact, relayed answer). */
  readonly assisted: boolean
  /** Whether the bottom-out hint was used. */
  readonly bottomOut: boolean
  /** Response time over the item's expected time, when known. */
  readonly speedRatio?: number
  /** Learner's self-rating before grading. */
  readonly confidence?: 'sure' | 'unsure'
}

/**
 * Map a graded retrieval to an FSRS grade (intelligent-tutoring.md §3.5):
 * e < 0.5 or bottom-out → Again; assisted correct → Hard; correct → Good;
 * correct, fast (< 0.5 × expected) and rated `sure` → Easy.
 * @param facts - the retrieval.
 * @returns the FSRS grade.
 */
export function gradeRetrieval(facts: RetrievalFacts): FsrsGrade {
  if (facts.evidence < 0.5 || facts.bottomOut) return 1
  if (facts.assisted) return 2
  if (facts.speedRatio !== undefined && facts.speedRatio < 0.5 && facts.confidence === 'sure') return 4
  return 3
}
