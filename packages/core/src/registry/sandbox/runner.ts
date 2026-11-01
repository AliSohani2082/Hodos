/**
 * Host-side supervisor for the sandbox worker process. Calls are serialized
 * JSON; each call has a guest CPU deadline (enforced inside QuickJS) and a
 * host wall deadline (enforced here by killing the process). Results above
 * the size cap are rejected. A crashed or killed worker restarts on the next
 * call; a pure hook is retried at most once after a crash.
 * @module @hodos/core/registry/sandbox
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HodosError } from '../../errors.js'

/** Limits applied to every sandboxed call. */
export interface SandboxLimits {
  /** Guest CPU deadline per call, ms (QuickJS interrupt). */
  readonly cpuMs: number
  /** Host wall-clock deadline per call, ms (process kill). */
  readonly wallMs: number
  /** Guest heap limit, bytes. */
  readonly memoryBytes: number
  /** Largest accepted serialized result, characters. */
  readonly maxResultChars: number
}

/** Defaults from the ADR-0002 hostile suite (1 s CPU, 1.5 s wall, 256 KiB results). */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpuMs: 1000,
  wallMs: 1500,
  memoryBytes: 48 * 1024 * 1024,
  maxResultChars: 256 * 1024,
}

/** Hook names a sandboxed module may define. */
export type SandboxHook = 'grade' | 'step' | 'validateItem'

interface Pending {
  resolve(output: string): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

function workerPath(): string {
  const js = fileURLToPath(new URL('./worker.js', import.meta.url))
  return existsSync(js) ? js : fileURLToPath(new URL('./worker.ts', import.meta.url))
}

/** Supervises one sandbox worker process. */
export class SandboxRunner {
  private child: ChildProcess | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private disposed = false

  /** @param limits - per-call limits. */
  constructor(readonly limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS) {}

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready
    const child = fork(workerPath(), [], {
      // No inherited environment: the worker never sees host secrets.
      env: {},
      cwd: tmpdir(),
      execArgv: ['--max-old-space-size=256'],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.child = child
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (message: unknown): void => {
        if (typeof message === 'object' && message !== null && 'ready' in message) {
          child.off('message', onReady)
          resolve()
        }
      }
      child.on('message', onReady)
      child.once('exit', code => reject(new HodosError('UNAVAILABLE', `sandbox worker exited during startup (code ${String(code)})`)))
    })
    child.on('message', (message: unknown) => this.onMessage(message))
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        this.ready = null
      }
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new HodosError('UNAVAILABLE', 'sandbox worker stopped'))
        this.pending.delete(id)
      }
    })
    return this.ready
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('id' in message) || typeof message.id !== 'number') return
    const p = this.pending.get(message.id)
    if (p === undefined) return
    this.pending.delete(message.id)
    clearTimeout(p.timer)
    if ('ok' in message && message.ok === true && 'output' in message && typeof message.output === 'string') {
      if (message.output.length > this.limits.maxResultChars) {
        p.reject(new HodosError('INVALID_INPUT', 'sandboxed hook returned an oversized result'))
      } else {
        p.resolve(message.output)
      }
    } else {
      const error = 'error' in message && typeof message.error === 'string' ? message.error : 'unknown failure'
      p.reject(new HodosError('INVALID_INPUT', `sandboxed hook failed: ${error}`))
    }
  }

  private kill(): void {
    const child = this.child
    this.child = null
    this.ready = null
    child?.kill('SIGKILL')
  }

  private async callOnce(hook: SandboxHook, source: string, input: string): Promise<string> {
    if (this.disposed) throw new HodosError('UNAVAILABLE', 'sandbox is disposed')
    await this.start()
    const child = this.child
    if (child === null) throw new HodosError('UNAVAILABLE', 'sandbox worker is not running')
    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HodosError('UNAVAILABLE', `sandboxed ${hook} exceeded ${this.limits.wallMs} ms and was stopped`))
        this.kill()
      }, this.limits.wallMs)
      this.pending.set(id, { resolve, reject, timer })
      child.send({ id, fn: hook, source, input, cpuMs: this.limits.cpuMs, memoryBytes: this.limits.memoryBytes })
    })
  }

  /**
   * Call a hook of an untrusted single-file module.
   * @param hook - the global function to call.
   * @param source - the module source.
   * @param input - JSON-serializable input.
   * @returns the parsed JSON output.
   * @throws {HodosError} `INVALID_INPUT` when the hook throws or returns oversized/invalid
   *   output; `UNAVAILABLE` on timeout or worker failure.
   */
  async call(hook: SandboxHook, source: string, input: unknown): Promise<unknown> {
    const serialized = JSON.stringify(input)
    let output: string
    try {
      output = await this.callOnce(hook, source, serialized)
    } catch (error) {
      // Retry a pure hook once after a worker crash, never after a timeout or guest error.
      if (error instanceof HodosError && error.code === 'UNAVAILABLE' && error.message === 'sandbox worker stopped') {
        output = await this.callOnce(hook, source, serialized)
      } else {
        throw error
      }
    }
    try {
      return JSON.parse(output) as unknown
    } catch {
      // The guest returned text that is not JSON; treat it as a malformed result.
      throw new HodosError('INVALID_INPUT', 'sandboxed hook returned invalid JSON')
    }
  }

  /** Stop the worker and reject pending calls. */
  dispose(): void {
    this.disposed = true
    this.kill()
  }
}
