/**
 * Branded identifiers and id generation.
 * @module @hodos/core/ids
 */
import { randomUUID } from 'node:crypto'

declare const brand: unique symbol

/** A string carrying a compile-time brand. */
export type Branded<B extends string> = string & { readonly [brand]: B }

/** Learner identity. Never accepted from model-supplied arguments. */
export type LearnerId = Branded<'LearnerId'>
/** One learning journey toward a goal. */
export type JourneyId = Branded<'JourneyId'>
/** One presentation of an exercise item. */
export type PresentationId = Branded<'PresentationId'>
/** One evidence record. */
export type EvidenceId = Branded<'EvidenceId'>
/** One checkpoint session. */
export type CheckpointId = Branded<'CheckpointId'>
/** One diagnostic session. */
export type DiagnosticId = Branded<'DiagnosticId'>
/** One adaptive-layer lesson overlay. */
export type OverlayId = Branded<'OverlayId'>

/**
 * Brand a string. Use only where the value's provenance is already trusted
 * (generated here or read back from the store).
 * @param value - the raw id.
 * @returns the branded id.
 */
export function brandId<B extends string>(value: string): Branded<B> {
  return value as Branded<B>
}

/** Generates ids; injectable for deterministic tests. */
export interface IdGenerator {
  next(prefix: string): string
}

/** Random UUID-based ids, e.g. `jrn_3f1c…`. */
export const randomIds: IdGenerator = {
  next: prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`,
}

/**
 * Deterministic ids for tests: `prefix_1`, `prefix_2`, …
 * @returns a fresh counter-based generator.
 */
export function sequentialIds(): IdGenerator {
  let n = 0
  return { next: prefix => `${prefix}_${++n}` }
}
