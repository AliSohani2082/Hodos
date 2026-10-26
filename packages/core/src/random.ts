/**
 * Seeded pseudo-random numbers (mulberry32) for reproducible diagnostics and
 * item selection.
 * @module @hodos/core/random
 */

/** A source of uniform numbers in [0, 1). */
export interface Random {
  next(): number
}

/**
 * Create a seeded generator.
 * @param seed - 32-bit integer seed.
 * @returns a deterministic generator.
 */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/**
 * Standard normal sample (Box–Muller).
 * @param rng - uniform source.
 * @returns one N(0, 1) sample.
 */
export function gaussian(rng: Random): number {
  const u = Math.max(rng.next(), Number.EPSILON)
  const v = rng.next()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Hash a string to a 32-bit seed (FNV-1a).
 * @param text - input text.
 * @returns unsigned 32-bit hash.
 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
