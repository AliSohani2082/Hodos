/**
 * Lesson blocks. Lessons are text (Markdoc) parsed into a syntax-neutral
 * tree; plugins contribute typed blocks with a JSON Schema, authoring
 * guidance and a plain-text fallback. Lessons never contain executable code.
 * @module @hodos/plugin-sdk/lesson
 */
import type { Diagnostic } from './errors.js'
import type { JsonObject, JsonSchema } from './json.js'

/** A parsed, schema-validated lesson node. Plain data only. */
export interface LessonNode {
  /** Stable block id stamped into the lesson text. */
  readonly id: string
  /** Core node type (`paragraph`, `heading`, …) or a registered block name. */
  readonly type: string
  readonly attributes: JsonObject
  readonly children?: readonly LessonNode[]
  /** Text content for text-bearing leaves. */
  readonly text?: string
}

/** Authoring guidance injected into the agent's instructions when the block is available. */
export interface BlockGuidance {
  /** When to use the block. */
  readonly when: string
  /** One canonical example in Markdoc syntax. */
  readonly syntax: string
  readonly rules?: readonly string[]
}

/** A lesson block contributed by a plugin. */
export interface LessonBlockSpec {
  /** Tag name, unique among installed plugins; lowercase with dashes, e.g. `chess-position`. */
  readonly name: string
  /** Major version of the attribute schema. */
  readonly version: number
  readonly kind: 'leaf' | 'container'
  /** Object schema for the tag's attributes. `x-visibility: server` fields are stripped before rendering. */
  readonly attributes: JsonSchema
  readonly guidance: BlockGuidance
  /** Semantic checks beyond the schema (trusted plugins only). */
  readonly validate?: (node: LessonNode) => readonly Diagnostic[]
  /** What the block means without a renderer. Required; also used for the agent's view. */
  readonly fallbackText: (node: LessonNode) => string
  /** Renderer id that can draw this block interactively, if any. */
  readonly renderer?: string
}
