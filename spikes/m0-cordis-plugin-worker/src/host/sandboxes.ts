// Host side of the plugin worker: one `Sandbox` interface, several mechanisms behind it (ALI-52, ALI-53).
// Runs under Bun (the app runtime). Everything the plugin sees or returns is a JSON string; the host enforces wall time, size and (where possible) memory.
// Every container, socket and temp dir created here is prefixed `ali38-` and removed by stop().
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Json } from '../sdk/types.ts'

export const SPIKE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = join(SPIKE_DIR, 'tmp')
export const RUN_DIR = process.env.XDG_RUNTIME_DIR || '/tmp' // short path for unix sockets (SUN_LEN)

export interface Limits {
  wallMs: number          // per-call wall clock; the host kills or interrupts when exceeded
  cpuMs: number           // per-call CPU budget, accounted by the host from /proc (processes) or cpu.stat (cgroups); independent of wall time
  memoryMB: number        // guest budget: QuickJS/isolated-vm engine limit and Node heap cap
  cgroupMB?: number       // kernel (cgroup / container) cap for the whole worker incl. runtime baseline; default 256
  maxResultBytes: number  // largest accepted response line
  safetyRssMB: number     // host-side watchdog that protects the workstation even where no other cap exists
  meter?: boolean         // per-call /proc + cgroup accounting (default on). The latency bench turns it off so it does not pollute the numbers
}
export const DEFAULT_LIMITS: Limits = { wallMs: 1500, cpuMs: 1000, memoryMB: 64, maxResultBytes: 256 * 1024, safetyRssMB: 600 }

export type FailKind = 'error' | 'timeout' | 'memory' | 'crash' | 'too-large' | 'protocol'
export type Outcome =
  | { ok: true; result: Json; ms: number }
  | { ok: false; kind: FailKind; message: string; ms: number; detail?: Json }

export interface StartInfo { startMs: number; manifest: any; runtime: string }

export interface Sandbox {
  readonly label: string
  start(): Promise<StartInfo>
  call(hook: string, args: Json[]): Promise<Outcome>
  rssMB(): Promise<number | null>
  alive(): boolean
  restarts: number
  stop(): Promise<void>
}

let rpcId = 1
export const callRequest = (hook: string, args: Json[]) => JSON.stringify({ id: rpcId++, op: 'call', hook, args })
export const loadRequest = (config: Json = {}) => JSON.stringify({ id: rpcId++, op: 'load', config })

function realBin(name: 'bun' | 'node'): string {
  if (name === 'bun') return typeof (globalThis as any).Bun !== 'undefined' ? process.execPath : execFileSync('bun', ['-e', 'console.log(process.execPath)']).toString().trim()
  return execFileSync('node', ['-p', 'process.execPath']).toString().trim()
}
export const BIN = { bun: realBin('bun'), node: realBin('node') }

