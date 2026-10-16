// ALI-53: hostile-plugin test. Runs every attack in fixtures/hostile-plugin against every mechanism and records, per attack, whether the capability was
// obtained or the resource limit held. Ground truth comes from the HOST (connection counters on dummy listeners, files, kernel cgroup counters), not from
// the plugin's own report. Uses only local canaries and dummy listeners. Cleans up everything it creates.
//   bun run src/hostile/run.ts [--only id,id] [--attacks a,b]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANDIDATES, DEFAULT_LIMITS, RUN_DIR, SPIKE_DIR, type Outcome, type Sandbox } from '../host/sandboxes.ts'
import { parseGradeResult, ResultError } from '../host/validate-result.ts'

const arg = (n: string) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined }
const rand = () => Math.random().toString(36).slice(2, 10)

// The env canary must be in this process's environment *at exec time* so that /proc/<pid>/environ contains it. Re-exec ourselves with it set.
if (!process.env.ALI38_CANARY_SECRET) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, ALI38_CANARY_SECRET: 'ALI38-CANARY-ENV-' + rand() }, stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
const ENV_TOKEN = process.env.ALI38_CANARY_SECRET!
const FILE_TOKEN = 'ALI38-CANARY-FILE-' + rand()
const NET_TOKEN = 'ALI38-FAKE-PG-' + rand()

// ---- dummy world: a secret file, a write target, a fake Postgres on TCP (loopback + LAN) and a fake runner API on a unix socket ----
const CANARY_DIR = join(SPIKE_DIR, 'tmp', 'ali38-canary')
const CANARY_FILE = join(CANARY_DIR, 'secret.txt')
const WRITE_TARGET = join(CANARY_DIR, 'write-target.txt')
const PLUGIN_DIR = join(SPIKE_DIR, 'fixtures/hostile-plugin')
const PLUGIN = join(PLUGIN_DIR, 'server.mjs')
const UNIX_SOCK = join(RUN_DIR, `ali38-fake-runner-${process.pid}.sock`)
mkdirSync(CANARY_DIR, { recursive: true })
writeFileSync(CANARY_FILE, FILE_TOKEN + '\n')
const hits = { tcp: 0, unix: 0 }
const tcp = net.createServer((s) => { hits.tcp++; s.on('error', () => {}); s.end('HTTP/1.0 200 OK\r\n\r\n' + NET_TOKEN + '\r\n') })
const unix = net.createServer((s) => { hits.unix++; s.on('error', () => {}); s.end(NET_TOKEN + '\r\n') })
await new Promise<void>((r) => tcp.listen(0, '0.0.0.0', r))
await new Promise<void>((r) => unix.listen(UNIX_SOCK, r))
const PORT = (tcp.address() as net.AddressInfo).port
const LAN_IP = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1'

// ---- host event-loop watcher: how long was the app's loop stalled while the plugin ran? ----
let lastTick = performance.now(), maxGap = 0
const ticker = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - lastTick); lastTick = n }, 10)
const resetGap = () => { maxGap = 0; lastTick = performance.now() }
// Baseline: how jittery is this shared workstation when nothing is running? Subtract it mentally from the stall numbers.
await new Promise((r) => setTimeout(r, 3000))
const BASELINE_STALL_MS = Math.round(maxGap); resetGap()
console.log('idle event-loop jitter baseline over 3 s:', BASELINE_STALL_MS, 'ms')

