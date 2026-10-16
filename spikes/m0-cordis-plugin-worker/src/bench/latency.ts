// ALI-52: startup + per-call latency + correctness (differential vs an in-process reference) for every candidate mechanism.
//   bun run src/bench/latency.ts [--only id,id] [--calls 300] [--starts 5]
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadavg, cpus } from 'node:os'
import { execFileSync } from 'node:child_process'
import { CANDIDATES, SPIKE_DIR, BIN, type Sandbox } from '../host/sandboxes.ts'
import { CASES, bigItem } from '../../fixtures/cases.mjs'
import { createHandler } from '../worker/glue.mjs'
import * as toy from '../../fixtures/toy-plugin/server.mjs'

const arg = (n: string, d?: string) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d }
const only = arg('only')?.split(',')
const CALLS = Number(arg('calls', '300')), STARTS = Number(arg('starts', '5'))
const PLUGIN = join(SPIKE_DIR, 'fixtures/toy-plugin/server.mjs')
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }
const r2 = (x: number) => +x.toFixed(3)
const stats = (xs: number[]) => ({ n: xs.length, p50: r2(pct(xs, 50)), p95: r2(pct(xs, 95)), p99: r2(pct(xs, 99)), mean: r2(xs.reduce((a, b) => a + b, 0) / xs.length), min: r2(Math.min(...xs)) })

// Reference: the toy plugin called in this very process, no sandbox. Defines "correct".
const refHandle = createHandler(toy)
await refHandle(JSON.stringify({ id: 0, op: 'load' }))
const ref = async (hook: string, args: any[]) => JSON.parse(await refHandle(JSON.stringify({ id: 1, op: 'call', hook, args }))).result

function expectationFailures() {
  return Promise.all(CASES.map(async (c: any) => {
    const out: any = await ref(c.hook, c.args)
    const ids = Array.isArray(out) ? out.map((d: any) => d.id).sort() : null
    if (c.expect !== undefined && JSON.stringify(out) !== JSON.stringify(c.expect)) return `${c.name}: got ${JSON.stringify(out)}`
    if (c.expectIds && JSON.stringify(ids) !== JSON.stringify([...c.expectIds].sort())) return `${c.name}: ids ${JSON.stringify(ids)}`
    if (c.expectScore !== undefined && out.score !== c.expectScore) return `${c.name}: score ${out.score}`
    if (c.expectMisc && JSON.stringify(out.misconceptionsDetected) !== JSON.stringify(c.expectMisc)) return `${c.name}: misc ${JSON.stringify(out.misconceptionsDetected)}`
    if (c.expectReview !== undefined && out.needsHumanReview !== c.expectReview) return `${c.name}: review ${out.needsHumanReview}`
    return null
  })).then((r) => r.filter(Boolean))
}
const refBad = await expectationFailures()
if (refBad.length) { console.error('reference run disagrees with hand-written expectations:', refBad); process.exit(2) }
console.log(`reference: ${CASES.length} hand-written expectations hold in-process`)

async function bench(c: (typeof CANDIDATES)[number]) {
  const row: any = { id: c.id, note: c.note }
  const starts: number[] = []
  const nStarts = /podman/.test(c.id) ? Math.min(STARTS, 3) : STARTS
  for (let i = 0; i < nStarts; i++) { const sb = c.make(PLUGIN); const info = await sb.start(); starts.push(info.startMs); row.runtime = info.runtime; await sb.stop() }
  const rest = starts.slice(1).sort((a, b) => a - b)
  row.coldStartMs = { ...stats(starts), first: r2(starts[0]), restMedian: r2(rest[Math.floor(rest.length / 2)] ?? starts[0]), runs: starts.map(r2) }
  const sb: Sandbox = c.make(PLUGIN)
  const info = await sb.start()
  row.manifest = { blocks: info.manifest.blocks.map((b: any) => b.id), exerciseKinds: info.manifest.exerciseKinds.map((b: any) => b.id), presets: info.manifest.presets.length, layouts: info.manifest.layouts.length }
  // correctness: every case must match the in-process reference exactly
  let mismatches: string[] = []
  for (const k of CASES as any[]) {
    const out = await sb.call(k.hook, k.args)
    const want = await ref(k.hook, k.args)
    if (!out.ok) mismatches.push(`${k.name}: ${out.kind} ${out.message}`)
    else if (JSON.stringify(out.result) !== JSON.stringify(want)) mismatches.push(`${k.name}: differs`)
  }
  row.correctness = { cases: CASES.length, mismatches }
  // latency
  const lat: any = {}
  const run = async (name: string, hook: string, args: any[], n: number) => {
    for (let i = 0; i < Math.min(20, n); i++) await sb.call(hook, args)
    const xs: number[] = []
    for (let i = 0; i < n; i++) { const o = await sb.call(hook, args); if (!o.ok) throw new Error(`${c.id} ${name}: ${o.kind} ${o.message}`); xs.push(o.ms) }
    lat[name] = stats(xs)
  }
  const fen = (CASES as any[])[0].args, mcqCase = (CASES as any[]).find((k) => k.name === 'grade: mcq correct').args
  await run('validate (position, ~100 B)', 'block:position#validate', fen, CALLS)
  await run('grade (mcq, ~1 KB)', 'exercise:toy-quiz#grade', mcqCase, CALLS)
  await run('validateItem (~1 KB)', 'exercise:toy-quiz#validateItem', [bigItem(1)], CALLS)
  await run('validateItem (~100 KB)', 'exercise:toy-quiz#validateItem', [bigItem(100)], Math.max(30, CALLS / 5))
  await run('validateItem (~1 MB)', 'exercise:toy-quiz#validateItem', [bigItem(1000)], 20)
  row.latencyMs = lat
  row.rssMBAfterWarm = await sb.rssMB().then((x) => (x === null ? null : r2(x)))
  await sb.stop()
  return row
}

const rows: any[] = []
for (const c of CANDIDATES) {
  if (only && !only.includes(c.id)) continue
  process.stdout.write(`${c.id.padEnd(20)} `)
  try {
    const row = await bench(c); rows.push(row)
    console.log(`start first ${row.coldStartMs.first} / rest ${row.coldStartMs.restMedian} ms | validate p50 ${row.latencyMs['validate (position, ~100 B)'].p50} ms p99 ${row.latencyMs['validate (position, ~100 B)'].p99} | grade p50 ${row.latencyMs['grade (mcq, ~1 KB)'].p50} | 100KB p50 ${row.latencyMs['validateItem (~100 KB)'].p50} | 1MB p50 ${row.latencyMs['validateItem (~1 MB)'].p50} | rss ${row.rssMBAfterWarm} MB | mismatches ${row.correctness.mismatches.length}`)
  } catch (e: any) { rows.push({ id: c.id, note: c.note, error: String(e.message ?? e) }); console.log('ERROR', e.message ?? e) }
}
mkdirSync(join(SPIKE_DIR, 'results'), { recursive: true })
const file = only ? `latency-${only.join('+')}.json` : 'latency.json'
writeFileSync(join(SPIKE_DIR, 'results', file), JSON.stringify({ spike: 'ALI-52', host: `bun ${Bun.version}`, node: execFileSync(BIN.node, ['--version']).toString().trim().replace(/^v/, ''), calls: CALLS, cpu: cpus()[0].model, cores: cpus().length, loadavgAtEnd: loadavg().map(r2), note: 'other spikes share this workstation; absolute numbers are noisy, ratios are the signal', date: new Date().toISOString().slice(0, 10), rows }, null, 2) + '\n')
console.log('wrote results/' + file)
process.exit(0)