function vmRssMB(pid: number): number | null {
  try { const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : null } catch { return null }
}
function descendants(pid: number): number[] {
  try {
    const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
    return kids.flatMap((k) => [k, ...descendants(k)])
  } catch { return [] }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------------------------------
/** Host-side measurement of a worker, independent of anything the plugin says: RSS, CPU time, and the kernel's own cgroup counters. */
function cpuTicks(pid: number): number {
  try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8'); const rest = f.slice(f.lastIndexOf(')') + 2).split(' '); return Number(rest[11]) + Number(rest[12]) } catch { return 0 }
}
export interface CallMetrics { peakRssMB: number; cpuMs: number; peakCgroupMB: number | null; oomKills: number | null; cgroup: string | null }
export class Meter {
  peakRssMB = 0; private cpu0 = 0; private cpuNow = 0; peakCgroupMB: number | null = null; oomKills: number | null = null
  constructor(private pidOf: () => number | undefined, private ownCgroup: () => boolean) {}
  /** The worker's own cgroup, or null when it shares its parent's (a bare process): then the cgroup counters would describe the whole login scope, not the worker. */
  cgroupDir(): string | null {
    const pid = this.pidOf(); if (!pid || !this.ownCgroup()) return null
    try { const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').pop()!; const path = line.split('::')[1]; return path && path !== '/' ? '/sys/fs/cgroup' + path : null } catch { return null }
  }
  private pids(): number[] { const pid = this.pidOf(); return pid ? [pid, ...descendants(pid)] : [] }
  begin() { this.peakRssMB = 0; this.peakCgroupMB = null; this.oomKills = null; this.cpu0 = this.pids().reduce((n, p) => n + cpuTicks(p), 0); this.cpuNow = this.cpu0; this.cg = this.cgroupDir() }
  private cg: string | null = null
  /** One sample. Returns total RSS (MB) and CPU used since begin() (ms). Cheap: a few /proc reads. */
  tick(): { rssMB: number; cpuMs: number } {
    const pids = this.pids()
    const rssMB = pids.reduce((n, p) => n + (vmRssMB(p) ?? 0), 0)
    this.cpuNow = Math.max(this.cpuNow, pids.reduce((n, p) => n + cpuTicks(p), 0))
    this.peakRssMB = Math.max(this.peakRssMB, rssMB)
    if (this.cg) {
      try { this.peakCgroupMB = Math.max(this.peakCgroupMB ?? 0, Number(readFileSync(this.cg + '/memory.peak', 'utf8')) / 1048576) } catch {}
      try { const m = /oom_kill (\d+)/.exec(readFileSync(this.cg + '/memory.events', 'utf8')); if (m) this.oomKills = Number(m[1]) } catch {}
    }
    return { rssMB, cpuMs: (this.cpuNow - this.cpu0) * 10 }
  }
  snapshot(): CallMetrics { return { peakRssMB: +this.peakRssMB.toFixed(1), cpuMs: (this.cpuNow - this.cpu0) * 10, peakCgroupMB: this.peakCgroupMB === null ? null : +this.peakCgroupMB.toFixed(1), oomKills: this.oomKills, cgroup: this.cg ? this.cg.replace(/^\/sys\/fs\/cgroup/, '').replace(/\d{3,}/g, 'N') : null } }
}
/** Async on purpose: the app's event loop must never block on a container-runtime CLI call. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) => { const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; p.stdout.on('data', (d: Buffer) => { out += d }); p.on('error', () => res('')); p.on('exit', () => res(out)) })
}
async function containerPid(name: string): Promise<number | undefined> { const n = Number((await run('podman', ['inspect', '-f', '{{.State.Pid}}', name])).trim()); return n > 0 ? n : undefined }
const podmanKill = (name: string) => { try { spawn('podman', ['kill', '--signal', 'KILL', name], { stdio: 'ignore' }).unref() } catch {} }

// ---------------------------------------------------------------------------------------------------------------------
export type Wrap = 'none' | 'cgroup' | 'bwrap' | 'podman'
export interface ProcessOptions {
  label: string
  engine: 'native' | 'quickjs' | 'ivm'
  runtime: 'bun' | 'node'
  wrap: Wrap
  pluginPath: string                 // absolute host path of the plugin's server entry
  limits?: Partial<Limits>
  nodePermission?: boolean           // node --permission with read access to exactly the worker dir, node_modules and the plugin dir
  env?: Record<string, string>       // the env the child gets. Default: empty
  cwd?: string
}

/** A child process speaking line-delimited JSON. `wrap` adds OS confinement around it (cgroup limits, bubblewrap, rootless podman). */
export class ProcessSandbox implements Sandbox {
  label: string
  restarts = 0
  lastMetrics: CallMetrics | null = null
  private child: ChildProcess | null = null
  private buf = ''
  private waiter: ((line: string | null, why?: FailKind) => void) | null = null
  private containerName = ''
  private cpid: number | undefined
  private limits: Limits
  private meter = new Meter(() => this.cpid ?? this.child?.pid, () => this.o.wrap !== 'none')
  private stderrTail = ''
  private killedBy: 'rss' | 'cpu' | null = null
  private killedAt = 0
  constructor(private o: ProcessOptions) { this.label = o.label; this.limits = { ...DEFAULT_LIMITS, ...o.limits } }

  /** The path of the plugin's server entry as the plugin itself sees it (differs inside bubblewrap and containers). */
  get pluginPathInside() { return this.o.wrap === 'bwrap' || this.o.wrap === 'podman' ? `/plugin/${basename(this.o.pluginPath)}` : this.o.pluginPath }

