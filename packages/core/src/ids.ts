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

/** Random UUID-based ids, e.g. `lrn_3f1c…`. */
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
