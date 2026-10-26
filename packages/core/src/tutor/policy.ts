/**
 * Platform-enforced tutor policy per mode (intelligent-tutoring.md §5.2, PRD
 * EX-2/EX-3). Plugins and presets cannot loosen these rules; presets may
 * only lower the practice hint ceiling.
 * @module @hodos/core/tutor/policy
 */
import type { ExerciseMode } from '@hodos/plugin-sdk'
import { HodosError } from '../errors.js'

/** What a mode allows. */
export interface ModePolicy {
  /** Highest hint level available (0 = no hints). */
  readonly maxHintLevel: number
  /** What the learner sees right after an answer. */
  readonly feedback: 'full' | 'score-only' | 'none'
  /** When the worked explanation is released. */
  readonly explanation: 'after-grade' | 'after-session' | 'never'
  /** Submissions allowed per presentation. */
  readonly attemptsPerItem: number
  /** Whether grader feedback text is passed through. */
  readonly graderFeedback: boolean
  /** Whether the conversational tutor may help with the active item. */
  readonly tutorMayHelp: boolean
}

/** Fixed policy table. */
export const MODE_POLICY: Readonly<Record<ExerciseMode, ModePolicy>> = {
  diagnostic: { maxHintLevel: 0, feedback: 'none', explanation: 'never', attemptsPerItem: 1, graderFeedback: false, tutorMayHelp: false },
  practice: { maxHintLevel: 5, feedback: 'full', explanation: 'after-grade', attemptsPerItem: 3, graderFeedback: true, tutorMayHelp: true },
  checkpoint: { maxHintLevel: 0, feedback: 'score-only', explanation: 'after-session', attemptsPerItem: 1, graderFeedback: false, tutorMayHelp: false },
  review: { maxHintLevel: 0, feedback: 'full', explanation: 'after-grade', attemptsPerItem: 2, graderFeedback: true, tutorMayHelp: false },
}

/** Tunable hint pacing (host configuration). */
export interface HintPacing {
  /** Seconds between escalations unless the learner made a new attempt. */
  readonly cooldownSec: number
  /** Practice hint ceiling from the preset (≤ 5). */
  readonly practiceMaxLevel: number
}

/** Default pacing: 20 s between levels (intelligent-tutoring.md §5.1). */
export const DEFAULT_HINT_PACING: HintPacing = { cooldownSec: 20, practiceMaxLevel: 5 }

/** Facts about the presentation needed to decide a hint request. */
export interface HintRequestFacts {
  readonly mode: ExerciseMode
  /** Highest level already revealed (0 = none). */
  readonly currentLevel: number
  /** Number of authored hint levels available on the item. */
  readonly authoredLevels: number
  readonly attemptsSoFar: number
  readonly lastHintAt: Date | null
  /** Attempts made since the last hint. */
  readonly attemptsSinceLastHint: number
  readonly now: Date
}

/**
 * Decide the next hint level, or refuse.
 * Before the first attempt only L1 (an orienting question) is available.
 * @param facts - request facts.
 * @param pacing - pacing configuration.
 * @returns the level to reveal.
 * @throws {HodosError} `POLICY_DENIED` in modes without hints or beyond the ceiling;
 *   `RATE_LIMITED` when escalating too fast.
 */
export function nextHintLevel(facts: HintRequestFacts, pacing: HintPacing = DEFAULT_HINT_PACING): number {
  const policy = MODE_POLICY[facts.mode]
  if (policy.maxHintLevel === 0) {
    throw new HodosError('POLICY_DENIED', `hints are not available in ${facts.mode} mode`, { mode: facts.mode })
  }
  const ceiling = Math.min(policy.maxHintLevel, facts.mode === 'practice' ? pacing.practiceMaxLevel : policy.maxHintLevel, facts.authoredLevels)
  const level = facts.currentLevel + 1
  if (level > ceiling) throw new HodosError('POLICY_DENIED', 'no further hints are available for this exercise', { level: facts.currentLevel })
  if (facts.attemptsSoFar === 0 && level > 1) {
    throw new HodosError('POLICY_DENIED', 'make an attempt before asking for a stronger hint', { level })
  }
  if (facts.lastHintAt !== null && facts.attemptsSinceLastHint === 0) {
    const waited = (facts.now.getTime() - facts.lastHintAt.getTime()) / 1000
    if (waited < pacing.cooldownSec) {
      throw new HodosError('RATE_LIMITED', `try the hint first; the next level unlocks in ${Math.ceil(pacing.cooldownSec - waited)}s or after another attempt`, {
        retryAfterSec: Math.ceil(pacing.cooldownSec - waited),
      })
    }
  }
  return level
}

/** Wrong answers on one item after which help is offered proactively. */
export const STUCK_AFTER_WRONG = 3