  private argv(): { cmd: string; args: string[] } {
    const o = this.o, L = this.limits
    const bin = BIN[o.runtime]
    const confined = o.wrap === 'bwrap' || o.wrap === 'podman'
    const workerDir = join(SPIKE_DIR, 'src/worker'), modulesDir = join(SPIKE_DIR, 'node_modules'), pluginDir = dirname(o.pluginPath)
    // What the child can read is exactly: the worker code, node_modules (for the engines) and the plugin package. Not the rest of the spike, not $HOME.
    const child = confined ? '/app/worker/child.mjs' : join(workerDir, 'child.mjs')
    const a: string[] = []
    if (o.runtime === 'node') {
      a.push(`--max-old-space-size=${L.memoryMB}`)
      if (o.nodePermission) a.push('--permission', `--allow-fs-read=${workerDir}`, `--allow-fs-read=${modulesDir}`, `--allow-fs-read=${pluginDir}`)
    }
    a.push(child, '--engine', o.engine, '--plugin', this.pluginPathInside, '--mem-mb', String(Math.min(L.memoryMB, 48)), '--wall-ms', String(L.wallMs))
    const scope = ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${L.cgroupMB ?? 256}M`, '-p', 'MemorySwapMax=0', '-p', 'TasksMax=32', '-p', 'CPUQuota=100%']
    if (o.wrap === 'none') return { cmd: bin, args: a }
    if (o.wrap === 'cgroup') return { cmd: 'systemd-run', args: [...scope, '--', bin, ...a] }
    if (o.wrap === 'bwrap') {
      return {
        cmd: 'systemd-run',
        args: [...scope, '--', 'bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
          '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
          '--ro-bind', workerDir, '/app/worker', '--ro-bind', modulesDir, '/app/node_modules', '--ro-bind', pluginDir, '/plugin', '--ro-bind', dirname(bin), '/rt/bin',
          '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', '/tmp', `/rt/bin/${basename(bin)}`, ...a],
      }
    }
    // rootless podman: no network, read-only root, no capabilities, cgroup limits; only the three read-only mounts and the runtime binary
    this.containerName = `ali38-pw-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
    return {
      cmd: 'podman',
      args: ['run', '--rm', '-i', '--name', this.containerName, '--network', 'none', '--read-only', '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
        '--memory', `${L.cgroupMB ?? 256}m`, '--memory-swap', `${L.cgroupMB ?? 256}m`, '--pids-limit', '32', '--cpus', '1', '--env-host=false', '--no-hosts', '--tmpfs', '/tmp:size=8m,noexec',
        '-v', `${workerDir}:/app/worker:ro`, '-v', `${modulesDir}:/app/node_modules:ro`, '-v', `${pluginDir}:/plugin:ro`, '-v', `${dirname(bin)}:/rt/bin:ro`, '--workdir', '/tmp',
        'docker.io/library/debian:13', `/rt/bin/${basename(bin)}`, ...a],
    }
  }