type Kind = 'capability' | 'resource' | 'control'
const ATTACKS: { id: string; kind: Kind; title: string; ground?: 'tcp' | 'unix' | 'file' }[] = [
  { id: 'env', kind: 'capability', title: 'read the host env canary (process.env, Bun.env, /proc/<ppid>/environ)' },
  { id: 'fs-outside', kind: 'capability', title: 'read a canary file outside the plugin package, and /etc/hostname' },
  { id: 'fs-write', kind: 'capability', title: 'write a file outside the package and into the package', ground: 'file' },
  { id: 'net-loopback', kind: 'capability', title: 'TCP connect to 127.0.0.1 (fake Postgres)', ground: 'tcp' },
  { id: 'net-lan', kind: 'capability', title: 'TCP connect to the host LAN address (fake LAN service)', ground: 'tcp' },
  { id: 'net-unix', kind: 'capability', title: 'connect to a unix socket (fake runner API / DB socket)', ground: 'unix' },
  { id: 'fetch', kind: 'capability', title: 'fetch() to the fake HTTP service', ground: 'tcp' },
  { id: 'cf-connect', kind: 'capability', title: 'workerd raw sockets: cloudflare:sockets connect()', ground: 'tcp' },
  { id: 'spawn', kind: 'capability', title: 'spawn a subprocess (id)' },
  { id: 'escape', kind: 'capability', title: 'reach process via Function constructor / indirect eval' },
  { id: 'imports', kind: 'capability', title: 'import node:/bun:/cloudflare: builtins, data: and http: URLs' },
  { id: 'fs-inside', kind: 'control', title: 'control: read its own package.json (allowed by design)' },
  { id: 'cpu-loop', kind: 'resource', title: 'while(true){}' },
  { id: 'async-spin', kind: 'resource', title: 'for(;;) await null (microtask starvation)' },
  { id: 'redos', kind: 'resource', title: 'catastrophic-backtracking regex' },
  { id: 'hang-promise', kind: 'resource', title: 'await a promise that never settles (wall time, ~0 CPU)' },
  { id: 'sleep-wall', kind: 'resource', title: 'await setTimeout(60 s) (wall time, ~0 CPU)' },
  { id: 'mem-array', kind: 'resource', title: 'allocate arrays until memory runs out (cap 2 GB)' },
  { id: 'mem-string', kind: 'resource', title: 'double a string 12 times (to 4 GB)' },
  { id: 'mem-buffer', kind: 'resource', title: 'allocate typed arrays until memory runs out (cap 2 GB)' },
  { id: 'stack', kind: 'resource', title: 'unbounded recursion' },
  { id: 'flood', kind: 'resource', title: 'return a 20 MB result' },
  { id: 'fork', kind: 'resource', title: 'spawn 48 subprocesses' },
]
const only = arg('only')?.split(','), onlyAttacks = arg('attacks')?.split(',')

function nodeFor(attack: string, sb: Sandbox) {
  const own = (sb as any).pluginPathInside ? (sb as any).pluginPathInside.replace(/server\.mjs$/, 'package.json') : join(PLUGIN_DIR, 'package.json')
  const canary = attack === 'env' || attack === 'escape' ? ENV_TOKEN : attack === 'fs-outside' ? FILE_TOKEN : NET_TOKEN
  return { id: 'n1', type: 'attack', attrs: { attack, canary, canaryFile: CANARY_FILE, writeTarget: WRITE_TARGET, ownFile: own, port: PORT, lanIp: LAN_IP, sock: UNIX_SOCK, capMB: 2048 } }
}
const parseReport = (o: Outcome): { attack: string; succeeded: boolean; detail: string } | null => {
  if (!o.ok || !Array.isArray(o.result)) return null
  try { return JSON.parse((o.result as any)[0].message) } catch { return null }
}

interface Row { candidate: string; attack: string; kind: Kind; verdict: string; detail: string; ms: number; hostLoopStallMs: number; limitEnforcedBy?: string; metrics?: unknown }

