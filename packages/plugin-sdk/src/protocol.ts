/**
 * The renderer protocol: messages between the Hodos workspace (host) and an
 * environment renderer running in a sandboxed iframe with an opaque origin.
 * The host hands the renderer one `MessagePort` (`hodos:connect`); every
 * later message travels on that port. Both sides validate every message with
 * the parsers below and drop anything malformed.
 *
 * Browser-safe: no Node imports, no dependencies.
 * @module @hodos/plugin-sdk/protocol
 */
import { EXERCISE_MODES, type Exercise, type ExerciseMode, type SkillWeight } from './exercise.js'
import { isJsonValue, type JsonObject, type JsonValue } from './json.js'
import type { LessonNode } from './lesson.js'

/** Protocol version spoken by this SDK. */
export const RENDERER_PROTOCOL = 1

/** Largest serialized message accepted from a renderer, in characters. */
export const MAX_RENDERER_MESSAGE_CHARS = 64 * 1024

/** Capabilities a renderer may be granted by the host. */
export const RENDERER_CAPABILITIES = ['respond', 'resize', 'speech-synthesis'] as const

/** One renderer capability. */
export type RendererCapability = (typeof RENDERER_CAPABILITIES)[number]

/** Bootstrap message posted on the window with the port; the only window-level message. */
export interface ConnectMessage {
  readonly type: 'hodos:connect'
  readonly protocol: number
}

/** Messages the host sends on the port. */
export type HostToRendererMessage =
  | {
    readonly type: 'hodos:init'
    readonly protocol: number
    readonly environment: string
    readonly locale: string
    readonly colorScheme: 'light' | 'dark'
    readonly capabilities: readonly RendererCapability[]
  }
  | { readonly type: 'hodos:present'; readonly exercise: Exercise }
  | { readonly type: 'hodos:progress'; readonly exerciseId: string; readonly progress: JsonValue; readonly message?: string }
  | {
    readonly type: 'hodos:result'
    readonly exerciseId: string
    readonly correct: boolean
    readonly score: number
    /** Released solution data, present only when platform policy allows it. */
    readonly reveal?: JsonValue
  }
  | { readonly type: 'hodos:block'; readonly block: LessonNode }
  | { readonly type: 'hodos:lock'; readonly locked: boolean }
  | { readonly type: 'hodos:clear' }

/** Messages a renderer sends on the port. */
export type RendererToHostMessage =
  | { readonly type: 'hodos:ready'; readonly protocol: number }
  | { readonly type: 'hodos:response'; readonly exerciseId: string; readonly response: JsonValue }
  | { readonly type: 'hodos:resize'; readonly height: number }

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shortString(value: JsonValue | undefined, max = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function finiteNumber(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function onlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every(k => allowed.includes(k))
}

/** Parse untrusted input into a JSON object, or null. */
function toJsonObject(data: unknown): JsonObject | null {
  if (!isJsonValue(data)) return null
  return isJsonObject(data) ? data : null
}

/**
 * Parse a message received from a renderer. Unknown types, extra fields,
 * oversized payloads and non-JSON values are rejected.
 * @param data - the `MessageEvent.data` received on the port.
 * @returns the typed message, or null when it must be dropped.
 */
export function parseRendererMessage(data: unknown): RendererToHostMessage | null {
  const msg = toJsonObject(data)
  if (msg === null || JSON.stringify(msg).length > MAX_RENDERER_MESSAGE_CHARS) return null
  switch (msg.type) {
    case 'hodos:ready':
      return onlyKeys(msg, ['type', 'protocol']) && msg.protocol === RENDERER_PROTOCOL
        ? { type: 'hodos:ready', protocol: RENDERER_PROTOCOL }
        : null
    case 'hodos:response': {
      const exerciseId = shortString(msg.exerciseId)
      const response = msg.response
      return onlyKeys(msg, ['type', 'exerciseId', 'response']) && exerciseId !== null && response !== undefined
        ? { type: 'hodos:response', exerciseId, response }
        : null
    }
    case 'hodos:resize': {
      const height = finiteNumber(msg.height)
      return onlyKeys(msg, ['type', 'height']) && height !== null && height >= 0 && height <= 4000
        ? { type: 'hodos:resize', height: Math.round(height) }
        : null
    }
    default:
      return null
  }
}

function parseSkills(value: JsonValue | undefined): SkillWeight[] | null {
  if (!Array.isArray(value)) return null
  const out: SkillWeight[] = []
  for (const entry of value) {
    if (!isJsonObject(entry)) return null
    const skillId = shortString(entry.skillId)
    const weight = finiteNumber(entry.weight)
    if (skillId === null || weight === null) return null
    out.push({ skillId, weight })
  }
  return out
}

function parseMode(value: JsonValue | undefined): ExerciseMode | null {
  return EXERCISE_MODES.find(m => m === value) ?? null
}

function parseExercise(value: JsonValue | undefined): Exercise | null {
  if (!isJsonObject(value)) return null
  const id = shortString(value.id)
  const itemId = shortString(value.itemId)
  const kind = shortString(value.kind)
  const environment = shortString(value.environment)
  const skills = parseSkills(value.skills)
  const difficulty = finiteNumber(value.difficulty)
  const mode = parseMode(value.mode)
  const hintsAvailable = finiteNumber(value.hintsAvailable)
  const attempt = finiteNumber(value.attempt)
  const payload = value.payload
  if (id === null || itemId === null || kind === null || environment === null || skills === null
    || difficulty === null || mode === null || hintsAvailable === null || attempt === null || payload === undefined) {
    return null
  }
  return {
    id, itemId, kind, environment, skills, difficulty, payload, mode, hintsAvailable, attempt,
    ...(value.progress === undefined ? {} : { progress: value.progress }),
  }
}

function parseLessonNode(value: JsonValue | undefined, depth = 0): LessonNode | null {
  if (!isJsonObject(value) || depth > 32) return null
  const id = shortString(value.id)
  const type = shortString(value.type, 64)
  const attributes = value.attributes
  if (id === null || type === null || !isJsonObject(attributes)) return null
  let children: LessonNode[] | undefined
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return null
    children = []
    for (const child of value.children) {
      const parsed = parseLessonNode(child, depth + 1)
      if (parsed === null) return null
      children.push(parsed)
    }
  }
  return {
    id, type, attributes,
    ...(children === undefined ? {} : { children }),
    ...(typeof value.text === 'string' ? { text: value.text } : {}),
  }
}