  async start(): Promise<StartInfo> {
    const t0 = performance.now()
    const { cmd, args } = this.argv()
    const env = { ...(this.o.env ?? {}) }
    if (this.o.wrap === 'cgroup' || this.o.wrap === 'bwrap') Object.assign(env, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${process.env.XDG_RUNTIME_DIR}/bus` })
    if (this.o.wrap === 'podman') Object.assign(env, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, HOME: process.env.HOME!, PATH: process.env.PATH! })
    this.cpid = undefined; this.exit = null; this.stderrTail = ''
    const proc = spawn(cmd, args, { env, cwd: this.o.cwd ?? TMP, stdio: ['pipe', 'pipe', 'pipe'], detached: false })
    this.child = proc
    this.buf = ''
    proc.stdout!.on('data', (d: Buffer) => { if (this.child === proc) this.onData(d) })
    proc.stderr!.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000) })
    // Only the CURRENT process may clear `child`: a late exit event from a killed predecessor must not null its replacement.
    this.exited = new Promise<void>((res) => proc.on('exit', (code, signal) => { if (this.child === proc) { this.exit = { code, signal }; this.child = null; this.waiter?.(null, 'crash') } res() }))
    // Rootless Podman can queue behind another spike on this shared workstation.
    // Startup is not part of the per-hook wall budget; leave room for store contention.
    const ready = await this.nextLine(60_000)
    if (!ready.line) throw new Error(`${this.label}: child did not become ready (${ready.why}) ${this.stderrTail.slice(-300)}`)
    const info = JSON.parse(ready.line)
    if (this.o.wrap === 'podman') this.cpid = await containerPid(this.containerName)
    const load = await this.roundTrip(loadRequest(), 10_000)
    if (!load.ok) throw new Error(`${this.label}: load failed: ${load.message}`)
    return { startMs: performance.now() - t0, manifest: load.result, runtime: `${info.runtime} / ${info.engine}` }
  }
  exit: { code: number | null; signal: string | null } | null = null
  private exited: Promise<void> = Promise.resolve()
  /** Kill and wait until the OS has reaped the process, so the next call sees a dead worker and restarts it instead of writing into a corpse. */
  private async killAndWait() { const p = this.exited; this.killNow(); await Promise.race([p, sleep(2000)]); await sleep(10) }

  private onData(d: Buffer) {
    this.buf += d.toString('utf8')
    if (this.buf.length > this.limits.maxResultBytes && !this.buf.includes('\n')) { this.waiter?.(null, 'too-large'); return }
    const nl = this.buf.indexOf('\n')
    if (nl >= 0) {
      const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1)
      if (line.length > this.limits.maxResultBytes) { this.waiter?.(null, 'too-large'); return }
      this.waiter?.(line)
    }
  }
  private nextLine(ms: number): Promise<{ line: string | null; why?: FailKind }> {
    return new Promise((res) => {
      const nl = this.buf.indexOf('\n')
      if (nl >= 0) { const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1); return res({ line }) }
      const metering = this.limits.meter !== false
      if (metering) this.meter.begin()
      const timer = setTimeout(() => { this.waiter = null; res({ line: null, why: 'timeout' }) }, ms)
      const watchdog = setInterval(() => { // host-side accounting: kills runaway memory (workstation safety) and CPU over budget, whatever the worker does
        if (!this.child) return
        const { rssMB, cpuMs } = metering ? this.meter.tick() : { rssMB: this.quickRss(), cpuMs: 0 }
        if (rssMB > this.limits.safetyRssMB) { this.killedBy = 'rss'; this.killedAt = rssMB; this.killNow() }
        else if (cpuMs > this.limits.cpuMs && this.cpuBudgetApplies) { this.killedBy = 'cpu'; this.killedAt = cpuMs; this.killNow() }
      }, 15)
      this.waiter = (line, why) => { clearTimeout(timer); clearInterval(watchdog); if (metering) { this.meter.tick(); this.lastMetrics = this.meter.snapshot() } this.waiter = null; res({ line, why }) }
    })
  }
  cpuBudgetApplies = true
  private quickRss(): number { const pid = this.cpid ?? this.child?.pid; return pid ? [pid, ...descendants(pid)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0) : 0 }

  private killNow() {
    try {
      if (this.o.wrap === 'podman' && this.containerName) podmanKill(this.containerName)
      const pid = this.child?.pid
      if (pid) for (const p of [...descendants(pid), pid].reverse()) { try { process.kill(p, 'SIGKILL') } catch {} }
      if (this.cpid) { try { process.kill(this.cpid, 'SIGKILL') } catch {} }
    } catch {}
  }

  private async roundTrip(json: string, ms: number): Promise<Outcome> {
    const t0 = performance.now()
    if (!this.child) return { ok: false, kind: 'crash', message: 'not running', ms: 0 }
    this.killedBy = null; this.killedAt = 0
    this.child.stdin!.write(json + '\n')
    const { line, why } = await this.nextLine(ms)
    const elapsed = performance.now() - t0
    if (line === null) {
      const by = this.killedBy
      await this.killAndWait()
      const cgMB = this.lastMetrics?.peakCgroupMB ?? 0, cap = this.limits.cgroupMB ?? 256
      const kernelOom = (this.lastMetrics?.oomKills ?? 0) > 0 || (!by && (this.exit?.signal === 'SIGKILL' || this.exit?.code === 137) && cgMB >= 0.85 * cap) // inferred: killed, not by us, with the cgroup at its cap
      const oom = kernelOom || /heap out of memory|JavaScript heap|out of memory|ENOMEM/i.test(this.stderrTail)
      const kind: FailKind = why === 'too-large' ? 'too-large' : by === 'rss' || oom ? 'memory' : by === 'cpu' || why === 'timeout' ? 'timeout' : 'crash'
      const msg = by === 'rss' ? `host RSS watchdog killed the worker at ${this.killedAt.toFixed(0)} MB`
        : by === 'cpu' ? `host CPU budget exceeded (${this.killedAt} ms of CPU used, budget ${this.limits.cpuMs} ms): worker killed`
        : oom ? `worker died from memory exhaustion (${kernelOom ? 'kernel cgroup OOM kill, peak ' + cgMB + ' MB of ' + cap + ' MB' : 'runtime heap limit'}; exit ${JSON.stringify(this.exit)})`
        : kind === 'crash' ? `worker exited (${JSON.stringify(this.exit)})` : `${kind} after ${elapsed.toFixed(0)} ms (worker killed)`
      return { ok: false, kind, message: msg, ms: elapsed, detail: this.exit as any }
    }
    let r: any
    try { r = JSON.parse(line) } catch { return { ok: false, kind: 'protocol', message: 'unparseable response line', ms: elapsed } }
    if (r.ok) return { ok: true, result: r.result, ms: elapsed }
    const k = r.error?.name === 'LimitError' ? (r.error.kind as FailKind) : 'error'
    return { ok: false, kind: k, message: `${r.error?.name}: ${r.error?.message}`, ms: elapsed }
  }

  async call(hook: string, args: Json[]): Promise<Outcome> {
    if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) await Promise.race([this.exited, sleep(500)]) // exited but the event is not delivered yet
    if (!this.child) { this.restarts++; const t0 = performance.now(); await this.start(); this.lastRestartMs = performance.now() - t0 }
    return this.roundTrip(callRequest(hook, args), this.limits.wallMs + (this.o.engine === 'native' ? 0 : 400))
  }
  lastRestartMs = 0

  async rssMB(): Promise<number | null> {
    const pid = this.cpid ?? this.child?.pid
    if (!pid) return null
    return [pid, ...descendants(pid)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0)
  }
  /** Number of processes currently alive inside the worker's cgroup or process tree (for the fork test). */
  liveProcesses(): number {
    const cg = this.meter.cgroupDir()
    if (cg) { try { return Number(readFileSync(cg + '/pids.current', 'utf8')) } catch {} }
    const pid = this.child?.pid; return pid ? 1 + descendants(pid).length : 0
  }
  alive() { return !!this.child }
  async stop() {
    if (!this.child) return
    try { this.child.stdin!.end() } catch {}
    await sleep(30)
    if (this.child) await this.killAndWait()
    if (this.o.wrap === 'podman' && this.containerName) await run('podman', ['rm', '-f', '-t', '0', this.containerName])
    await sleep(30)
  }
}

// ---------------------------------------------------------------------------------------------------------------------
/** An engine inside the host process itself (QuickJS-wasm under Bun). Fast, but the guest runs on the host's thread. */
export class InProcessSandbox implements Sandbox {
  label: string; restarts = 0
  private engine: any = null
  private baseRss = 0
  private limits: Limits
  constructor(private o: { label: string; engine: 'quickjs'; pluginPath: string; limits?: Partial<Limits> }) { this.label = o.label; this.limits = { ...DEFAULT_LIMITS, ...o.limits } }
  async start(): Promise<StartInfo> {
    const t0 = performance.now()
    this.baseRss = process.memoryUsage().rss
    const { createEngine } = await import('../worker/engines.mjs')
    this.engine = await createEngine(this.o.engine, { pluginPath: this.o.pluginPath, memoryBytes: Math.min(this.limits.memoryMB, 48) * 1048576, wallMs: this.limits.wallMs })
    const manifest = await this.engine.load({})
    return { startMs: performance.now() - t0, manifest, runtime: `in-process ${typeof (globalThis as any).Bun !== 'undefined' ? 'bun ' + (globalThis as any).Bun.version : 'node'} / ${this.o.engine}` }
  }
  async call(hook: string, args: Json[]): Promise<Outcome> {
    if (!this.engine) { this.restarts++; await this.start() }
    const t0 = performance.now()
    try {
      const line: string = await this.engine.call(callRequest(hook, args), this.limits.wallMs)
      const ms = performance.now() - t0
      if (line.length > this.limits.maxResultBytes) return { ok: false, kind: 'too-large', message: `response ${line.length} bytes`, ms }
      const r = JSON.parse(line)
      return r.ok ? { ok: true, result: r.result, ms } : { ok: false, kind: 'error', message: `${r.error?.name}: ${r.error?.message}`, ms }
    } catch (e: any) {
      const ms = performance.now() - t0
      if (e?.name === 'LimitError') { if (e.kind === 'memory') { try { this.engine.close() } catch {} this.engine = null } return { ok: false, kind: e.kind, message: e.message, ms } }
      return { ok: false, kind: 'error', message: String(e?.message ?? e), ms }
    }
  }
  /** Incremental host RSS since start(): the guest's cost to the app process. */
  async rssMB() { return this.engine ? (process.memoryUsage().rss - this.baseRss) / 1048576 : null }
  alive() { return !!this.engine }
  async stop() { try { this.engine?.close() } catch {} this.engine = null }
}

// ---------------------------------------------------------------------------------------------------------------------
export interface WorkerdOptions { label: string; pluginPath: string; wrap?: 'none' | 'cgroup' | 'bwrap' | 'podman'; limits?: Partial<Limits>; compatFlags?: string[] }

/** workerd (Cloudflare's open-source Workers runtime) as a child process serving the plugin module over a unix socket. */
export class WorkerdSandbox implements Sandbox {
  label: string; restarts = 0
  private child: ChildProcess | null = null
  private dir = ''
  private sock = ''
  private limits: Limits
  private containerName = ''
  private cpid: number | undefined
  private meter = new Meter(() => this.cpid ?? this.child?.pid, () => (this.o.wrap ?? 'none') !== 'none')
  lastMetrics: CallMetrics | null = null
  private killedBy: 'rss' | 'cpu' | null = null
  private exited: Promise<void> = Promise.resolve()
  exit: any = null
  constructor(private o: WorkerdOptions) { this.label = o.label; this.limits = { ...DEFAULT_LIMITS, ...o.limits } }

  private writeConfig(sockPath: string) {
    this.dir = join(TMP, `ali38-wd-${process.pid}-${Math.random().toString(36).slice(2, 7)}`)
    mkdirSync(this.dir, { recursive: true })
    copyFileSync(join(SPIKE_DIR, 'src/worker/glue.mjs'), join(this.dir, 'glue.mjs'))
    copyFileSync(this.o.pluginPath, join(this.dir, 'plugin.mjs'))
    writeFileSync(join(this.dir, 'entry.mjs'), `import { createHandler } from 'glue'
import * as plugin from 'plugin'
const handle = createHandler(plugin)
export default { async fetch(request) { return new Response(await handle(await request.text()), { headers: { 'content-type': 'application/json' } }) } }
`)
    const flags = (this.o.compatFlags ?? []).map((f) => `"${f}"`).join(', ')
    writeFileSync(join(this.dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "plugin", worker = .pluginWorker), (name = "deny", worker = .denyWorker) ],
  sockets = [ (name = "rpc", address = "unix:${sockPath}", http = (), service = "plugin") ],
);
const pluginWorker :Workerd.Worker = (
  modules = [ (name = "entry", esModule = embed "entry.mjs"), (name = "glue", esModule = embed "glue.mjs"), (name = "plugin", esModule = embed "plugin.mjs") ],
  compatibilityDate = "2025-01-01",
  compatibilityFlags = [${flags}],
  globalOutbound = "deny",
);
const denyWorker :Workerd.Worker = (
  modules = [ (name = "deny", esModule = "export default { fetch() { return new Response('outbound denied', { status: 403 }) } }") ],
  compatibilityDate = "2025-01-01",
);
`)
  }

