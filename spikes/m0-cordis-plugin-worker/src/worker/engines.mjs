// In-JS-process engines that run the plugin behind the glue. Each returns { name, load(config), call(requestJson), close(), memoryBytes() }.
// Limits are enforced here where the engine supports them; a limit hit throws LimitError(kind) and the caller decides to recreate or kill.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export class LimitError extends Error {
  constructor(kind, message) { super(message || kind); this.name = 'LimitError'; this.kind = kind }
}

const GLUE_PATH = new URL('./glue.mjs', import.meta.url)
const ENTRY_SOURCE = `import { createHandler } from 'glue'; import * as plugin from 'plugin'; globalThis.handle = createHandler(plugin);`

let nextId = 1
function unwrapLoad(responseJson) {
  const r = JSON.parse(responseJson)
  if (!r.ok) throw new Error('plugin load failed: ' + (r.error && r.error.message))
  return r.result
}
const loadReq = (config) => JSON.stringify({ id: nextId++, op: 'load', config })

/** The plugin is imported directly into this process. No isolation by itself: confinement must come from the OS around the process. */
export async function nativeEngine({ pluginPath }) {
  const { createHandler } = await import(GLUE_PATH.href)
  const plugin = await import(pathToFileURL(pluginPath).href)
  const handle = createHandler(plugin)
  return { name: 'native', load: async (config) => unwrapLoad(await handle(loadReq(config))), call: (json) => handle(json), close() {}, memoryBytes: () => process.memoryUsage().rss }
}

/** quickjs-emscripten (QuickJS compiled to wasm, RELEASE_SYNC variant). Works in Bun and Node. Limits: runtime memory limit, stack limit, interrupt handler (deadline). */
export async function quickjsEngine({ pluginPath, memoryBytes = 32 * 1024 * 1024, stackBytes = 512 * 1024, wallMs = 1000, maxJobs = 100000 }) {
  const { getQuickJS, shouldInterruptAfterDeadline } = await import('quickjs-emscripten')
  const QuickJS = await getQuickJS()
  const sources = { glue: readFileSync(GLUE_PATH, 'utf8'), plugin: readFileSync(pluginPath, 'utf8') }
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(memoryBytes)
  runtime.setMaxStackSize(stackBytes)
  let deadline = Infinity
  runtime.setInterruptHandler(() => performance.now() > deadline)
  runtime.setModuleLoader((name) => {
    if (name in sources) return sources[name]
    return { error: new Error('module not found: ' + name) } // no fs, no network, no builtin modules: only 'glue' and 'plugin' resolve
  })
  const context = runtime.newContext()
  context.unwrapResult(context.evalCode(ENTRY_SOURCE, 'entry.mjs', { type: 'module' })).dispose()
  const handleFn = context.getProp(context.global, 'handle')

  const classify = (err) => {
    const m = String(err && err.message || err)
    if (/interrupted/i.test(m)) return new LimitError('timeout', 'quickjs interrupted at deadline')
    if (/out of memory/i.test(m)) return new LimitError('memory', 'quickjs out of memory')
    return new Error(m)
  }
  async function call(json, ms = wallMs) {
    deadline = performance.now() + ms
    const arg = context.newString(json)
    try {
      const res = context.callFunction(handleFn, context.undefined, arg)
      if (res.error) { const e = context.dump(res.error); res.error.dispose(); throw classify(new Error(typeof e === 'object' ? (e.message || JSON.stringify(e)) : String(e))) }
      const promise = res.value
      try {
        for (let spins = 0; ; spins++) {
          const st = context.getPromiseState(promise)
          if (st.type === 'fulfilled') { const s = context.getString(st.value); st.value.dispose?.(); return s }
          if (st.type === 'rejected') { const e = context.dump(st.error); throw classify(new Error(typeof e === 'object' ? e.message : String(e))) }
          if (performance.now() > deadline) throw new LimitError('timeout', 'quickjs deadline while pumping jobs')
          const jobs = runtime.executePendingJobs(maxJobs)
          if (jobs.error) { const e = context.dump(jobs.error); jobs.error.dispose(); throw classify(new Error(typeof e === 'object' ? (e.message || JSON.stringify(e)) : String(e))) }
          if (jobs.value === 0 && context.getPromiseState(promise).type === 'pending') throw new LimitError('timeout', 'promise can never settle (no pending jobs, no timers in QuickJS)')
        }
      } finally { promise.dispose() }
    } finally { arg.dispose(); deadline = Infinity }
  }
  const usage = () => { const h = runtime.computeMemoryUsage(); const d = context.dump(h); h.dispose(); return d }
  return {
    name: 'quickjs', call,
    load: async (config) => unwrapLoad(await call(loadReq(config), 5000)),
    close() { handleFn.dispose(); context.dispose(); runtime.dispose() },
    memoryBytes: () => usage().memory_used_size,
  }
}

