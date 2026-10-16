// Adapter conformance suite (ALI-51): the same checks run against every PluginHost implementation.
//   bun run src/host/conformance.ts      -> results/adapter-conformance.json
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as toy from '../../fixtures/toy-plugin/server.mjs'
import { CASES } from '../../fixtures/cases.mjs'
import type { PluginModule } from '../sdk/types.ts'
import { SPIKE_DIR, ProcessSandbox, InProcessSandbox, CANDIDATES } from './sandboxes.ts'
import type { HostEvent, PluginHost } from './plugin-host.ts'
import { CordisPluginHost } from './cordis-adapter.ts'
import { MapPluginHost } from './map-adapter.ts'

const PLUGIN = join(SPIKE_DIR, 'fixtures/toy-plugin/server.mjs')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const names = (host: PluginHost) => [host.registry.blocks().size, host.registry.layouts().size, host.registry.exerciseKinds().size, host.registry.presets().size]
const clash: PluginModule = { name: 'clash', apply(ctx) { ctx.pedagogy.preset({ name: 'fresh-preset', version: 1, data: {} }); ctx.lesson.block({ ...(toy as any).__blockStub, name: 'position' } as any) } }
const boom: PluginModule = { name: 'boom', apply(ctx) { ctx.pedagogy.preset({ name: 'half-done', version: 1, data: {} }); throw new Error('boom') } }

type Result = { id: string; title: string; ok: boolean; error?: string; detail?: unknown }

async function suite(label: string, make: (scope?: string) => Promise<PluginHost>): Promise<Result[]> {
  const out: Result[] = []
  const t = async (id: string, title: string, fn: (host: PluginHost) => Promise<unknown>) => {
    const host = await make()
    try { out.push({ id, title, ok: true, detail: await fn(host) }) } catch (e: any) { out.push({ id, title, ok: false, error: String(e?.message ?? e) }) } finally { await host.dispose() }
  }
  const must = (c: unknown, m: string): asserts c => { if (!c) throw new Error(m) }

  await t('A01', 'first-party plugin registers block, layout, exercise kind, preset; hooks are async', async (host) => {
    const h = host.loadFirstParty('toy', toy as unknown as PluginModule)
    must((await h.settled()) === 'active', 'active')
    must(names(host).join() === '1,1,1,1', 'sizes ' + names(host))
    const b = host.registry.blocks().get('position')!
    const p = b.validate({ id: 'n', type: 'position', attrs: { fen: 'bad' } }, { courseId: 'c', locale: 'en' })
    must(p instanceof Promise, 'validate returns a promise')
    must((await p)[0].id === 'toy/fen-fields', 'diagnostic content')
    must(b.trust === 'first-party' && b.pluginId === 'toy', 'origin recorded by the host')
    return { sizes: names(host) }
  })
  await t('A02', 'dispose leaves nothing behind', async (host) => {
    const h = host.loadFirstParty('toy', toy as unknown as PluginModule); await h.settled()
    await h.dispose()
    must(names(host).every((n) => n === 0), 'registries empty ' + names(host)); must(h.state === 'disposed', 'state')
    await h.dispose() // idempotent
  })
  await t('A03', 'name clash fails only the second plugin and rolls back its partial work', async (host) => {
    const a = host.loadFirstParty('toy', toy as unknown as PluginModule); await a.settled()
    const dup: PluginModule = { name: 'dup', apply(ctx) { ctx.pedagogy.preset({ name: 'fresh-preset', version: 1, data: {} }); ctx.pedagogy.preset({ name: 'toy-drill', version: 1, data: {} }) } }
    const b = host.loadFirstParty('dup', dup)
    must((await b.settled()) === 'failed' && b.error, 'second failed with error')
    must(!host.registry.presets().has('fresh-preset'), 'partial registration rolled back')
    must(a.state === 'active' && host.registry.presets().has('toy-drill'), 'first untouched')
  })
  await t('A04', 'a throwing plugin ends failed with its error and no leftovers', async (host) => {
    const h = host.loadFirstParty('boom', boom)
    must((await h.settled()) === 'failed' && /boom/.test(h.error!.message), 'failed with message')
    must(names(host).every((n) => n === 0), 'nothing left ' + names(host))
  })
  await t('A05', 'update(config) re-applies without duplicates', async (host) => {
    let applies = 0
    const p: PluginModule<{ tag: string }> = { name: 'cfg', apply(ctx, cfg) { applies++; ctx.pedagogy.preset({ name: 'p-' + cfg!.tag, version: 1, data: {} }) } }
    const h = host.loadFirstParty('cfg', p as PluginModule, { tag: 'one' }); await h.settled()
    must(host.registry.presets().has('p-one'), 'one')
    await h.update({ tag: 'two' })
    must(!host.registry.presets().has('p-one') && host.registry.presets().has('p-two') && applies === 2, 'swapped')
  })
  await t('A06', 'scopes are isolated: a plugin loaded in course A is invisible in course B; disposing the parent disposes the scopes', async (host) => {
    const a = await host.scope('course-a'), b = await host.scope('course-b')
    const h = a.loadFirstParty('toy', toy as unknown as PluginModule); await h.settled()
    must(a.registry.blocks().size === 1 && b.registry.blocks().size === 0 && host.registry.blocks().size === 0, 'isolation')
    must(a.registry.blocks().get('position')!.scope === 'course-a', 'scope recorded')
    await host.dispose()
    must(a.registry.blocks().size === 0, 'child emptied by parent dispose')
  })
  await t('A07', 'events: registered / unregistered with plugin id', async (host) => {
    const seen: HostEvent[] = []
    host.onEvent((e) => seen.push(e))
    const h = host.loadFirstParty('toy', toy as unknown as PluginModule); await h.settled(); await h.dispose()
    must(seen.filter((e) => e.type === 'registered').length === 4 && seen.filter((e) => e.type === 'unregistered').length === 4, 'four each, got ' + seen.length)
    must(seen.every((e) => e.pluginId === 'toy'), 'plugin id')
  })
  for (const [sid, sandboxFactory] of [
    ['A08', () => new InProcessSandbox({ label: 'qjs', engine: 'quickjs', pluginPath: PLUGIN })],
    ['A09', () => new ProcessSandbox({ label: 'proc', engine: 'native', runtime: 'bun', wrap: 'none', pluginPath: PLUGIN })],
  ] as const) {
    await t(sid, `sandboxed plugin (${sid === 'A08' ? 'QuickJS-wasm in process' : 'plain Bun process'}): data registered, hooks proxied over RPC, results match first-party, dispose stops the worker`, async (host) => {
      const sb = sandboxFactory()
      const h = host.loadSandboxed('toy-sandboxed', sb as any)
      must((await h.settled()) === 'active', 'active: ' + h.error?.message)
      must(names(host).join() === '1,1,1,1', 'sizes ' + names(host))
      const b = host.registry.blocks().get('position')!
      must(b.trust === 'sandboxed', 'trust assigned by host')
      must(sb.alive(), 'worker running')
      for (const c of CASES as any[]) {
        if (c.hook.startsWith('block:position#validate')) must(JSON.stringify(await b.validate(c.args[0], c.args[1])) === JSON.stringify((await toyBlock(c.args))), `validate ${c.name}`)
        if (c.hook === 'exercise:toy-quiz#grade') {
          const g = await host.registry.exerciseKinds().get('toy-quiz')!.grade(c.args[0], c.args[1], c.args[2])
          must(c.expectScore === g.score, `grade ${c.name}: ${g.score}`)
        }
      }
      must((await b.fallbackText({ id: 'n', type: 'position', attrs: { fen: 'x' } })) === '[Chess position: x]', 'fallback.text')
      await h.dispose()
      must(names(host).every((n) => n === 0), 'registries empty'); must(!sb.alive(), 'worker stopped on unload')
    })
  }
  await t('A10', 'a sandboxed plugin whose worker returns a forged GradeResult is rejected by the host, not believed', async (host) => {
    const forged = { start: async () => ({ manifest: { name: 'forger', blocks: [], layouts: [], presets: [], exerciseKinds: [{ id: 'exercise:f', name: 'f', version: 1, kinds: ['mcq'], responseKind: 'choice', grader: 'deterministic', supports: { steps: false, hints: false, partialCredit: false, timed: false, variants: false }, itemSchema: {}, ui: { entry: 'x', trust: 'sandboxed' }, hooks: ['grade'] }] } }),
      call: async () => ({ ok: true as const, result: { score: 99, misconceptionsDetected: [], feedback: { text: 'x', revealsAnswer: false }, graderConfidence: 1, needsHumanReview: false } }), stop: async () => {} }
    const h = host.loadSandboxed('forger', forged as any); await h.settled()
    let rejected = false
    try { await host.registry.exerciseKinds().get('f')!.grade({} as any, {}, {} as any) } catch (e: any) { rejected = /score/.test(e.message) }
    must(rejected, 'score 99 must be rejected')
  })
  if (label === 'cordis-adapter') await t('A11', 'disposing a cordis fiber stops its confined QuickJS worker and removes its container', async (host) => {
    const containers = () => execFileSync('podman', ['ps', '-a', '--format', '{{.Names}}']).toString().split('\n').filter((n) => n.startsWith('ali38-pw-'))
    const before = new Set(containers())
    const sb = CANDIDATES.find((c) => c.id === 'quickjs-bun-podman')!.make(PLUGIN)
    const h = host.loadSandboxed('toy-confined', sb)
    must((await h.settled()) === 'active', 'active: ' + h.error?.message)
    must((await sb.call('block:position#validate', [{ id: 'n', type: 'position', attrs: { fen: 'bad' } }, { courseId: 'c', locale: 'en' }])).ok, 'worker answers')
    await h.dispose()
    must(names(host).every((n) => n === 0), 'registries empty')
    must(!sb.alive(), 'worker stopped')
    must(containers().every((n) => before.has(n)), 'container remained after disposal')
  })
  return out
}