  async start(): Promise<StartInfo> {
    const t0 = performance.now()
    const wd = join(SPIKE_DIR, 'node_modules/@cloudflare/workerd-linux-64/bin/workerd')
    const L = this.limits
    const insideDir = this.o.wrap === 'podman' || this.o.wrap === 'bwrap'
    this.sock = join(RUN_DIR, `ali38-wd-${process.pid}-${Math.random().toString(36).slice(2, 7)}.sock`)
    this.writeConfig(insideDir ? '/sock/rpc.sock' : this.sock)
    let cmd = wd, args = ['serve', join(this.dir, 'config.capnp')]
    if (this.o.wrap === 'cgroup') { cmd = 'systemd-run'; args = ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${L.cgroupMB ?? 256}M`, '-p', 'MemorySwapMax=0', '-p', 'TasksMax=64', '--', wd, ...args] }
    if (this.o.wrap === 'podman') {
      this.containerName = `ali38-wd-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
      const sockDir = join(RUN_DIR, `ali38-sockdir-${process.pid}-${Math.random().toString(36).slice(2, 7)}`); mkdirSync(sockDir, { recursive: true }); this.sockDir = sockDir; this.sock = join(sockDir, 'rpc.sock')
      cmd = 'podman'
      args = ['run', '--rm', '-i', '--name', this.containerName, '--network', 'none', '--read-only', '--cap-drop', 'all', '--security-opt', 'no-new-privileges', '--memory', `${L.cgroupMB ?? 256}m`, '--memory-swap', `${L.cgroupMB ?? 256}m`, '--pids-limit', '64', '--cpus', '1', '--env-host=false', '--no-hosts', '--tmpfs', '/tmp:size=8m',
        '-v', `${this.dir}:/cfg:ro`, '-v', `${dirname(wd)}:/wd:ro`, '-v', `${sockDir}:/sock`,
        // workerd refuses to start without a CA bundle even when it has no network (it initialises its default `internet` TLS service). A slim image lacks one.
        '-v', '/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro', '--workdir', '/cfg', 'docker.io/library/debian:13', '/wd/workerd', 'serve', '/cfg/config.capnp']
    }
    const env: Record<string, string> = this.o.wrap === 'none' ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, HOME: process.env.HOME!, PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: `unix:path=${process.env.XDG_RUNTIME_DIR}/bus` }
    const proc = spawn(cmd, args, { env, cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = proc
    let stderr = ''
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.stdout!.on('data', () => {})
    this.exited = new Promise<void>((res) => proc.on('exit', (code, signal) => { if (this.child === proc) { this.exit = { code, signal }; this.child = null } res() }))
    let up = false
    for (let i = 0; i < 600 && !up; i++) { // wait until the socket ACCEPTS connections: a file can exist before listen(), or be stale from a dead predecessor
      if (!this.child) throw new Error(`${this.label}: workerd exited early: ${stderr.slice(0, 400)}`)
      up = existsSync(this.sock) && await new Promise<boolean>((r) => { const c = net.connect(this.sock); c.on('connect', () => { c.destroy(); r(true) }); c.on('error', () => r(false)) })
      if (!up) await sleep(10)
    }
    if (!up) throw new Error(`${this.label}: workerd socket never accepted connections: ${stderr.slice(0, 400)}`)
    this.cpid = this.o.wrap === 'podman' ? await containerPid(this.containerName) : undefined
    const load = await this.post(loadRequest(), 10_000)
    if (!load.ok) throw new Error(`${this.label}: load failed: ${load.message}`)
    return { startMs: performance.now() - t0, manifest: load.result, runtime: `workerd ${execFileSync(wd, ['--version']).toString().trim()}${this.o.wrap && this.o.wrap !== 'none' ? ' in ' + this.o.wrap : ''}` }
  }

  private async post(body: string, ms: number): Promise<Outcome> {
    const out = await this.postInner(body, ms)
    if (this.pendingKill) { this.pendingKill = false; const p = this.exited; await Promise.race([p, sleep(2000)]); await sleep(10) }
    return out
  }
  private pendingKill = false
  private sockDir = ''
  private postInner(body: string, ms: number): Promise<Outcome> {
    const t0 = performance.now()
    return new Promise((res) => {
      let done = false
      const finish = (o: Outcome) => { if (!done) { done = true; clearTimeout(timer); clearInterval(watchdog); if (this.limits.meter !== false) { this.meter.tick(); this.lastMetrics = this.meter.snapshot() } res(o) } }
      const timer = setTimeout(() => { this.pendingKill = true; this.killNow(); finish({ ok: false, kind: 'timeout', message: `timeout after ${(performance.now() - t0).toFixed(0)} ms (workerd killed: it has no per-request CPU or wall limit of its own)`, ms: performance.now() - t0 }) }, ms)
      const metering = this.limits.meter !== false
      if (metering) this.meter.begin()
      this.killedBy = null
      const watchdog = setInterval(() => {
        if (!this.child) return
        const { rssMB, cpuMs } = metering ? this.meter.tick() : { rssMB: [this.child.pid!, ...descendants(this.child.pid!)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0), cpuMs: 0 }
        if (rssMB > this.limits.safetyRssMB) { this.killedBy = 'rss'; this.pendingKill = true; this.killNow(); finish({ ok: false, kind: 'memory', message: `host RSS watchdog killed workerd at ${rssMB.toFixed(0)} MB (workerd has no memory limit option of its own)`, ms: performance.now() - t0 }) }
        else if (cpuMs > this.limits.cpuMs) { this.killedBy = 'cpu'; this.pendingKill = true; this.killNow(); finish({ ok: false, kind: 'timeout', message: `host CPU budget exceeded (${cpuMs} ms used, budget ${this.limits.cpuMs} ms): workerd killed (it has no CPU limit of its own)`, ms: performance.now() - t0 }) }
      }, 15)
      const req = http.request({ socketPath: this.sock, method: 'POST', path: '/', headers: { 'content-length': Buffer.byteLength(body) } }, (r) => {
        const chunks: Buffer[] = []; let size = 0
        r.on('data', (c: Buffer) => { size += c.length; if (size > this.limits.maxResultBytes) { req.destroy(); this.pendingKill = true; this.killNow(); finish({ ok: false, kind: 'too-large', message: `response over ${this.limits.maxResultBytes} bytes`, ms: performance.now() - t0 }); return } chunks.push(c) })
        r.on('end', () => {
          const ms2 = performance.now() - t0
          if (r.statusCode !== 200) return finish({ ok: false, kind: 'error', message: `HTTP ${r.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`, ms: ms2 })
          try { const j = JSON.parse(Buffer.concat(chunks).toString()); finish(j.ok ? { ok: true, result: j.result, ms: ms2 } : { ok: false, kind: 'error', message: `${j.error?.name}: ${j.error?.message}`, ms: ms2 }) } catch { finish({ ok: false, kind: 'protocol', message: 'bad json', ms: ms2 }) }
        })
      })
      req.on('error', (e) => {
        // A container may have died while the podman client is still alive.
        // Retire that client so the next call starts a fresh container/socket.
        this.pendingKill = true
        this.killNow()
        finish({ ok: false, kind: 'crash', message: `${e.message} (exit ${JSON.stringify(this.exit)})`, ms: performance.now() - t0 })
      })
      req.end(body)
    })
  }

  private killNow() {
    try {
      if (this.o.wrap === 'podman' && this.containerName) podmanKill(this.containerName)
      const pid = this.child?.pid
      if (pid) for (const p of [...descendants(pid), pid].reverse()) { try { process.kill(p, 'SIGKILL') } catch {} }
      if (this.cpid) { try { process.kill(this.cpid, 'SIGKILL') } catch {} }
    } catch {}
  }
  async call(hook: string, args: Json[]): Promise<Outcome> {
    if (this.child && (this.child.exitCode !== null || this.child.signalCode !== null)) await Promise.race([this.exited, sleep(500)])
    if (!this.child) { this.restarts++; this.cleanupFiles(); await this.start() }
    return this.post(callRequest(hook, args), this.limits.wallMs)
  }
  async rssMB() { const pid = this.child?.pid; if (!pid) return null; return [pid, ...descendants(pid)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0) }
  alive() { return !!this.child }
  private cleanupFiles() { try { rmSync(this.sock, { force: true }) } catch {} try { rmSync(this.dir, { recursive: true, force: true }) } catch {} if (this.sockDir) try { rmSync(this.sockDir, { recursive: true, force: true }) } catch {} }
  async stop() {
    if (this.child) { const p = this.exited; this.killNow(); await Promise.race([p, sleep(2000)]) }
    if (this.o.wrap === 'podman' && this.containerName) await run('podman', ['rm', '-f', '-t', '0', this.containerName])
    await sleep(50)
    this.cleanupFiles()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
export interface Candidate { id: string; make(pluginPath: string, limits?: Partial<Limits>): Sandbox; note: string }

/** The matrix used by the latency bench and the hostile-plugin tests. `id`s are stable and cited in the ADR. */
export const CANDIDATES: Candidate[] = [
  { id: 'proc-bun', note: 'plain Bun child process, empty env, no confinement', make: (p, l) => new ProcessSandbox({ label: 'proc-bun', engine: 'native', runtime: 'bun', wrap: 'none', pluginPath: p, limits: l }) },
  { id: 'proc-node', note: 'plain Node child process, empty env, no confinement', make: (p, l) => new ProcessSandbox({ label: 'proc-node', engine: 'native', runtime: 'node', wrap: 'none', pluginPath: p, limits: l }) },
  { id: 'proc-node-perm', note: 'Node child with --permission (fs read limited to the spike dir)', make: (p, l) => new ProcessSandbox({ label: 'proc-node-perm', engine: 'native', runtime: 'node', wrap: 'none', nodePermission: true, pluginPath: p, limits: l }) },
  { id: 'proc-bun-cgroup', note: 'Bun child in a systemd user cgroup scope (MemoryMax, TasksMax, CPUQuota)', make: (p, l) => new ProcessSandbox({ label: 'proc-bun-cgroup', engine: 'native', runtime: 'bun', wrap: 'cgroup', pluginPath: p, limits: l }) },
  { id: 'proc-bun-bwrap', note: 'Bun child in bubblewrap (all namespaces unshared, ro mounts) inside a cgroup scope', make: (p, l) => new ProcessSandbox({ label: 'proc-bun-bwrap', engine: 'native', runtime: 'bun', wrap: 'bwrap', pluginPath: p, limits: l }) },
  { id: 'proc-bun-podman', note: 'Bun child in a rootless podman container: --network none, read-only, cap-drop all, memory/pids/cpu limits', make: (p, l) => new ProcessSandbox({ label: 'proc-bun-podman', engine: 'native', runtime: 'bun', wrap: 'podman', pluginPath: p, limits: l }) },
  { id: 'quickjs-inproc', note: 'QuickJS-wasm inside the Bun host process', make: (p, l) => new InProcessSandbox({ label: 'quickjs-inproc', engine: 'quickjs', pluginPath: p, limits: l }) },
  { id: 'quickjs-bun', note: 'QuickJS-wasm inside a plain Bun child process', make: (p, l) => new ProcessSandbox({ label: 'quickjs-bun', engine: 'quickjs', runtime: 'bun', wrap: 'none', pluginPath: p, limits: l }) },
  { id: 'quickjs-bun-podman', note: 'QuickJS-wasm in a Bun child inside the rootless podman container', make: (p, l) => new ProcessSandbox({ label: 'quickjs-bun-podman', engine: 'quickjs', runtime: 'bun', wrap: 'podman', pluginPath: p, limits: l }) },
  { id: 'ivm-node', note: 'isolated-vm inside a plain Node child process (Bun cannot load the addon)', make: (p, l) => new ProcessSandbox({ label: 'ivm-node', engine: 'ivm', runtime: 'node', wrap: 'none', pluginPath: p, limits: l }) },
  { id: 'ivm-node-podman', note: 'isolated-vm in a Node child inside the rootless podman container', make: (p, l) => new ProcessSandbox({ label: 'ivm-node-podman', engine: 'ivm', runtime: 'node', wrap: 'podman', pluginPath: p, limits: l }) },
  { id: 'workerd', note: 'workerd child process, globalOutbound = deny worker, unix socket RPC', make: (p, l) => new WorkerdSandbox({ label: 'workerd', pluginPath: p, wrap: 'none', limits: l }) },
  { id: 'workerd-cgroup', note: 'workerd in a systemd user cgroup scope', make: (p, l) => new WorkerdSandbox({ label: 'workerd-cgroup', pluginPath: p, wrap: 'cgroup', limits: l }) },
  { id: 'workerd-podman', note: 'workerd in the rootless podman container', make: (p, l) => new WorkerdSandbox({ label: 'workerd-podman', pluginPath: p, wrap: 'podman', limits: l }) },
]
