/**
 * Course content: a versioned, local course format. Approved content is kept
 * separate from per-learner progress.
 * @module @hodos/plugin-sdk/content
 */
import type { ExerciseItem } from './exercise.js'
import type { SkillSpec } from './skill.js'

/** One lesson: Markdoc source for one skill. */
export interface LessonSpec {
  readonly id: string
  readonly skillId: string
  readonly title: string
  /** Markdoc source. Tags must be core tags or blocks registered by installed plugins. */
  readonly source: string
}

/** A course: a goal skill, its prerequisite graph, lessons and exercise items. */
export interface CourseSpec {
  readonly id: string
  /** Semantic version of the course content. */
  readonly version: string
  readonly title: string
  readonly description: string
  /** Terms that match learner goals, e.g. `chess`, `tactics`, `fork`. */
  readonly keywords: readonly string[]
  /** Course language (BCP 47). */
  readonly language?: string
  /** The goal skill id; every other skill should be one of its ancestors. */
  readonly goal: string
  readonly skills: readonly SkillSpec[]
  /** Environment ids the course needs, e.g. `chess.board`. */
  readonly environments: readonly string[]
  /** Preset id, e.g. `strategy@1`. */
  readonly preset?: string
  readonly lessons: readonly LessonSpec[]
  readonly items: readonly ExerciseItem[]
}

/** A bundle of courses shipped by a plugin. */
export interface ContentPack {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly courses: readonly CourseSpec[]
}
