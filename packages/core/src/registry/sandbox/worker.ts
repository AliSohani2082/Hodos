/**
 * Child-process entry for untrusted plugin hooks (ADR-0002 mechanism).
 * Each call evaluates the plugin's single-file source in a fresh QuickJS-wasm
 * runtime with a memory cap, a stack cap and an interrupt deadline, then
 * calls one global function with JSON input and returns its JSON output.
 * The guest has no Node, filesystem, network or environment access; the
 * parent supervises wall time and kills this process on a breach.
 *
 * Only erasable TypeScript syntax is used so Node can run the source directly.
 * @module @hodos/core/sandbox-worker
 */
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'

/** Request from the parent. */
interface SandboxRequest {
  readonly id: number
  readonly fn: 'grade' | 'step' | 'validateItem'
  readonly source: string
  readonly input: string
  readonly cpuMs: number
  readonly memoryBytes: number
}

/** Reply to the parent. */
type SandboxReply =
  | { readonly id: number; readonly ok: true; readonly output: string }
  | { readonly id: number; readonly ok: false; readonly error: string }

const quickjs = await getQuickJS()

function run(req: SandboxRequest): SandboxReply {
  const runtime = quickjs.newRuntime()
  try {
    runtime.setMemoryLimit(req.memoryBytes)
    runtime.setMaxStackSize(256 * 1024)
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + req.cpuMs))
    const vm = runtime.newContext()
    try {
      // The input is a JSON text; embedding it as a string literal and parsing it
      // inside the guest keeps host objects out of the guest entirely.
      const program = `${req.source}\n;(function(){ if (typeof ${req.fn} !== 'function') throw new Error('hook ${req.fn} is not defined'); return JSON.stringify(${req.fn}(JSON.parse(${JSON.stringify(req.input)}))) })()`
      const result = vm.evalCode(program, 'plugin.js')
      if (result.error) {
        const dumped: unknown = vm.dump(result.error)
        result.error.dispose()
        const message = typeof dumped === 'object' && dumped !== null && 'message' in dumped ? String(dumped.message) : String(dumped)
        return { id: req.id, ok: false, error: message.slice(0, 500) }
      }
      const output = vm.typeof(result.value) === 'string' ? vm.getString(result.value) : 'null'
      result.value.dispose()
      return { id: req.id, ok: true, output }
    } finally {
      vm.dispose()
    }
  } finally {
    runtime.dispose()
  }
}

function isRequest(value: unknown): value is SandboxRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'number' && (v.fn === 'grade' || v.fn === 'step' || v.fn === 'validateItem')
    && typeof v.source === 'string' && typeof v.input === 'string' && typeof v.cpuMs === 'number' && typeof v.memoryBytes === 'number'
}

process.on('message', (message: unknown) => {
  if (!isRequest(message)) return
  let reply: SandboxReply
  try {
    reply = run(message)
  } catch (error) {
    reply = { id: message.id, ok: false, error: error instanceof Error ? error.message.slice(0, 500) : 'sandbox failure' }
  }
  process.send?.(reply)
})

process.send?.({ ready: true })
