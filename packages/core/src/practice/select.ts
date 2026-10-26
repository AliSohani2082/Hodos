/**
 * Item selection (PRD EX-6): target a practice success rate, scaffold from
 * worked to independent items as mastery grows, avoid immediate repeats and
 * repeated isomorph groups, keep checkpoint items fresh, and prefer new
 * variants in review.
 * @module @hodos/core/practice
 */
import type { ExerciseItem, ExerciseMode } from '@hodos/plugin-sdk'
import type { Random } from '../random.js'

/** History of one item for this learner. */
export interface ItemHistory {
  readonly timesSeen: number
  readonly seenInPractice: boolean
  readonly seenInCheckpoint: boolean
  readonly lastSeenAt: Date | null
}

/** Selection inputs. */
export interface SelectionRequest {
  readonly mode: ExerciseMode
  readonly candidates: readonly ExerciseItem[]
  readonly history: (itemId: string) => ItemHistory
  /** Predicted probability of success for an item (estimator-specific, lagged). */
  readonly predictedSuccess: (item: ExerciseItem) => number
  /** Current mastery index, for scaffolding. */
  readonly mastery: number
  /** Item ids presented most recently, newest first. */
  readonly recentItemIds: readonly string[]
  /** Isomorph group of the most recent presentation. */
  readonly lastGroup?: string
  /** Items that must not be chosen (e.g. already in this checkpoint). */
  readonly exclude?: ReadonlySet<string>
  /** Target success band for practice. */
  readonly target?: number
  readonly rng: Random
  /** Prefer easier, scaffolded items (remedial work). */
  readonly remedial?: boolean
}

/**
 * Choose one item, or null when no candidate supports the mode.
 * @param req - selection inputs.
 * @returns the chosen item.
 */
export function selectItem(req: SelectionRequest): ExerciseItem | null {
  const exclude = req.exclude ?? new Set<string>()
  let pool = req.candidates.filter(i => i.modes.includes(req.mode) && !exclude.has(i.id))
  if (pool.length === 0) return null
  const recent = new Set(req.recentItemIds.slice(0, 3))
  const notRecent = pool.filter(i => !recent.has(i.id) && (req.lastGroup === undefined || (i.isomorphGroup ?? i.id) !== req.lastGroup))
  if (notRecent.length > 0) pool = notRecent

  if (req.mode === 'checkpoint') {
    const fresh = pool.filter(i => !req.history(i.id).seenInPractice && !req.history(i.id).seenInCheckpoint)
    if (fresh.length > 0) pool = fresh
    else {
      const unusedInCheckpoint = pool.filter(i => !req.history(i.id).seenInCheckpoint)
      if (unusedInCheckpoint.length > 0) pool = unusedInCheckpoint
    }
  }
  if (req.mode === 'review' || req.mode === 'diagnostic') {
    const unseen = pool.filter(i => req.history(i.id).timesSeen === 0)
    if (unseen.length > 0) pool = unseen
  }

  const target = req.target ?? 0.75
  const scaffoldWanted = req.remedial === true || req.mastery < 0.4 ? ['worked', 'faded'] : ['independent']
  let best: ExerciseItem | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const item of pool) {
    const p = req.predictedSuccess(item)
    const h = req.history(item.id)
    let score = req.mode === 'diagnostic' ? Math.abs(item.difficulty) : Math.abs(p - (req.remedial === true ? 0.85 : target))
    score += 0.15 * Math.min(h.timesSeen, 5)
    if (item.scaffold !== undefined && req.mode === 'practice' && !scaffoldWanted.includes(item.scaffold)) score += 0.1
    score += req.rng.next() * 0.05
    if (score < bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}
