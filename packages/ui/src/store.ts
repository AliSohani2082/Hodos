/**
 * The workspace state as an external store, read by React through
 * `useSyncExternalStore`. While the workspace is shown it polls the Hodos API
 * (the tutor can change the journey from the chat at any time); actions
 * refresh it at once. It also fetches the next exercise when the journey
 * needs one, so no effect has to set React state.
 */
import { api, ApiError, type WorkspaceState } from './api.js'

/** What the workspace renders from. */
export interface Snapshot {
  readonly state: WorkspaceState | null
  /** Why the state or the next exercise could not be loaded, in words. */
  readonly error: string | null
  /** A next-exercise request is in flight. */
  readonly requesting: boolean
}

const POLL_MS = 4000
/** After a next-exercise request that failed or found nothing, wait this long before asking again. */
const RETRY_MS = 10_000

/** The request an error came from: that request succeeding clears it. */
type ErrorSource = 'load' | 'exercise'

function loadError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Hodos is not reachable.'
  return e.code === 'UNAUTHORIZED' ? 'Your DeepSeek Harness session has expired; reload the page.' : e.message
}

/** The polled workspace state. */
export class WorkspaceStore {
  private snapshot: Snapshot = { state: null, error: null, requesting: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<WorkspaceState | null> | null = null
  private queued: Promise<WorkspaceState | null> | null = null
  private retryAt = 0
  private errorFrom: ErrorSource | null = null

  /** For `useSyncExternalStore`: polling runs while anything is subscribed. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.timer = setInterval(() => { if (!document.hidden) void this.refresh() }, POLL_MS)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) clearInterval(this.timer)
    }
  }

  /** For `useSyncExternalStore`: the same object until something changes. */
  readonly getSnapshot = (): Snapshot => this.snapshot

  private update(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private failed(from: ErrorSource, error: string): void {
    this.errorFrom = from
    this.update({ error })
  }

  private succeeded(from: ErrorSource): void {
    if (this.errorFrom !== from) return
    this.errorFrom = null
    this.update({ error: null })
  }

  /**
   * Reload the state. A load already running may have started before the
   * caller's change, so one more load follows it.
   * @returns the new state, or null when it could not be loaded.
   */
  refresh(): Promise<WorkspaceState | null> {
    if (this.running === null) return this.load()
    this.queued ??= this.running.then(() => {
      this.queued = null
      return this.load()
    })
    return this.queued
  }

  private load(): Promise<WorkspaceState | null> {
    const run = this.fetchState().finally(() => {
      if (this.running === run) this.running = null
    })
    this.running = run
    return run
  }

  private async fetchState(): Promise<WorkspaceState | null> {
    try {
      const state = await api.state()
      this.update({ state })
      this.succeeded('load')
      return state
    } catch (e) {
      this.failed('load', loadError(e))
      return null
    }
  }

  /** Forget a reported error. */
  dismissError(): void {
    this.errorFrom = null
    if (this.snapshot.error !== null) this.update({ error: null })
  }

  /**
   * Ask the server for the next exercise, unless a request is in flight or a
   * recent one failed or found nothing (then it waits {@link RETRY_MS}).
   */
  async requestExercise(): Promise<void> {
    if (this.snapshot.requesting || Date.now() < this.retryAt) return
    const asked = this.snapshot.state?.journey?.nextAction.type
    this.update({ requesting: true })
    try {
      const opened = await api.nextExercise()
      this.succeeded('exercise')
      const state = await this.refresh()
      // Nothing to present and the journey did not move on: do not ask again at once.
      if (opened === null && state?.journey?.nextAction.type === asked) this.retryAt = Date.now() + RETRY_MS
    } catch (e) {
      this.retryAt = Date.now() + RETRY_MS
      this.failed('exercise', e instanceof ApiError ? e.message : 'Could not load the next exercise.')
    } finally {
      this.update({ requesting: false })
    }
  }
}

/** The workspace's store. */
export const store = new WorkspaceStore()
