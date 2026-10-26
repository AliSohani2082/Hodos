/**
 * Pedagogy presets: data that maps skill kinds to platform loops and tunes
 * platform policy within fixed maxima. Presets cannot define estimators,
 * gates or tutor limits beyond those maxima.
 * @module @hodos/plugin-sdk/preset
 */
import type { LearningLoop, SkillKind } from './skill.js'

/** Gate strictness levels; the platform maps them to θ = 0.90 / 0.95 / 0.98. */
export type GateStrictness = 'lenient' | 'standard' | 'strict'

/** A preset contributed by a plugin or shipped with the core. */
export interface PedagogyPreset {
  /** Preset id with version, e.g. `strategy@1`. */
  readonly id: string
  readonly title: string
  /** Loop override per kind. Unlisted kinds use the platform default. */
  readonly kindLoops?: Partial<Readonly<Record<SkillKind, LearningLoop>>>
  readonly gate?: { readonly strictness?: GateStrictness }
  readonly tutor?: {
    /** Highest hint level available in practice (platform maximum 5). */
    readonly maxHintLevel?: number
  }
  readonly review?: {
    /** FSRS target retention in [0.80, 0.97]. */
    readonly targetRetention?: number
  }
  /** Lesson structure guidance for agents writing lessons under this preset. */
  readonly lessonTemplate?: string
}
