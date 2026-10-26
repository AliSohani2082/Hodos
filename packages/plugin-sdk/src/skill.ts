/**
 * Skill kinds, the four platform-owned learning loops, and skill definitions.
 * @module @hodos/plugin-sdk/skill
 */

/** Knowledge kinds. The kind of a skill selects its learning loop and estimator. */
export const SKILL_KINDS = ['fact', 'concept', 'procedure', 'pattern', 'performance', 'judgment'] as const

/** One knowledge kind. */
export type SkillKind = (typeof SKILL_KINDS)[number]

/** The four learning loops owned by the platform. */
export const LEARNING_LOOPS = ['drill', 'recognize-fast', 'explain-check', 'attempt-critique'] as const

/** One learning loop. */
export type LearningLoop = (typeof LEARNING_LOOPS)[number]

/**
 * Default loop per kind (PRD §7). Presets may remap a kind to another loop;
 * they can never introduce a new loop or estimator.
 */
export const DEFAULT_LOOP_FOR_KIND: Readonly<Record<SkillKind, LearningLoop>> = {
  fact: 'drill',
  concept: 'explain-check',
  procedure: 'explain-check',
  pattern: 'recognize-fast',
  performance: 'attempt-critique',
  judgment: 'recognize-fast',
}

/** Lowercase dotted or dashed identifier, 2–128 characters. */
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/

/** A skill node as authored in a course or proposed by an agent. */
export interface SkillSpec {
  /** Stable namespaced id, e.g. `chess.tactics.fork.knight`. */
  readonly id: string
  readonly title: string
  readonly kind: SkillKind
  readonly description?: string
  /** Prerequisite skill ids. Edges must form a directed acyclic graph. */
  readonly requires?: readonly string[]
  /** Learning objectives shown to the learner. */
  readonly objectives?: readonly string[]
  /** Environment that presents this skill's exercises, e.g. `chess.board`. */
  readonly environment?: string
  /** Target median response time for `pattern` skills, in seconds. */
  readonly fluencyTargetSec?: number
  /** Skills easily confused with this one; practice interleaves them. */
  readonly confusableWith?: readonly string[]
}
