// ALI-53: what does one plugin worker cost in memory? Idle RSS right after start, RSS after 200 calls, and the cost of extra QuickJS contexts in one process.
//   bun run src/bench/footprint.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANDIDATES, SPIKE_DIR } from '../host/sandboxes.ts'
import { createEngine } from '../worker/engines.mjs'
import { CASES } from '../../fixtures/cases.mjs'

const PLUGIN = join(SPIKE_DIR, 'fixtures/toy-plugin/server.mjs')
const ids = ['proc-bun', 'proc-node', 'quickjs-bun', 'ivm-node', 'workerd', 'proc-bun-podman', 'quickjs-bun-podman']
const rows: any[] = []
for (const id of ids) {
  const sb = CANDIDATES.find((c) => c.id === id)!.make(PLUGIN, { meter: false })
  await sb.start(); await new Promise((r) => setTimeout(r, 300))
  const idle = (await sb.rssMB())!
  for (let i = 0; i < 200; i++) for (const k of (CASES as any[]).slice(0, 6)) await sb.call(k.hook, k.args)
  const warm = (await sb.rssMB())!
  rows.push({ id, idleRssMB: +idle.toFixed(1), after1200CallsRssMB: +warm.toFixed(1) })
  console.log(id.padEnd(20), `idle ${idle.toFixed(0)} MB, after 1200 calls ${warm.toFixed(0)} MB`)
  await sb.stop()
}
// Extra QuickJS runtimes+contexts inside ONE process (one per plugin) are cheap compared with one process per plugin.
const before = process.memoryUsage().rss
const engines: any[] = []
for (let i = 0; i < 20; i++) engines.push(await createEngine('quickjs', { pluginPath: PLUGIN, memoryBytes: 32 << 20, wallMs: 1000 })), await engines[i].load({})
const after = process.memoryUsage().rss
const perCtx = (after - before) / 20 / 1048576
console.log(`20 QuickJS runtimes+contexts with the toy plugin loaded in one process: +${((after - before) / 1048576).toFixed(1)} MB total, ${perCtx.toFixed(2)} MB each`)
engines.forEach((e) => e.close())
writeFileSync(join(SPIKE_DIR, 'results/footprint.json'), JSON.stringify({ spike: 'ALI-53', bun: Bun.version, rows, quickjsExtraContexts: { count: 20, totalMB: +((after - before) / 1048576).toFixed(1), perContextMB: +perCtx.toFixed(2) } }, null, 2) + '\n')
process.exit(0)