/** isolated-vm 7.x (V8 isolates, native addon). Node only: the addon links V8 symbols that Bun (JavaScriptCore) does not have. Limits: memoryLimit, per-call timeout. */
export async function ivmEngine({ pluginPath, memoryMB = 32, wallMs = 1000 }) {
  const ivm = (await import('isolated-vm')).default
  const sources = { glue: readFileSync(GLUE_PATH, 'utf8'), plugin: readFileSync(pluginPath, 'utf8') }
  let dead = false
  const isolate = new ivm.Isolate({ memoryLimit: memoryMB, onCatastrophicError: () => { dead = true } })
  const context = await isolate.createContext()
  const mods = {}
  for (const name of Object.keys(sources)) mods[name] = await isolate.compileModule(sources[name], { filename: name + '.mjs' })
  const entry = await isolate.compileModule(ENTRY_SOURCE, { filename: 'entry.mjs' })
  await entry.instantiate(context, (specifier) => { if (specifier in mods) return mods[specifier]; throw new Error('module not found: ' + specifier) })
  await entry.evaluate()
  const handleRef = await context.global.get('handle', { reference: true })

  const classify = (e) => {
    const m = String(e && e.message || e)
    if (/timed out/i.test(m)) return new LimitError('timeout', m)
    if (/memory limit|disposed/i.test(m)) { dead = true; return new LimitError('memory', m) }
    return e instanceof Error ? e : new Error(m)
  }
  async function call(json, ms = wallMs) {
    if (dead || isolate.isDisposed) throw new LimitError('memory', 'isolate is dead (memory limit or catastrophic error)')
    // The per-call `timeout` bounds synchronous execution. A wall watchdog covers promise continuations the timeout may not cover.
    let watchdog
    const killed = new Promise((_, rej) => { watchdog = setTimeout(() => { dead = true; try { isolate.dispose() } catch {} ; rej(new LimitError('timeout', 'ivm wall watchdog fired')) }, ms + 250) })
    try {
      return await Promise.race([handleRef.apply(undefined, [json], { timeout: ms, result: { promise: true, copy: true } }), killed])
    } catch (e) { throw classify(e) } finally { clearTimeout(watchdog) }
  }
  return {
    name: 'ivm', call,
    load: async (config) => unwrapLoad(await call(loadReq(config), 5000)),
    close() { try { if (!isolate.isDisposed) isolate.dispose() } catch {} },
    isDead: () => dead || isolate.isDisposed,
    memoryBytes: () => (isolate.isDisposed ? 0 : isolate.getHeapStatisticsSync().used_heap_size),
    cpuNs: () => Number(isolate.cpuTime),
  }
}

export async function createEngine(kind, opts) {
  if (kind === 'native') return nativeEngine(opts)
  if (kind === 'quickjs') return quickjsEngine(opts)
  if (kind === 'ivm') return ivmEngine(opts)
  throw new Error('unknown engine ' + kind)
}