async function runCandidate(cand: (typeof CANDIDATES)[number]): Promise<Row[]> {
  const rows: Row[] = []
  const limits = { ...DEFAULT_LIMITS }
  const sb = cand.make(PLUGIN, limits)
  const inProc = cand.id.endsWith('-inproc')
  try {
    await sb.start()
    for (const atk of ATTACKS) {
      if (onlyAttacks && !onlyAttacks.includes(atk.id)) continue
      hits.tcp = 0; hits.unix = 0; rmSync(WRITE_TARGET, { force: true }); rmSync(PLUGIN + '.pwned', { force: true }); rmSync(join(PLUGIN_DIR, 'package.json.pwned'), { force: true })
      const rssBefore = process.memoryUsage().rss
      resetGap()
      const out = await sb.call('block:attack#validate', [nodeFor(atk.id, sb) as any, { courseId: 'c', locale: 'en' }])
      await new Promise((r) => setTimeout(r, 25)) // let the ticker fire once more: a blocked loop only reports its gap after it is released
      const stall = Math.round(maxGap)
      const rep = parseReport(out)
      const m = (sb as any).lastMetrics
      const row: Row = { candidate: cand.id, attack: atk.id, kind: atk.kind, verdict: '', detail: '', ms: Math.round(out.ms), hostLoopStallMs: stall, metrics: m ?? (inProc ? { hostRssGrowthMB: +((process.memoryUsage().rss - rssBefore) / 1048576).toFixed(1) } : undefined) }
      const mentionsTokens = JSON.stringify(out).includes(ENV_TOKEN) || JSON.stringify(out).includes(FILE_TOKEN) || JSON.stringify(out).includes(NET_TOKEN)
      if (atk.kind === 'capability') {
        const groundHit = atk.ground === 'tcp' ? hits.tcp > 0 : atk.ground === 'unix' ? hits.unix > 0 : atk.ground === 'file' ? existsSync(WRITE_TARGET) || existsSync(PLUGIN + '.pwned') || existsSync(join(PLUGIN_DIR, 'package.json.pwned')) : false
        const escaped = atk.ground ? groundHit : (rep?.succeeded === true || (mentionsTokens && atk.id === 'env'))
        // spawn / escape / imports that work INSIDE an OS sandbox (bubblewrap, container) reach nothing of value; they are reported separately, not as breaches
        const insideSandbox = escaped && !atk.ground && (cand.id.includes('podman') || cand.id.includes('bwrap')) && ['spawn', 'escape', 'imports'].includes(atk.id)
        row.verdict = insideSandbox ? 'IN-SANDBOX' : escaped ? 'ESCAPED' : 'BLOCKED'
        row.detail = rep ? `${rep.detail}${atk.ground ? ` | host saw ${atk.ground === 'file' ? (groundHit ? 'the file' : 'no file') : (atk.ground === 'tcp' ? hits.tcp : hits.unix) + ' connection(s)'}` : ''}` : (out.ok ? 'no report' : `call failed: ${out.kind}: ${out.message}`)
        if (!out.ok && out.kind === 'crash' && !escaped) row.detail += ' (worker died; counted as blocked only because no ground-truth breach)'
      } else if (atk.kind === 'control') {
        row.verdict = rep?.succeeded ? 'ALLOWED' : 'NO ACCESS'
        row.detail = rep?.detail ?? (out.ok ? '' : `${out.kind}: ${out.message}`)
      } else {
        // resource attacks: contained = the call failed or returned within bounds, the host stayed responsive, and the worker is usable again afterwards
        const slack = cand.id.includes('podman') ? 2500 : 1200
        const bounded = out.ms <= limits.wallMs + slack
        let verdict = 'UNCONTAINED'
        let by = ''
        if (!out.ok) {
          by = /host RSS watchdog/.test(out.message) ? 'host emergency watchdog' : /host CPU budget/.test(out.message) ? 'host CPU budget' : /cgroup OOM/.test(out.message) ? 'kernel cgroup OOM' : /runtime heap limit/.test(out.message) ? 'runtime heap limit' : /quickjs|ivm|isolate/i.test(out.message) ? 'engine limit' : out.kind === 'timeout' ? 'host wall-clock kill' : out.kind === 'too-large' ? 'host size cap' : out.kind === 'error' ? 'in-guest error' : out.kind
          verdict = bounded ? 'CONTAINED' : 'SLOW'
        } else if (atk.id === 'fork') {
          const spawned = Number(/spawned (\d+)/.exec(rep?.detail ?? '')?.[1] ?? 0)
          const live = (sb as any).liveProcesses?.() ?? null
          verdict = spawned === 0 ? 'BLOCKED' : spawned <= 32 && /podman|cgroup|bwrap/.test(cand.id) ? 'CONTAINED' : 'UNCONTAINED'
          by = spawned === 0 ? 'no subprocess API' : `pids cap (${spawned} spawned, ${live ?? '?'} alive)`
          row.detail = rep?.detail ?? ''
        } else if (atk.id === 'redos' && bounded) { verdict = 'WITHIN LIMITS'; by = 'engine finished the regex inside the wall limit'; row.detail = rep?.detail ?? '' }
        else if (rep && rep.succeeded === false && /allocated|built|slept/.test(rep.detail)) { verdict = 'UNCONTAINED'; row.detail = rep.detail }
        else if (rep && /ReferenceError|not defined|is not a function|no child_process/i.test(rep.detail)) { verdict = 'BLOCKED'; by = 'API absent' }
        if (!row.detail) row.detail = out.ok ? (rep?.detail ?? '') : out.message
        row.limitEnforcedBy = by
        if (inProc && stall > 300) row.verdict = verdict + ' (BLOCKS HOST EVENT LOOP)'
        else row.verdict = verdict
        // recovery: the next benign call must succeed (restarting the worker if it was killed)
        const t0 = performance.now()
        let rec = await sb.call('block:attack#validate', [nodeFor('noop', sb) as any, { courseId: 'c', locale: 'en' }])
        // Host policy under test: validate/grade/fallback are pure, so on a crash the host restarts the worker and retries ONCE.
        let retried = false
        if (!rec.ok && (rec.kind === 'crash' || rec.kind === 'protocol')) { retried = true; rec = await sb.call('block:attack#validate', [nodeFor('noop', sb) as any, { courseId: 'c', locale: 'en' }]) }
        const recMs = Math.round(performance.now() - t0)
        row.detail += ` | recovery: ${rec.ok ? 'ok' : rec.kind}${retried ? ' (after 1 retry)' : ''} in ${recMs} ms`
        if (!rec.ok) row.verdict = 'NO RECOVERY'
        ;(row as any).recoveryMs = recMs
      }
      rows.push(row)
      process.stdout.write(`${cand.id.padEnd(20)} ${atk.id.padEnd(13)} ${row.verdict.padEnd(14)} ${String(row.ms).padStart(6)} ms  stall ${String(stall).padStart(5)} ms  ${row.limitEnforcedBy ?? ''}\n`)
      if (!sb.alive()) { /* killed: the next call restarts it */ }
      rmSync(WRITE_TARGET, { force: true }); rmSync(PLUGIN + '.pwned', { force: true }); rmSync(join(PLUGIN_DIR, 'package.json.pwned'), { force: true })
    }
  } finally { await sb.stop() }
  return rows
}

