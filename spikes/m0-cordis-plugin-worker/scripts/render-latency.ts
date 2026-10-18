// Renders results/latency.json as the markdown tables used in the README and the ADR.   bun run scripts/render-latency.ts
import { readFileSync } from 'node:fs'
const d = JSON.parse(readFileSync(new URL('../results/latency.json', import.meta.url), 'utf8'))
const L = (r: any, k: string) => r.latencyMs[k]
console.log(`| Mechanism (id) | Cold start, first / later (ms) | validate p50 / p99 (ms) | grade p50 / p99 (ms) | validateItem 100 KB p50 (ms) | validateItem 1 MB p50 (ms) | RSS (MB)¹ | Diffs vs reference |`)
console.log(`|---|---|---|---|---|---|---|---|`)
for (const r of d.rows) {
  if (r.error) { console.log(`| \`${r.id}\` | ERROR: ${r.error} | | | | | | |`); continue }
  const v = L(r, 'validate (position, ~100 B)'), g = L(r, 'grade (mcq, ~1 KB)')
  console.log(`| \`${r.id}\` | ${r.coldStartMs.first.toFixed(0)} / ${r.coldStartMs.restMedian.toFixed(0)} | ${v.p50.toFixed(2)} / ${v.p99.toFixed(2)} | ${g.p50.toFixed(2)} / ${g.p99.toFixed(2)} | ${L(r, 'validateItem (~100 KB)').p50.toFixed(2)} | ${L(r, 'validateItem (~1 MB)').p50.toFixed(1)} | ${r.rssMBAfterWarm?.toFixed(0)} | ${r.correctness.mismatches.length}/${r.correctness.cases} |`)
}
console.log(`\n¹ Process RSS of the worker (container tiers: the container's init PID); for quickjs-inproc, the host's RSS growth since start.\n\n_${d.rows.length} mechanisms, ${d.calls} calls per hook, ${d.host}, Node ${d.node} (child runtime), ${d.cores} cores, load average at end ${d.loadavgAtEnd.join(' ')}, ${d.date}._`)
