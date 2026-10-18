// ALI-53: how much slower is an interpreter-based isolate than a JIT for pure compute? fib(27) (about 630k calls) inside validate(), per mechanism.
// Matters because QuickJS (wasm, interpreter) is the strongest "no capabilities by construction" option but not the fastest.
//   bun run src/bench/compute.ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANDIDATES, SPIKE_DIR } from '../host/sandboxes.ts'

const PLUGIN = join(SPIKE_DIR, 'fixtures/hostile-plugin/server.mjs')
const ids = ['proc-bun', 'proc-node', 'quickjs-inproc', 'quickjs-bun', 'ivm-node', 'workerd']
const rows: any[] = []
for (const id of ids) {
  const cand = CANDIDATES.find((c) => c.id === id)!
  const sb = cand.make(PLUGIN, { wallMs: 30_000, cpuMs: 30_000, meter: false })
  await sb.start()
  const node = { id: 'n', type: 'attack', attrs: { attack: 'compute', n: 27, reps: 1 } }
  const xs: number[] = []
  for (let i = 0; i < 6; i++) { const o = await sb.call('block:attack#validate', [node as any, {} as any]); if (!o.ok) throw new Error(`${id}: ${o.kind} ${o.message}`); if (i > 0) xs.push(o.ms) }
  xs.sort((a, b) => a - b)
  rows.push({ id, fib27Ms: { p50: +xs[2].toFixed(1), min: +xs[0].toFixed(1), max: +xs[xs.length - 1].toFixed(1) } })
  console.log(id.padEnd(16), `fib(27): p50 ${xs[2].toFixed(1)} ms (min ${xs[0].toFixed(1)}, max ${xs[xs.length - 1].toFixed(1)})`)
  await sb.stop()
}
const base = rows.find((r) => r.id === 'proc-bun').fib27Ms.p50
for (const r of rows) r.slowdownVsBun = +(r.fib27Ms.p50 / base).toFixed(1)
writeFileSync(join(SPIKE_DIR, 'results/compute.json'), JSON.stringify({ spike: 'ALI-53', work: 'fib(27) recursive, in block validate()', bun: Bun.version, rows }, null, 2) + '\n')
console.log('wrote results/compute.json')
process.exit(0)
