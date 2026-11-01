/**
 * The exercise contract. The platform owns the envelope (identity, skills,
 * difficulty, modes, hints, provenance); a plugin owns the payload schema, the
 * answer-key schema, the response schema and the grader.
 * @module @hodos/plugin-sdk/exercise
 */
import type { Diagnostic } from './errors.js'
import type { JsonSchema, JsonValue } from './json.js'

/** The mode an item is presented in. Mode policy is platform-enforced. */
export const EXERCISE_MODES = ['diagnostic', 'practice', 'checkpoint', 'review'] as const

/** One exercise mode. */
export type ExerciseMode = (typeof EXERCISE_MODES)[number]

/** Hint ladder levels: 1 orient, 2 point, 3 analogous example, 4 partial step, 5 bottom-out. */
export type HintLevel = 1 | 2 | 3 | 4 | 5

/** One authored hint. */
export interface ItemHint {
  readonly level: HintLevel
  readonly text: string
}

/** Weighted skill tag on an item. Weights are in (0, 1]. */
export interface SkillWeight {
  readonly skillId: string
  readonly weight: number
}

/**
 * Response format facts the mastery model needs. `guessable` items (multiple
 * choice and similar) need three distinct unassisted checkpoint successes;
 * guess-resistant items need one (ADR-0005).
 */
export interface ItemFormat {
  readonly guessable: boolean
  /** Number of options for choice items; sets the guess floor max(0.15, 1/k). */
  readonly options?: number
}

/** Where an item came from and how it was checked. */
export interface ItemProvenance {
  readonly source: 'authored' | 'generated' | 'imported'
  /** Checks the item passed, e.g. `chess.js`, `stockfish`, `self-consistency`, `human`. */
  readonly verifiedBy?: readonly string[]
  readonly author?: string
}

/**
 * One exercise item as stored by the platform.
 * @typeParam P - the plugin's payload (client-visible prompt) type.
 * @typeParam K - the plugin's answer-key type (server-only).
 */
export interface ExerciseItem<P extends JsonValue = JsonValue, K extends JsonValue = JsonValue> {
  /** Stable item id, unique within its course. */
  readonly id: string
  /** Registered exercise kind id, e.g. `chess.find-move`. */
  readonly kind: string
  /** Variants share a group; review and retakes prefer a different member. */
  readonly isomorphGroup?: string
  readonly skills: readonly SkillWeight[]
  /** Difficulty in logits: 0 is typical for the skill, positive is harder. */
  readonly difficulty: number
  readonly modes: readonly ExerciseMode[]
  readonly format?: ItemFormat
  readonly scaffold?: 'worked' | 'faded' | 'independent'
  readonly expectedTimeSec?: number
  /** Client-visible prompt, validated against the kind's `payloadSchema`. */
  readonly payload: P
  /** Server-only answer key, validated against the kind's `keySchema`. */
  readonly key: K
  /** Hint ladder. Server-only until released by the platform. */
  readonly hints?: readonly ItemHint[]
  /** Worked explanation, released after grading (never during a checkpoint). */
  readonly explanation?: string
  /** Feedback per misconception id, released when a grader detects it. */
  readonly misconceptionFeedback?: Readonly<Record<string, string>>
  readonly provenance?: ItemProvenance
}

/**
 * The normalized exercise as presented to a learner (spec §9). The payload is
 * the student-view projection: fields marked `x-visibility: server` are gone.
 */
export interface Exercise {
  /** Presentation id; one item can be presented many times. */
  readonly id: string
  readonly itemId: string
  readonly kind: string
  readonly environment: string
  readonly skills: readonly SkillWeight[]
  readonly difficulty: number
  readonly payload: JsonValue
  readonly mode: ExerciseMode
  /** Number of hint levels the learner may still request in this mode. */
  readonly hintsAvailable: number
  /** Attempt number this presentation will record next (1-based). */
  readonly attempt: number
  /** Server-held progress of a stepwise exercise, client-visible. */
  readonly progress?: JsonValue
}

/** Whether an exercise kind is answered in one submission or in server-driven steps. */
export type InteractionStyle = 'single' | 'stepwise'

/**
 * What a learner response looks like, for renderers and the plain-text
 * fallback. `text` is one line and `lines` several (for example a program's
 * output); both arrive as `{ text }`. `code` arrives as `{ code }`.
 */
export type ResponseKind = 'choice' | 'text' | 'lines' | 'moves' | 'code' | 'number' | 'expression' | 'structured'

/** Authoring guidance for an exercise kind, shown to course authors (people or models). */
export interface KindGuidance {
  /** When to use the kind. */
  readonly when: string
  /** Rules beyond the schemas, e.g. "the FEN must be a legal position". */
  readonly rules?: readonly string[]
  /** One valid example item body. */
  readonly example?: {
    readonly payload: JsonValue
    readonly key: JsonValue
    readonly hints?: readonly ItemHint[]
  }
}

/**
 * An exercise kind contributed by a plugin.
 * @typeParam P - payload type.
 * @typeParam K - key type.
 */
export interface ExerciseKindSpec<P extends JsonValue = JsonValue, K extends JsonValue = JsonValue> {
  /** Kind id; must be listed in the manifest's `capabilities.exerciseKinds`. */
  readonly id: string
  readonly title: string
  /** Environment (renderer family) that presents it, e.g. `chess.board`. */
  readonly environment: string
  readonly responseKind: ResponseKind
  readonly interaction: InteractionStyle
  /** Grader id that scores this kind. */
  readonly grader: string
  /** Default format facts; an item may override them. */
  readonly format: ItemFormat
  /** Schema of the client-visible payload. */
  readonly payloadSchema: JsonSchema
  /** Schema of the server-only key. */
  readonly keySchema: JsonSchema
  /** Schema of one learner response (or one step of a stepwise response). */
  readonly responseSchema: JsonSchema
  /** Authoring guidance and an example for course authors. */
  readonly guidance?: KindGuidance
  /**
   * Semantic item checks beyond JSON Schema (legal FEN, consistent answer
   * key). Runs only for trusted plugins; untrusted plugins ship a sandboxed
   * validator instead (see {@link GraderSpec.sandbox}).
   */
  readonly validateItem?: (item: ExerciseItem<P, K>) => readonly Diagnostic[]
  /**
   * Plain-text projection of the prompt, used when the renderer is missing
   * and for the agent's view of the exercise. Must not reveal the key.
   */
  readonly fallbackText: (payload: P) => string
  /**
   * What may be shown once the platform releases the answer (a correct
   * answer, exhausted attempts, the bottom-out hint, or a finished
   * checkpoint), e.g. a chess solution line. Trusted plugins only; without it
   * only the item's explanation is released. Never called while the answer is withheld.
   */
  readonly reveal?: (item: ExerciseItem<P, K>) => JsonValue
}