// Reference answer for the validate cases, computed by calling the toy plugin directly.
const toyBlocks: any[] = []
;(toy as any).apply({ lesson: { block: (s: any) => toyBlocks.push(s), layout() {} }, exercise: { kind() {} }, pedagogy: { preset() {} }, effect: (f: any) => f() })
const toyBlock = async (args: any[]) => toyBlocks[0].validate(args[0], args[1])

const adapters: [string, (scope?: string) => Promise<PluginHost>][] = [
  ['cordis-adapter', (s) => CordisPluginHost.create(s) as Promise<PluginHost>],
  ['map-adapter', (s) => MapPluginHost.create(s) as Promise<PluginHost>],
]
const report: any = { spike: 'ALI-51', bun: Bun.version, cordis: '4.0.0-rc.11', adapters: {} }
let failed = 0
for (const [name, make] of adapters) {
  const res = await suite(name, make)
  report.adapters[name] = res
  for (const r of res) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name.padEnd(15)} ${r.id} ${r.title}${r.ok ? '' : '\n     ' + r.error}`) }
}
mkdirSync(join(SPIKE_DIR, 'results'), { recursive: true })
writeFileSync(join(SPIKE_DIR, 'results/adapter-conformance.json'), JSON.stringify(report, null, 2) + '\n')
console.log(failed ? `\n${failed} FAILED` : `\nall ${Object.values(report.adapters).flat().length} checks pass on both adapters`)
process.exit(failed ? 1 : 0)
