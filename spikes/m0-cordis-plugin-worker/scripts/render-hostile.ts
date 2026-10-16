// Renders results/hostile.json as the markdown tables used in the README and the ADR.   bun run scripts/render-hostile.ts
import { readFileSync } from 'node:fs'
const d = JSON.parse(readFileSync(new URL('../results/hostile.json', import.meta.url), 'utf8'))
const rows: any[] = d.rows
const cands = [...new Set(rows.map((r) => r.candidate))]
const get = (c: string, a: string) => rows.find((r) => r.candidate === c && r.attack === a)

const cap = ['env', 'fs-outside', 'fs-write', 'net-loopback', 'net-lan', 'net-unix', 'fetch', 'cf-connect', 'spawn', 'escape', 'imports']
const capCell = (r: any) => !r ? '' : r.verdict === 'ESCAPED' ? '**ESCAPED**' : r.verdict === 'IN-SANDBOX' ? 'in sandbox' : r.verdict === 'BLOCKED' ? 'blocked' : r.verdict
console.log('**Capability attacks** (can the plugin obtain something TM-003 says it must not have?)\n')
console.log(`| Mechanism | ${cap.join(' | ')} | Escaped |`)
console.log(`|---|${cap.map(() => '---').join('|')}|---|`)
for (const c of cands) {
  const cells = cap.map((a) => capCell(get(c, a)))
  console.log(`| \`${c}\` | ${cells.join(' | ')} | ${cells.filter((x) => x === '**ESCAPED**').length} of ${cap.length} |`)
}

const res = ['cpu-loop', 'async-spin', 'redos', 'hang-promise', 'sleep-wall', 'mem-array', 'mem-string', 'mem-buffer', 'stack', 'flood', 'fork']
const by = (r: any) => {
  const e = r.limitEnforcedBy ?? ''
  return e.includes('CPU budget') ? 'host cpu' : e.includes('wall-clock') ? 'host wall' : e.includes('emergency') ? 'host RSS wd' : e.includes('cgroup OOM') ? 'kernel OOM' : e.includes('heap limit') ? 'heap limit' : e.includes('engine limit') ? 'engine' : e.includes('in-guest') ? 'in-guest err' : e.includes('size cap') ? 'host size cap' : e.includes('pids') ? 'pids cap' : e.includes('API absent') || e.includes('no subprocess') ? 'API absent' : e.includes('engine finished') ? 'finished' : e
}
const resCell = (r: any) => {
  if (!r) return ''
  const v = r.verdict.replace(' (BLOCKS HOST EVENT LOOP)', '')
  const s = (r.ms / 1000).toFixed(1) + 's'
  const tag = v === 'CONTAINED' ? 'ok' : v === 'WITHIN LIMITS' ? 'ok' : v === 'BLOCKED' ? 'n/a' : `**${v}**`
  return `${tag}: ${by(r)}, ${s}${r.verdict.includes('BLOCKS') ? ' **(host loop blocked)**' : ''}`
}
console.log('\n**Resource attacks** (is the limit enforced, by what, how fast, and did the worker recover?)\n')
console.log(`| Mechanism | ${res.join(' | ')} |`)
console.log(`|---|${res.map(() => '---').join('|')}|`)
for (const c of cands) console.log(`| \`${c}\` | ${res.map((a) => resCell(get(c, a))).join(' | ')} |`)

console.log('\n**Host impact and recovery** (worst case over the resource attacks)\n')
console.log('| Mechanism | Max host event-loop stall (ms) | Max time to next good answer after a kill (ms) | Peak memory seen by kernel cgroup (MB) |')
console.log('|---|---|---|---|')
for (const c of cands) {
  const rs = res.map((a) => get(c, a)).filter(Boolean)
  const stall = Math.max(...rs.map((r) => r.hostLoopStallMs))
  const rec = Math.max(...rs.map((r) => r.recoveryMs ?? 0))
  const cg = rs.map((r) => r.metrics?.peakCgroupMB).filter((x) => typeof x === 'number')
  console.log(`| \`${c}\` | ${stall} | ${rec} | ${cg.length ? Math.max(...cg) : 'n/a'} |`)
}
console.log('\n**Forged results** (host-side validator on what a worker returns)\n')
console.log('| Variant | Host verdict |\n|---|---|')
const seen = new Set<string>()
for (const f of d.forgery.filter((x: any) => x.variant && x.mechanism === 'proc-bun')) { if (!seen.has(f.variant)) { seen.add(f.variant); console.log(`| \`${f.variant}\` | ${f.host} |`) } }