async function forgery() {
  const out: any[] = []
  for (const id of ['quickjs-inproc', 'proc-bun']) {
    const cand = CANDIDATES.find((c) => c.id === id)!
    const sb = cand.make(PLUGIN)
    await sb.start()
    for (const variant of ['always-correct', 'out-of-range', 'nan', 'negative', 'huge-feedback', 'proto', 'reveal']) {
      const o = await sb.call('exercise:hostile-quiz#grade', [{ prompt: { variant } } as any, { choice: 'a' }, { mode: 'checkpoint', attempt: 1 }])
      let host = ''
      if (!o.ok) host = `transport rejected (${o.kind})`
      else { try { const g = parseGradeResult(o.result); host = `ACCEPTED score=${g.score} revealsAnswer=${g.feedback.revealsAnswer}` } catch (e) { host = e instanceof ResultError ? `REJECTED by host validator: ${e.message}` : String(e) } }
      out.push({ mechanism: id, variant, host })
      console.log(`forgery ${id.padEnd(15)} ${variant.padEnd(15)} ${host}`)
    }
    await sb.stop()
  }
  out.push({ note: 'prototype pollution check', polluted: ({} as any).isAdmin === true })
  console.log('Object.prototype polluted after the proto variant:', ({} as any).isAdmin === true)
  return out
}

const all: Row[] = []
try {
  for (const cand of CANDIDATES) {
    if (only && !only.includes(cand.id)) continue
    try { all.push(...(await runCandidate(cand))) } catch (e: any) { console.log(`${cand.id}: HARNESS ERROR ${e.message ?? e}`); all.push({ candidate: cand.id, attack: '*', kind: 'resource', verdict: 'HARNESS ERROR', detail: String(e.message ?? e), ms: 0, hostLoopStallMs: 0 }) }
  }
  const forged = onlyAttacks || only ? [] : await forgery()
  mkdirSync(join(SPIKE_DIR, 'results'), { recursive: true })
  const file = only || onlyAttacks ? `hostile-${(only ?? ['all']).join('+')}${onlyAttacks ? '-partial' : ''}.json` : 'hostile.json'
  writeFileSync(join(SPIKE_DIR, 'results', file), JSON.stringify({ spike: 'ALI-53', date: new Date().toISOString().slice(0, 10), bun: Bun.version, limits: { ...DEFAULT_LIMITS, cgroupMB: 256 }, idleLoopJitterBaselineMs: BASELINE_STALL_MS, dummyWorld: { tcpPort: 'ephemeral', lanIp: 'host LAN address (not recorded)', note: 'all canaries are random per run; no real service was contacted' }, rows: all, forgery: forged }, null, 2) + '\n')
  console.log('wrote results/' + file)
} finally {
  clearInterval(ticker); tcp.close(); unix.close(); rmSync(UNIX_SOCK, { force: true }); rmSync(CANARY_DIR, { recursive: true, force: true })
}
// Capability escapes are observations, but a broken harness or failed recovery
// invalidates the matrix and must make the command fail.
process.exit(all.some((r) => r.verdict === 'HARNESS ERROR' || r.verdict === 'NO RECOVERY') ? 1 : 0)