function parseCapabilities(value: JsonValue | undefined): RendererCapability[] | null {
  if (!Array.isArray(value)) return null
  const out: RendererCapability[] = []
  for (const entry of value) {
    const cap = RENDERER_CAPABILITIES.find(c => c === entry)
    if (cap === undefined) return null
    out.push(cap)
  }
  return out
}

/**
 * Parse a message received from the host (used inside renderers).
 * @param data - the `MessageEvent.data` received on the port.
 * @returns the typed message, or null when it is not a valid host message.
 */
export function parseHostMessage(data: unknown): HostToRendererMessage | null {
  const msg = toJsonObject(data)
  if (msg === null) return null
  switch (msg.type) {
    case 'hodos:init': {
      const protocol = finiteNumber(msg.protocol)
      const environment = shortString(msg.environment)
      const capabilities = parseCapabilities(msg.capabilities)
      const colorScheme = msg.colorScheme === 'dark' ? 'dark' : msg.colorScheme === 'light' ? 'light' : null
      if (protocol === null || environment === null || capabilities === null || colorScheme === null || typeof msg.locale !== 'string') return null
      return { type: 'hodos:init', protocol, environment, locale: msg.locale, colorScheme, capabilities }
    }
    case 'hodos:present': {
      const exercise = parseExercise(msg.exercise)
      return exercise === null ? null : { type: 'hodos:present', exercise }
    }
    case 'hodos:progress': {
      const exerciseId = shortString(msg.exerciseId)
      if (exerciseId === null || msg.progress === undefined) return null
      return {
        type: 'hodos:progress', exerciseId, progress: msg.progress,
        ...(typeof msg.message === 'string' ? { message: msg.message } : {}),
      }
    }
    case 'hodos:result': {
      const exerciseId = shortString(msg.exerciseId)
      const score = finiteNumber(msg.score)
      if (exerciseId === null || score === null || typeof msg.correct !== 'boolean') return null
      return {
        type: 'hodos:result', exerciseId, correct: msg.correct, score,
        ...(msg.reveal === undefined ? {} : { reveal: msg.reveal }),
      }
    }
    case 'hodos:block': {
      const block = parseLessonNode(msg.block)
      return block === null ? null : { type: 'hodos:block', block }
    }
    case 'hodos:lock':
      return typeof msg.locked === 'boolean' ? { type: 'hodos:lock', locked: msg.locked } : null
    case 'hodos:clear':
      return { type: 'hodos:clear' }
    default:
      return null
  }
}

/**
 * Whether a window-level message is the host's port handoff.
 * @param data - the window `MessageEvent.data`.
 * @returns true for `{ type: 'hodos:connect', protocol: 1 }`.
 */
export function isConnectMessage(data: unknown): data is ConnectMessage {
  const msg = toJsonObject(data)
  return msg !== null && msg.type === 'hodos:connect' && msg.protocol === RENDERER_PROTOCOL
}
