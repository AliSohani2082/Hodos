/**
 * Structural JSON Schemas for courses and content packs. Every course that
 * enters the platform (plugin content packs, agent proposals, imports) is
 * checked against them before any semantic validation, so malformed input
 * yields findings instead of failures deeper in the pipeline.
 * @module @hodos/plugin-sdk/course-schema
 */
import type { Diagnostic } from './errors.js'
import { EXERCISE_MODES } from './exercise.js'
import type { JsonSchema } from './json.js'
import { compileSchema } from './schema.js'
import { SKILL_KINDS } from './skill.js'

const ID: JsonSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,127}$' }
const MISCONCEPTION_ID: JsonSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' }

function text(maxLength: number, minLength = 1): JsonSchema {
  return { type: 'string', minLength, maxLength }
}

function list(items: JsonSchema, maxItems: number, minItems = 0): JsonSchema {
  return { type: 'array', minItems, maxItems, items }
}

/** One skill node. */
export const SKILL_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'kind'],
  properties: {
    id: ID,
    title: text(200),
    kind: { enum: [...SKILL_KINDS] },
    description: text(2000, 0),
    requires: list(ID, 32),
    objectives: list(text(300), 20),
    environment: text(64),
    fluencyTargetSec: { type: 'number', exclusiveMinimum: 0, maximum: 600 },
    confusableWith: list(ID, 16),
  },
}

/** One exercise item envelope. Payload and key are checked against the kind's own schemas later. */
export const ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'skills', 'difficulty', 'modes', 'payload', 'key'],
  properties: {
    id: ID,
    kind: text(64),
    isomorphGroup: text(128),
    skills: list({
      type: 'object',
      additionalProperties: false,
      required: ['skillId', 'weight'],
      properties: { skillId: ID, weight: { type: 'number', exclusiveMinimum: 0, maximum: 1 } },
    }, 8, 1),
    difficulty: { type: 'number', minimum: -4, maximum: 4 },
    modes: { type: 'array', minItems: 1, maxItems: EXERCISE_MODES.length, uniqueItems: true, items: { enum: [...EXERCISE_MODES] } },
    format: {
      type: 'object',
      additionalProperties: false,
      required: ['guessable'],
      properties: { guessable: { type: 'boolean' }, options: { type: 'integer', minimum: 2, maximum: 26 } },
    },
    scaffold: { enum: ['worked', 'faded', 'independent'] },
    expectedTimeSec: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
    payload: {},
    key: {},
    hints: list({
      type: 'object',
      additionalProperties: false,
      required: ['level', 'text'],
      properties: { level: { enum: [1, 2, 3, 4, 5] }, text: text(1000) },
    }, 5),
    explanation: text(4000, 0),
    misconceptionFeedback: { type: 'object', maxProperties: 32, propertyNames: MISCONCEPTION_ID, additionalProperties: text(1000) },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: { enum: ['authored', 'generated', 'imported'] },
        verifiedBy: list(text(64), 8),
        author: text(200),
      },
    },
  },
}

/** One lesson. */
export const LESSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'skillId', 'title', 'source'],
  properties: { id: ID, skillId: ID, title: text(200), source: text(200_000) },
}

/** A course. */
export const COURSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'title', 'description', 'keywords', 'goal', 'skills', 'environments', 'lessons', 'items'],
  properties: {
    id: ID,
    version: text(64),
    title: text(200),
    description: text(4000, 0),
    keywords: list(text(64), 50),
    language: text(35),
    goal: ID,
    skills: list(SKILL_SCHEMA, 500, 1),
    environments: list(text(64), 16),
    preset: text(80),
    lessons: list(LESSON_SCHEMA, 1000),
    items: list(ITEM_SCHEMA, 5000),
  },
}

/** A content pack envelope; each course is checked with {@link COURSE_SCHEMA} on import. */
export const CONTENT_PACK_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'title', 'courses'],
  properties: {
    id: ID,
    version: text(64),
    title: text(200),
    courses: list({ type: 'object' }, 50),
  },
}

const courseValidator = compileSchema(COURSE_SCHEMA, 'course/shape')
const packValidator = compileSchema(CONTENT_PACK_SCHEMA, 'content-pack/shape')

/**
 * Check the structure of an untrusted course.
 * @param value - candidate course.
 * @returns findings; empty when the value has the shape of a `CourseSpec`.
 */
export function validateCourseShape(value: unknown): readonly Diagnostic[] {
  return courseValidator(value)
}

/**
 * Check the envelope of an untrusted content pack.
 * @param value - candidate pack.
 * @returns findings; empty when the value has the shape of a `ContentPack` envelope.
 */
export function validateContentPackShape(value: unknown): readonly Diagnostic[] {
  return packValidator(value)
}
