/**
 * The grading contract. A grader returns evidence; it never sets mastery.
 * Estimators, gates and checkpoint policy stay in the platform.
 * @module @hodos/plugin-sdk/grading
 */
import type { ExerciseMode, SkillWeight } from './exercise.js'
import type { JsonObject, JsonValue } from './json.js'

/**
 * Normalized grading result (spec §9). The host validates every field; a
 * result naming a skill the item is not tagged with is rejected.
 */
export interface GradeResult {
  /** Score in [0, 1]. */
  readonly score: number
  readonly correct: boolean
  /** Per-skill scores in [0, 1]; each skill must be one of the item's skills. */
  readonly skillEvidence: ReadonlyArray<{ readonly skillId: string; readonly score: number }>
  /** Misconception ids detected in the response. */
  readonly misconceptions: readonly string[]
  /**
   * Feedback for the learner. Ignored by the platform in checkpoint and
   * diagnostic modes, and checked for answer-key leaks before release.
   */
  readonly feedback?: string
  /** Grader-specific facts, e.g. `{ engineLossCp: 180 }`; stored, never shown to the learner raw. */
  readonly details?: JsonObject
}

/** Everything a grader may read. The key is present only on the server. */
export interface GradeInput {
  readonly kind: string
  readonly payload: JsonValue
  readonly key: JsonValue
  readonly response: JsonValue
  readonly mode: ExerciseMode
  readonly skills: readonly SkillWeight[]
  /** 1-based attempt number for this presentation. */
  readonly attempt: number
}

/** Input to one step of a stepwise exercise. `progress` is the server-held state so far. */
export interface StepInput extends GradeInput {
  readonly progress: JsonValue | null
}

/**
 * Outcome of one step. `continue` returns the next client-visible progress
 * (for example the opponent's reply); `complete` finishes the attempt with a grade.
 */
export type StepResult =
  | { readonly status: 'continue'; readonly progress: JsonValue; readonly message?: string }
  | { readonly status: 'complete'; readonly progress: JsonValue; readonly grade: GradeResult }

/** How a grader decides. AI-rubric results are advisory and cannot open a gate. */
export type GradingMethod = 'deterministic' | 'oracle' | 'engine' | 'ai-rubric'

/**
 * A grader contributed by a plugin. Trusted (built-in, allowlisted) plugins
 * supply in-process functions. Untrusted plugins must supply `sandbox`: a
 * single-file module of pure functions that the host runs in an isolated
 * interpreter with no filesystem, network or environment access.
 */
export interface GraderSpec {
  /** Grader id; must be listed in the manifest's `capabilities.graders`. */
  readonly id: string
  /** Exercise kinds this grader scores. */
  readonly kinds: readonly string[]
  readonly method: GradingMethod
  /** Trusted in-process scorer for `single` interaction kinds. */
  readonly grade?: (input: GradeInput) => GradeResult | Promise<GradeResult>
  /** Trusted in-process scorer for `stepwise` interaction kinds. */
  readonly step?: (input: StepInput) => StepResult | Promise<StepResult>
  /**
   * Untrusted scorer source. The module must define global functions
   * `grade(input)` and/or `step(input)` and `validateItem(item)` taking and
   * returning JSON; it may not import anything.
   */
  readonly sandbox?: { readonly source: string }
}

/** Clamp a number into [0, 1]; non-finite input becomes 0. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Build a result that gives every tagged skill the same score.
 * @param skills - the item's skill tags.
 * @param score - overall score in [0, 1].
 * @param extra - optional misconceptions, feedback and details.
 * @returns a normalized grade.
 */
export function uniformGrade(
  skills: readonly SkillWeight[],
  score: number,
  extra: { misconceptions?: readonly string[]; feedback?: string; details?: JsonObject; correct?: boolean } = {},
): GradeResult {
  const s = clampScore(score)
  return {
    score: s,
    correct: extra.correct ?? s >= 1,
    skillEvidence: skills.map(sk => ({ skillId: sk.skillId, score: s })),
    misconceptions: [...(extra.misconceptions ?? [])],
    ...(extra.feedback === undefined ? {} : { feedback: extra.feedback }),
    ...(extra.details === undefined ? {} : { details: extra.details }),
  }
}
