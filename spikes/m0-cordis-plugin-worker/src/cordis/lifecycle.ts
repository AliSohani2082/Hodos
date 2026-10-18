// ALI-50: does cordis lifecycle / services / disposal work on Bun? Same script runs on Bun and Node; results/cordis-<runtime>.json are diffed.
//   bun run src/cordis/lifecycle.ts          node --expose-gc src/cordis/lifecycle.ts
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { Context, Service } from 'cordis'
import { installRegistries, LessonRegistry } from './registries.ts'
import * as toy from '../../fixtures/toy-plugin/server.mjs'

const S = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 } as const // cordis FiberState (const enum, erased at runtime)
const isBun = typeof (globalThis as any).Bun !== 'undefined'
const runtime = isBun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.versions.node}`
const cordisVersion = JSON.parse(readFileSync(new URL('../../node_modules/cordis/package.json', import.meta.url), 'utf8')).version

type Check = { id: string; title: string; ok: boolean; ms: number; detail?: unknown; error?: string }
const checks: Check[] = []
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let unhandled = 0
process.on('unhandledRejection', () => { unhandled++ })
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error('assertion failed: ' + msg) }

async function check(id: string, title: string, fn: () => Promise<unknown> | unknown) {
  const t0 = performance.now()
  try {
    const detail = await fn()
    checks.push({ id, title, ok: true, ms: +(performance.now() - t0).toFixed(2), detail })
  } catch (e: any) {
    checks.push({ id, title, ok: false, ms: +(performance.now() - t0).toFixed(2), error: String(e?.message ?? e) })
  }
}

async function fresh() {
  const ctx = new Context()
  const regs = installRegistries(ctx)
  await Promise.all(Object.values(regs))
  return { ctx, regs }
}
const sizes = (ctx: Context) => [ctx.lesson.blocks.size, ctx.lesson.layouts.size, ctx.exercise.entries.size, ctx.pedagogy.entries.size]

await check('C00', 'negative control: a registration made WITHOUT ctx.effect is detected as a leak (proves the checks can fail)', async () => {
  const { ctx } = await fresh()
  const leaky = { name: 'leaky', inject: ['pedagogy'], apply(c: Context) { c.pedagogy.entries.set('leak', { name: 'leak', version: 1, data: {} }) } }
  const f = ctx.plugin(leaky as any); await f; await f.dispose()
  assert(ctx.pedagogy.entries.size === 1, 'leak must survive dispose (control)')
  return { leakedAfterDispose: ctx.pedagogy.entries.size }
})

await check('C01', 'toy plugin registers a block, a layout, an exercise kind and a preset through typed registries', async () => {
  const { ctx } = await fresh()
  const fiber = ctx.plugin(toy as any)
  await fiber
  assert(fiber.state === S.ACTIVE, 'toy plugin ACTIVE, got ' + fiber.state)
  assert(ctx.lesson.blocks.get('position')?.validate, 'block position has validate')
  assert(ctx.exercise.entries.get('toy-quiz')?.grade, 'exercise kind toy-quiz has grade')
  assert(ctx.pedagogy.entries.get('toy-drill')?.version === 1, 'preset registered')
  assert(ctx.lesson.layouts.has('toy-reader'), 'layout registered')
  return { effects: fiber.getEffects().map((e) => e.label) }
})

await check('C02', 'unload leaves nothing behind (registries, event listeners, timers)', async () => {
  const { ctx } = await fresh()
  let ticks = 0, seen = 0
  const probe = {
    name: 'probe', inject: ['lesson'],
    apply(c: Context) {
      c.effect(() => { const t = setInterval(() => ticks++, 2); return () => clearInterval(t) }, 'timer')
      c.on('hodos/registered', () => { seen++ })
    },
  }
  const hooksBefore = Object.values((ctx.events as any)._hooks).flat().length
  const a = ctx.plugin(toy as any), b = ctx.plugin(probe as any)
  await Promise.all([a, b])
  await sleep(15)
  assert(ticks > 0, 'timer ran while loaded')
  await a.dispose(); await b.dispose()
  const frozen = ticks
  await sleep(15)
  assert(ticks === frozen, 'timer stopped after dispose')
  assert(sizes(ctx).every((n) => n === 0), 'registries empty: ' + sizes(ctx))
  const hooksAfter = Object.values((ctx.events as any)._hooks).flat().length
  assert(hooksAfter === hooksBefore, `event hooks back to baseline (${hooksBefore} -> ${hooksAfter})`)
  assert(a.state === S.DISPOSED && b.state === S.DISPOSED, 'states DISPOSED')
  return { timerRanWhileLoaded: frozen > 0, hooksBefore, hooksAfter }
})

await check('C03', 'duplicate registration fails the second plugin, rolls back its partial work, leaves the first intact', async () => {
  const { ctx } = await fresh()
  const first = ctx.plugin(toy as any); await first
  const clash = {
    name: 'clash', inject: ['lesson'],
    apply(c: Context) {
      c.lesson.block({ name: 'fresh-block', version: 1, kind: 'leaf', body: 'none', attrs: {}, guidance: { when: '', syntax: '' }, fallback: { mode: 'hide', text: () => '' }, renderer: { entry: 'x', trust: 'sandboxed' } })
      c.lesson.block({ name: 'position', version: 1, kind: 'leaf', body: 'none', attrs: {}, guidance: { when: '', syntax: '' }, fallback: { mode: 'hide', text: () => '' }, renderer: { entry: 'x', trust: 'sandboxed' } })
    },
  }
  const second = ctx.plugin(clash as any)
  await second.await().catch(() => {})
  assert(second.state === S.FAILED, 'clash FAILED, got ' + second.state)
  assert(!ctx.lesson.blocks.has('fresh-block'), 'partial registration rolled back')
  assert(first.state === S.ACTIVE && ctx.lesson.blocks.has('position'), 'first plugin untouched')
  return { clashState: second.state }
})

await check('C04', 'plugin waiting on a service stays inactive, activates when the service appears, and is torn down/re-activated when the service is removed/restored', async () => {
  const ctx = new Context()
  const log: string[] = []
  const dep = {
    name: 'dep', inject: ['lesson'],
    apply(c: Context) { log.push('dep:apply'); c.effect(() => () => { log.push('dep:dispose') }) ; c.lesson.block({ name: 'dep-block', version: 1, kind: 'leaf', body: 'none', attrs: {}, guidance: { when: '', syntax: '' }, fallback: { mode: 'hide', text: () => '' }, renderer: { entry: 'x', trust: 'sandboxed' } }) },
  }
  const d = ctx.plugin(dep as any); await sleep(5)
  assert(d.state !== S.ACTIVE && log.length === 0, `dep waits without service (state ${d.state}, log ${log})`)
  const provider = ctx.plugin(LessonRegistry); await provider; await d.await()
  assert(d.state === S.ACTIVE && ctx.lesson.blocks.has('dep-block'), 'dep active after provider')
  await provider.dispose(); await sleep(5)
  assert(d.state !== S.ACTIVE && log.includes('dep:dispose'), `dep torn down when provider removed (state ${d.state})`)
  const provider2 = ctx.plugin(LessonRegistry); await provider2; await d.await(); await sleep(5)
  assert(d.state === S.ACTIVE && ctx.lesson.blocks.has('dep-block'), 'dep re-activated against new provider')
  return { log }
})

await check('C05', 'restart / config update re-runs apply with no duplicate registrations and no leaked effects', async () => {
  const { ctx } = await fresh()
  let applies = 0, disposes = 0
  const p = { name: 'reloadable', inject: ['pedagogy'], apply(c: Context, cfg: any) { applies++; c.pedagogy.preset({ name: 'p-' + (cfg?.tag ?? 'x'), version: 1, data: {} }); c.effect(() => () => { disposes++ }) } }
  const f = ctx.plugin(p as any, { tag: 'one' }); await f
  assert(ctx.pedagogy.entries.has('p-one'), 'preset one')
  await f.update({ tag: 'two' }); await f.await()
  assert(!ctx.pedagogy.entries.has('p-one') && ctx.pedagogy.entries.has('p-two'), 'preset swapped on config update')
  await f.restart(); await f.await()
  assert(ctx.pedagogy.entries.size === 1, 'exactly one preset after restart, got ' + ctx.pedagogy.entries.size)
  assert(applies === 3 && disposes === 2, `applies=${applies} disposes=${disposes}`)
  await f.dispose(); assert(disposes === 3 && ctx.pedagogy.entries.size === 0, 'final dispose cleans up')
  return { applies, disposes }
})

await check('C06', 'async apply and async disposers: dispose() waits for them, in reverse registration order', async () => {
  const { ctx } = await fresh()
  const order: string[] = []
  const p = {
    name: 'async-plugin', inject: ['lesson'],
    async apply(c: Context) {
      await sleep(10)
      c.effect(() => async () => { await sleep(20); order.push('first-registered') }, 'e1')
      c.effect(() => async () => { await sleep(5); order.push('second-registered') }, 'e2')
    },
  }
  const f = ctx.plugin(p as any)
  assert(f.state !== S.ACTIVE, 'not ACTIVE before async apply resolves')
  await f
  assert(f.state === S.ACTIVE, 'ACTIVE after await')
  await f.dispose()
  assert(order.join() === 'second-registered,first-registered', 'reverse order, got ' + order)
  return { order }
})

await check('C07', 'Config schema (Standard Schema) rejects bad config and fails only that plugin', async () => {
  const { ctx } = await fresh()
  const Config = { '~standard': { version: 1, vendor: 'ali38', validate: (v: any) => (typeof v?.gate === 'number' && v.gate > 0 && v.gate <= 1) ? { value: { gate: v.gate } } : { issues: [{ message: 'gate must be in (0, 1]', path: ['gate'] }] } } }
  const p = { name: 'configured', Config, inject: ['pedagogy'], apply(c: Context, cfg: any) { c.pedagogy.preset({ name: 'gate-' + cfg.gate, version: 1, data: {} }) } }
  const ok = ctx.plugin(p as any, { gate: 0.9 } as any); await ok
  assert(ctx.pedagogy.entries.has('gate-0.9'), 'valid config applied')
  const bad = ctx.plugin(p as any, { gate: 7 } as any); await bad.await().catch(() => {})
  assert(bad.state === S.FAILED, 'bad config FAILED, got ' + bad.state)
  return { badState: bad.state }
})

await check('C08', 'per-course scoping: ctx.isolate() gives each course its own lesson registry', async () => {
  const root = new Context()
  const A = root.isolate('lesson', Symbol('course-a')), B = root.isolate('lesson', Symbol('course-b'))
  await Promise.all([A.plugin(LessonRegistry), B.plugin(LessonRegistry)])
  const only = { name: 'only-in-a', inject: ['lesson'], apply(c: Context) { c.lesson.block({ name: 'x', version: 1, kind: 'leaf', body: 'none', attrs: {}, guidance: { when: '', syntax: '' }, fallback: { mode: 'hide', text: () => '' }, renderer: { entry: 'x', trust: 'sandboxed' } }) } }
  await A.plugin(only as any)
  assert(A.lesson.blocks.has('x') && !B.lesson.blocks.has('x'), 'block visible in course A only')
  assert(A.lesson !== B.lesson, 'distinct registry instances')
  return { a: [...A.lesson.blocks.keys()], b: [...B.lesson.blocks.keys()] }
})

await check('C09', 'plugin that throws in apply: FAILED state, message and plugin frame survive, process stays up, no unhandled rejection', async () => {
  const { ctx } = await fresh()
  const before = unhandled
  const boom = { name: 'boom', inject: ['lesson'], apply() { throw new Error('kaboom-from-plugin') } }
  const f = ctx.plugin(boom as any)
  let caught: any
  await f.await().catch((e: any) => { caught = e })
  await sleep(10)
  assert(f.state === S.FAILED, 'FAILED, got ' + f.state)
  const stack = String(caught?.stack ?? '')
  assert(/kaboom-from-plugin/.test(stack), 'message preserved in stack')
  assert(/apply/.test(stack) && /lifecycle\.ts/.test(stack), 'plugin frame present in stack')
  assert(unhandled === before, 'no unhandled rejection')
  const clean = (l: string) => l.replaceAll('file://', '').replaceAll(process.cwd(), '<spike>')
  return { stackHead: stack.split('\n').slice(0, 4).map(clean) }
})

await check('C10', 'events: emit/parallel/serial/bail/waterfall dispatch; listeners die with their plugin', async () => {
  const { ctx } = await fresh()
  const got: string[] = []
  const l = {
    name: 'listener', inject: ['lesson'],
    apply(c: Context) {
      c.on('hodos/registered', (kind, name) => { got.push(kind + ':' + name) })
      c.on('hodos/probe' as any, ((n: number) => n + 1) as any)
      c.on('hodos/probe' as any, ((n: number) => n * 10) as any)
    },
  }
  const lf = ctx.plugin(l as any); await lf
  const tf = ctx.plugin(toy as any); await tf
  assert(got.length === 4, 'saw 4 registrations, got ' + got.length)
  const bail = (ctx as any).bail('hodos/probe', 1)
  assert(bail === 2, 'bail returns first listener result, got ' + bail)
  const water = (ctx as any).waterfall('hodos/probe', 1)
  // waterfall threads a value through listeners; exact semantics are cordis's. We only require both runtimes to agree (see the diff script).
  const ser = await (ctx as any).serial('hodos/probe', 1)
  assert(ser === 2, 'serial returns first non-undefined, got ' + ser)
  await (ctx as any).parallel('hodos/probe', 1)
  await lf.dispose(); got.length = 0
  await tf.dispose(); const tf2 = ctx.plugin(toy as any); await tf2
  assert(got.length === 0, 'disposed listener no longer called')
  assert((ctx as any).bail('hodos/probe', 1) === undefined, 'probe listeners gone with their plugin')
  return { bail, waterfallResultType: typeof water, ser }
})

await check('C11', 'plugin forms: function, object with apply, class, ES module namespace', async () => {
  const { ctx } = await fresh()
  const fn: any = (c: Context) => { c.pedagogy.preset({ name: 'from-fn', version: 1, data: {} }) }; fn.inject = ['pedagogy']
  class Cls { static inject = ['pedagogy']; constructor(c: Context) { c.pedagogy.preset({ name: 'from-class', version: 1, data: {} }) } }
  const obj = { inject: ['pedagogy'], apply(c: Context) { c.pedagogy.preset({ name: 'from-object', version: 1, data: {} }) } }
  await Promise.all([ctx.plugin(fn), ctx.plugin(Cls as any), ctx.plugin(obj as any), ctx.plugin(toy as any)])
  assert(['from-fn', 'from-class', 'from-object', 'toy-drill'].every((n) => ctx.pedagogy.entries.has(n)), 'all four forms registered')
  return [...ctx.pedagogy.entries.keys()]
})

await check('C12', 'concurrent load of 100 plugins, then concurrent dispose', async () => {
  const { ctx } = await fresh()
  const fibers = Array.from({ length: 100 }, (_, i) => ctx.plugin({ name: 'bulk-' + i, inject: ['pedagogy'], apply(c: Context) { c.pedagogy.preset({ name: 'bulk-' + i, version: 1, data: { i } }) } } as any))
  const t0 = performance.now(); await Promise.all(fibers); const loadMs = performance.now() - t0
  assert(ctx.pedagogy.entries.size === 100, 'all 100 registered')
  const t1 = performance.now(); await Promise.all(fibers.map((f) => f.dispose())); const disposeMs = performance.now() - t1
  assert(ctx.pedagogy.entries.size === 0, 'all gone')
  return { loadMs: +loadMs.toFixed(1), disposeMs: +disposeMs.toFixed(1) }
})

await check('C13', 'churn: 2000 load/unload cycles of the toy plugin leave registries, fibers and heap flat', async () => {
  const { ctx } = await fresh()
  const gc = () => { if (isBun) (globalThis as any).Bun.gc(true); else (globalThis as any).gc?.() }
  const heap = () => { gc(); return process.memoryUsage().heapUsed }
  for (let i = 0; i < 200; i++) { const f = ctx.plugin(toy as any); await f; await f.dispose() } // warm up
  const baselineRegistry = ctx.registry.size
  const h0 = heap(), t0 = performance.now()
  const N = 2000
  for (let i = 0; i < N; i++) { const f = ctx.plugin(toy as any); await f; await f.dispose() }
  const cycleMs = (performance.now() - t0) / N
  const h1 = heap()
  assert(sizes(ctx).every((n) => n === 0), 'registries empty')
  const growthMB = (h1 - h0) / 1048576
  assert(ctx.registry.size - baselineRegistry <= 0, `registry did not grow (${baselineRegistry} -> ${ctx.registry.size})`)
  assert(growthMB < 15, `heap growth ${growthMB.toFixed(1)} MB over ${N} cycles`)
  return { cycles: N, msPerLoadUnload: +cycleMs.toFixed(3), heapGrowthMB: +growthMB.toFixed(2), gcExposed: isBun || typeof (globalThis as any).gc === 'function', registrySize: ctx.registry.size }
})

const failed = checks.filter((c) => !c.ok)
const report = { spike: 'ALI-50', runtime, cordis: cordisVersion, platform: `${process.platform}-${process.arch}`, passed: checks.length - failed.length, failed: failed.length, checks }
mkdirSync(new URL('../../results/', import.meta.url), { recursive: true })
const out = new URL(`../../results/cordis-${isBun ? 'bun' : 'node'}.json`, import.meta.url)
writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} ${c.title}${c.ok ? '' : '\n     ' + c.error} (${c.ms} ms)`)
console.log(`\n${runtime} / cordis ${cordisVersion}: ${report.passed}/${checks.length} passed -> results/cordis-${isBun ? 'bun' : 'node'}.json`)
process.exit(failed.length ? 1 : 0)
