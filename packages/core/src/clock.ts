/**
 * Injectable time source.
 * @module @hodos/core/clock
 */

/** Supplies the current time. */
export interface Clock {
  now(): Date
}

/** Wall-clock time. */
export const systemClock: Clock = { now: () => new Date() }

/** A clock tests can move. */
export interface ManualClock extends Clock {
  set(date: Date): void
  advance(ms: number): void
}

/**
 * Create a manual clock.
 * @param start - initial time.
 * @returns the clock.
 */
export function manualClock(start: Date): ManualClock {
  let current = new Date(start)
  return {
    now: () => new Date(current),
    set: date => { current = new Date(date) },
    advance: ms => { current = new Date(current.getTime() + ms) },
  }
}
