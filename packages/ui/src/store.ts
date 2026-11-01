/**
 * Polled server state as an external store, read by React through
 * `useSyncExternalStore`. The tutor changes the session from the chat at any
 * time (a new question, a new plan), so the panel polls while it is shown,
 * more slowly while the page is hidden; actions refresh at once.
 */
import { useSyncExternalStore } from 'react'
import { errorText } from './api.js'

/** What a view renders from. */
export interface Snapshot<T> {
  readonly data: T | null
  /** Why the data could not be loaded, in words. */
  readonly error: string | null
}

/** One polled resource. */
export class Polled<T> {
  private snapshot: Snapshot<T> = { data: null, error: null }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | null = null

  /**
   * @param load - fetches the resource.
   * @param intervalMs - poll interval while the page is visible.
   */
  constructor(private readonly load: () => Promise<T>, private readonly intervalMs: number) {}

  /** The current snapshot (stable between changes). */
  readonly get = (): Snapshot<T> => this.snapshot

  /** Subscribe; the first subscriber starts polling, the last one stops it. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) void this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer !== undefined) clearTimeout(this.timer)
    }
  }

  private emit(next: Snapshot<T>): void {
    this.snapshot = next
    for (const l of this.listeners) l()
  }

  /** Load now (joins a load already running) and schedule the next poll. */
  refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.inFlight = this.load().then(
      data => this.emit({ data, error: null }),
      (error: unknown) => this.emit({ data: this.snapshot.data, error: errorText(error) }),
    ).finally(() => {
      this.inFlight = null
      if (this.listeners.size > 0) this.timer = setTimeout(() => { void this.refresh() }, document.hidden ? this.intervalMs * 5 : this.intervalMs)
    })
    return this.inFlight
  }
}

/**
 * Read a polled resource.
 * @param resource - the resource.
 * @returns its snapshot.
 */
export function usePolled<T>(resource: Polled<T>): Snapshot<T> {
  return useSyncExternalStore(resource.subscribe, resource.get)
}
