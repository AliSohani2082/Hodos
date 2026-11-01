/**
 * The student-view projection (PRD EX-2, TM-011): the one place that decides
 * what of an exercise may leave the server, plus a leak guard that scans
 * learner-bound and model-bound text (the tutor's question, grader feedback)
 * for withheld secrets (answer keys, unreleased hints and explanations,
 * server-only payload fields).
 * @module @hodos/core/projection
 */
import { stripServerFields, type ExerciseItem, type JsonValue } from '@hodos/plugin-sdk'
import type { RegisteredKind } from '../registry/registry.js'

/** Fragments shorter than this are not scanned (single letters, short option ids). */
export const MIN_SECRET_LENGTH = 4

function stringLeaves(value: JsonValue | undefined, out: string[], depth = 0): void {
  if (depth > 32 || value === undefined || value === null) return
  if (typeof value === 'string') out.push(value)
  else if (typeof value === 'number') out.push(String(value))
  else if (Array.isArray(value)) value.forEach(v => stringLeaves(v, out, depth + 1))
  else if (typeof value === 'object') Object.values(value).forEach(v => stringLeaves(v, out, depth + 1))
}

/**
 * Project an item's payload for the learner.
 * @param item - the stored item.
 * @param kind - its kind, or undefined when the plugin is missing.
 * @returns the client-visible payload; null when the kind is unavailable.
 */
export function projectPayload(item: ExerciseItem, kind: RegisteredKind | undefined): JsonValue {
  if (kind === undefined) return null
  return stripServerFields(kind.spec.payloadSchema, item.payload) ?? null
}

/** What has been released for one presentation. */
export interface ReleaseState {
  /** Highest hint level revealed. */
  readonly hintLevel: number
  /** Whether the answer, explanation and reveal data are released. */
  readonly answer: boolean
}

/**
 * Collect the secrets that must not appear in a payload at this release state.
 * Fragments already visible in the projected payload, in the item id and
 * skill ids (shown with every exercise), or in other values the learner
 * legitimately sees (their own responses, the board after the steps played
 * so far), are excluded: they are not withheld, so they cannot leak.
 * @param item - the stored item.
 * @param kind - its kind (for schema-driven payload stripping).
 * @param release - what is released.
 * @param visible - other values already visible to the learner in this view.
 * @returns secret fragments to scan for.
 */
export function secretFragments(item: ExerciseItem, kind: RegisteredKind | undefined, release: ReleaseState, visible: readonly (JsonValue | null | undefined)[] = [], releasedMisconceptions: readonly string[] = []): string[] {
  const candidates: string[] = []
  if (!release.answer) {
    // Misconception ids the item declares are labels shown with their feedback, not answers.
    const labels = new Set(Object.keys(item.misconceptionFeedback ?? {}))
    const keyLeaves: string[] = []
    stringLeaves(item.key, keyLeaves)
    candidates.push(...keyLeaves.filter(s => !labels.has(s)))
    const keyJson = JSON.stringify(item.key)
    if (typeof item.key === 'object' && item.key !== null) candidates.push(keyJson)
    if (item.explanation !== undefined) candidates.push(item.explanation)
    for (const [id, text] of Object.entries(item.misconceptionFeedback ?? {})) if (!releasedMisconceptions.includes(id)) candidates.push(text)
  }
  for (const h of item.hints ?? []) if (h.level > release.hintLevel) candidates.push(h.text)
  if (kind !== undefined) {
    const all: string[] = []
    stringLeaves(item.payload, all)
    const shown: string[] = []
    stringLeaves(projectPayload(item, kind), shown)
    const visibleSet = new Set(shown)
    for (const s of all) if (!visibleSet.has(s)) candidates.push(s)
  }
  const visibleText = JSON.stringify([projectPayload(item, kind), item.id, item.skills.map(s => s.skillId), ...visible.filter(v => v !== undefined)])
  return [...new Set(candidates)].filter(s => s.length >= MIN_SECRET_LENGTH && !visibleText.includes(s) && !visibleText.includes(JSON.stringify(s).slice(1, -1)))
}

/**
 * Find withheld secrets inside an outbound value.
 * @param value - the payload about to leave the server.
 * @param secrets - fragments from {@link secretFragments}.
 * @returns the leaked fragments (empty when clean).
 */
export function scanForLeaks(value: unknown, secrets: readonly string[]): string[] {
  if (secrets.length === 0) return []
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  const lower = text.toLowerCase()
  return secrets.filter(secret => {
    // A secret can appear raw (string payloads) or JSON-escaped (serialized objects).
    const forms = new Set([secret, JSON.stringify(secret).slice(1, -1)])
    return [...forms].some(s => occurs(text, lower, s))
  })
}

const LONG_SECRET = 8

function occurs(text: string, lower: string, secret: string): boolean {
  if (secret.length >= LONG_SECRET) return text.includes(secret) || lower.includes(secret.toLowerCase())
  // Short fragments must stand alone, so random ids and longer words do not trigger false positives.
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = secret.length >= 6 ? 'iu' : 'u'
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags).test(text)
}

/**
 * The misconception feedback a grade releases. A detected misconception's own
 * feedback is released by the detection; the key, unreleased hints and
 * explanations, and the feedback of other misconceptions stay secret, so
 * feedback that reveals any of them is withheld.
 * @param item - the stored item.
 * @param kind - its kind.
 * @param release - what is released for the presentation.
 * @param visible - other values the learner sees (see {@link secretFragments}).
 * @param detected - misconception ids the grader reported.
 * @returns the feedback to show, and the secrets for scanning the whole reply.
 */
export function releaseMisconceptionFeedback(item: ExerciseItem, kind: RegisteredKind | undefined, release: ReleaseState, visible: readonly (JsonValue | null | undefined)[], detected: readonly string[]): { feedback: string[]; secrets: string[] } {
  const secrets = secretFragments(item, kind, release, visible, detected)
  const texts = [...new Set(detected.map(m => item.misconceptionFeedback?.[m]).filter((t): t is string => typeof t === 'string'))]
  return { feedback: texts.filter(t => scanForLeaks(t, secrets).length === 0), secrets }
}
