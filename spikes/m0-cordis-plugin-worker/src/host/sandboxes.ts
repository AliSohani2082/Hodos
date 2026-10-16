// Host side of the plugin worker: one `Sandbox` interface, several mechanisms behind it (ALI-52, ALI-53).
// Runs under Bun (the app runtime). Everything the plugin sees or returns is a JSON string; the host enforces wall time, size and (where possible) memory.
// Every container, socket and temp dir created here is prefixed `ali38-` and removed by stop().
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Json } from '../sdk/types.ts'

export const SPIKE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = join(SPIKE_DIR, 'tmp')
export const RUN_DIR = process.env.XDG_RUNTIME_DIR || '/tmp' // short path for unix sockets (SUN_LEN)

export interface Limits {
  wallMs: number          // per-call wall clock; the host kills or interrupts when exceeded
  memoryMB: number        // engine/cgroup/container memory cap
  maxResultBytes: number  // largest accepted response line
  safetyRssMB: number     // host-side watchdog that protects the workstation even where no other cap exists
}
export const DEFAULT_LIMITS: Limits = { wallMs: 1500, memoryMB: 64, maxResultBytes: 256 * 1024, safetyRssMB: 900 }

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
export type Wrap = 'none' | 'cgroup' | 'bwrap' | 'podman'
export interface ProcessOptions {
  label: string
  engine: 'native' | 'quickjs' | 'ivm'
  runtime: 'bun' | 'node'
  wrap: Wrap
  pluginPath: string                 // absolute path on the host; must live under SPIKE_DIR
  limits?: Partial<Limits>
  nodePermission?: boolean           // node --permission --allow-fs-read=<SPIKE_DIR>
  env?: Record<string, string>       // the env the child gets. Default: empty
  cwd?: string
}

/** A child process speaking line-delimited JSON. `wrap` adds OS confinement around it (cgroup limits, bubblewrap, rootless podman). */
export class ProcessSandbox implements Sandbox {
  label: string
  restarts = 0
  private child: ChildProcess | null = null
  private buf = ''
  private waiter: ((line: string | null, why?: FailKind) => void) | null = null
  private containerName = ''
  private limits: Limits
  private lastRuntime = ''
  private tooLarge = false
  constructor(private o: ProcessOptions) { this.label = o.label; this.limits = { ...DEFAULT_LIMITS, ...o.limits } }

  private argv(): { cmd: string; args: string[] } {
    const o = this.o, L = this.limits
    const bin = BIN[o.runtime]
    const inner = (root: string, rt: string) => {
      const a: string[] = []
      if (o.runtime === 'node') {
        a.push(`--max-old-space-size=${L.memoryMB}`)
        if (o.nodePermission) a.push('--permission', `--allow-fs-read=${root}`)
      }
      a.push(`${root}/src/worker/child.mjs`, '--engine', o.engine, '--plugin', o.pluginPath.replace(SPIKE_DIR, root), '--mem-mb', String(Math.min(L.memoryMB, 48)), '--wall-ms', String(L.wallMs))
      return { rt, a }
    }
    if (o.wrap === 'none' || o.wrap === 'cgroup') {
      const { a } = inner(SPIKE_DIR, bin)
      if (o.wrap === 'none') return { cmd: bin, args: a }
      return { cmd: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${L.memoryMB}M`, '-p', 'MemorySwapMax=0', '-p', 'TasksMax=32', '-p', 'CPUQuota=100%', '--', bin, ...a] }
    }
    if (o.wrap === 'bwrap') {
      const { a } = inner('/spike', '/rt/bin')
      const rtDir = dirname(bin)
      return {
        cmd: 'systemd-run',
        args: ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${L.memoryMB}M`, '-p', 'MemorySwapMax=0', '-p', 'TasksMax=32', '--', 'bwrap',
          '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
          '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
          '--ro-bind', SPIKE_DIR, '/spike', '--ro-bind', rtDir, '/rt/bin', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
          '--chdir', '/tmp', `/rt/bin/${bin.split('/').pop()}`, ...a],
      }
    }
    // rootless podman: no network, read-only root, no capabilities, cgroup limits, only the spike dir and the runtime binary dir mounted read-only
    this.containerName = `ali38-pw-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
    const { a } = inner('/spike', '/rt/bin')
    return {
      cmd: 'podman',
      args: ['run', '--rm', '-i', '--name', this.containerName, '--network', 'none', '--read-only', '--cap-drop', 'all', '--security-opt', 'no-new-privileges',
        '--memory', `${L.memoryMB}m`, '--memory-swap', `${L.memoryMB}m`, '--pids-limit', '32', '--cpus', '1', '--env-host=false', '--no-hosts', '--tmpfs', '/tmp:size=8m,noexec',
        '-v', `${SPIKE_DIR}:/spike:ro`, '-v', `${dirname(bin)}:/rt/bin:ro`, '--workdir', '/tmp',
        'docker.io/library/debian:13', `/rt/bin/${bin.split('/').pop()}`, ...a],
    }
  }

  async start(): Promise<StartInfo> {
    const t0 = performance.now()
    const { cmd, args } = this.argv()
    const env = { ...(this.o.env ?? {}) }
    if (this.o.wrap === 'cgroup' || this.o.wrap === 'bwrap') Object.assign(env, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${process.env.XDG_RUNTIME_DIR}/bus` })
    if (this.o.wrap === 'podman') Object.assign(env, { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, HOME: process.env.HOME!, PATH: process.env.PATH! })
    this.child = spawn(cmd, args, { env, cwd: this.o.cwd ?? TMP, stdio: ['pipe', 'pipe', 'pipe'], detached: false })
    this.buf = ''; this.tooLarge = false
    this.child.stdout!.on('data', (d: Buffer) => this.onData(d))
    this.child.stderr!.on('data', () => {})
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; this.waiter?.(null, 'crash'); this.child = null })
    const ready = await this.nextLine(10_000)
    if (!ready.line) throw new Error(`${this.label}: child did not become ready (${ready.why})`)
    const info = JSON.parse(ready.line)
    this.lastRuntime = `${info.runtime} / ${info.engine}`
    const load = await this.roundTrip(loadRequest(), 10_000)
    if (!load.ok) throw new Error(`${this.label}: load failed: ${load.message}`)
    return { startMs: performance.now() - t0, manifest: load.result, runtime: this.lastRuntime }
  }
  exit: { code: number | null; signal: string | null } | null = null

  private onData(d: Buffer) {
    this.buf += d.toString('utf8')
    if (this.buf.length > this.limits.maxResultBytes && !this.buf.includes('\n')) { this.tooLarge = true; this.waiter?.(null, 'too-large'); return }
    const nl = this.buf.indexOf('\n')
    if (nl >= 0) {
      const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1)
      if (line.length > this.limits.maxResultBytes) { this.tooLarge = true; this.waiter?.(null, 'too-large'); return }
      this.waiter?.(line)
    }
  }
  private nextLine(ms: number): Promise<{ line: string | null; why?: FailKind }> {
    return new Promise((res) => {
      const nl = this.buf.indexOf('\n')
      if (nl >= 0) { const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1); return res({ line }) }
      const timer = setTimeout(() => { this.waiter = null; res({ line: null, why: 'timeout' }) }, ms)
      const watchdog = setInterval(() => { // protects the workstation: kills runaway memory even in tiers with no other cap
        const pid = this.child?.pid
        if (!pid) return
        const total = [pid, ...descendants(pid)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0)
        if (total > this.limits.safetyRssMB) { this.watchdogFired = total; this.killNow(); }
      }, 20)
      this.waiter = (line, why) => { clearTimeout(timer); clearInterval(watchdog); this.waiter = null; res({ line, why }) }
    })
  }
  watchdogFired = 0

  private killNow() {
    try {
      if (this.o.wrap === 'podman' && this.containerName) spawnSync('podman', ['kill', '--signal', 'KILL', this.containerName], { stdio: 'ignore' })
      const pid = this.child?.pid
      if (pid) for (const p of [...descendants(pid), pid].reverse()) { try { process.kill(p, 'SIGKILL') } catch {} }
    } catch {}
  }

  private async roundTrip(json: string, ms: number): Promise<Outcome> {
    const t0 = performance.now()
    if (!this.child) return { ok: false, kind: 'crash', message: 'not running', ms: 0 }
    this.watchdogFired = 0
    this.child.stdin!.write(json + '\n')
    const { line, why } = await this.nextLine(ms)
    const elapsed = performance.now() - t0
    if (line === null) {
      const rss = this.watchdogFired
      this.killNow()
      const kind: FailKind = why === 'too-large' ? 'too-large' : rss ? 'memory' : why === 'timeout' ? 'timeout' : 'crash'
      await sleep(30)
      return { ok: false, kind, message: rss ? `host RSS watchdog killed the worker at ${rss.toFixed(0)} MB` : kind === 'crash' ? `worker exited (${JSON.stringify(this.exit)})` : `${kind} after ${elapsed.toFixed(0)} ms (worker killed)`, ms: elapsed, detail: this.exit as any }
    }
    let r: any
    try { r = JSON.parse(line) } catch { return { ok: false, kind: 'protocol', message: 'unparseable response line', ms: elapsed } }
    if (r.ok) return { ok: true, result: r.result, ms: elapsed }
    const k = r.error?.name === 'LimitError' ? (r.error.kind as FailKind) : 'error'
    return { ok: false, kind: k, message: `${r.error?.name}: ${r.error?.message}`, ms: elapsed }
  }

  async call(hook: string, args: Json[]): Promise<Outcome> {
    if (!this.child) { this.restarts++; const t0 = performance.now(); await this.start(); this.lastRestartMs = performance.now() - t0 }
    const out = await this.roundTrip(callRequest(hook, args), this.limits.wallMs + (this.o.engine === 'native' ? 0 : 400))
    return out
  }
  lastRestartMs = 0

  async rssMB(): Promise<number | null> {
    if (this.o.wrap === 'podman' && this.containerName) {
      const r = spawnSync('podman', ['inspect', '-f', '{{.State.Pid}}', this.containerName], { encoding: 'utf8' })
      const pid = Number(r.stdout.trim()); return pid ? vmRssMB(pid) : null
    }
    const pid = this.child?.pid
    if (!pid) return null
    const all = [pid, ...descendants(pid)]
    return all.reduce((n, p) => n + (vmRssMB(p) ?? 0), 0)
  }
  alive() { return !!this.child }
  async stop() {
    if (!this.child) return
    try { this.child.stdin!.end() } catch {}
    await sleep(30)
    if (this.child) this.killNow()
    if (this.o.wrap === 'podman' && this.containerName) spawnSync('podman', ['rm', '-f', '-t', '0', this.containerName], { stdio: 'ignore' })
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
    if (this.o.wrap === 'cgroup') { cmd = 'systemd-run'; args = ['--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${L.memoryMB * 3}M`, '-p', 'MemorySwapMax=0', '-p', 'TasksMax=64', '--', wd, ...args] }
    if (this.o.wrap === 'podman') {
      this.containerName = `ali38-wd-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
      const sockDir = join(RUN_DIR, `ali38-sockdir-${process.pid}`); mkdirSync(sockDir, { recursive: true }); this.sock = join(sockDir, 'rpc.sock')
      cmd = 'podman'
      args = ['run', '--rm', '-i', '--name', this.containerName, '--network', 'none', '--read-only', '--cap-drop', 'all', '--security-opt', 'no-new-privileges', '--memory', `${L.memoryMB * 3}m`, '--memory-swap', `${L.memoryMB * 3}m`, '--pids-limit', '64', '--cpus', '1', '--env-host=false', '--no-hosts', '--tmpfs', '/tmp:size=8m',
        '-v', `${this.dir}:/cfg:ro`, '-v', `${dirname(wd)}:/wd:ro`, '-v', `${sockDir}:/sock`,
        // workerd refuses to start without a CA bundle even when it has no network (it initialises its default `internet` TLS service). A slim image lacks one.
        '-v', '/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro', '--workdir', '/cfg', 'docker.io/library/debian:13', '/wd/workerd', 'serve', '/cfg/config.capnp']
    }
    const env: Record<string, string> = this.o.wrap === 'none' ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, HOME: process.env.HOME!, PATH: process.env.PATH!, DBUS_SESSION_BUS_ADDRESS: `unix:path=${process.env.XDG_RUNTIME_DIR}/bus` }
    this.child = spawn(cmd, args, { env, cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    this.child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    this.child.stdout!.on('data', () => {})
    this.child.on('exit', (code, signal) => { this.exit = { code, signal }; this.child = null })
    for (let i = 0; i < 400 && !existsSync(this.sock); i++) { if (!this.child) throw new Error(`${this.label}: workerd exited early: ${stderr.slice(0, 400)}`); await sleep(10) }
    if (!existsSync(this.sock)) throw new Error(`${this.label}: workerd socket never appeared: ${stderr.slice(0, 400)}`)
    const load = await this.post(loadRequest(), 10_000)
    if (!load.ok) throw new Error(`${this.label}: load failed: ${load.message}`)
    return { startMs: performance.now() - t0, manifest: load.result, runtime: `workerd ${execFileSync(wd, ['--version']).toString().trim()}${this.o.wrap && this.o.wrap !== 'none' ? ' in ' + this.o.wrap : ''}` }
  }

  private post(body: string, ms: number): Promise<Outcome> {
    const t0 = performance.now()
    return new Promise((res) => {
      let done = false
      const finish = (o: Outcome) => { if (!done) { done = true; clearTimeout(timer); clearInterval(watchdog); res(o) } }
      const timer = setTimeout(() => { this.killNow(); finish({ ok: false, kind: 'timeout', message: `timeout after ${(performance.now() - t0).toFixed(0)} ms (workerd killed: it has no per-request CPU or wall limit of its own)`, ms: performance.now() - t0 }) }, ms)
      const watchdog = setInterval(() => {
        const pid = this.child?.pid; if (!pid) return
        const total = [pid, ...descendants(pid)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0)
        if (total > this.limits.safetyRssMB) { this.killNow(); finish({ ok: false, kind: 'memory', message: `host RSS watchdog killed workerd at ${total.toFixed(0)} MB (workerd has no memory limit option)`, ms: performance.now() - t0 }) }
      }, 20)
      const req = http.request({ socketPath: this.sock, method: 'POST', path: '/', headers: { 'content-length': Buffer.byteLength(body) } }, (r) => {
        const chunks: Buffer[] = []; let size = 0
        r.on('data', (c: Buffer) => { size += c.length; if (size > this.limits.maxResultBytes) { req.destroy(); this.killNow(); finish({ ok: false, kind: 'too-large', message: `response over ${this.limits.maxResultBytes} bytes`, ms: performance.now() - t0 }); return } chunks.push(c) })
        r.on('end', () => {
          const ms2 = performance.now() - t0
          if (r.statusCode !== 200) return finish({ ok: false, kind: 'error', message: `HTTP ${r.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`, ms: ms2 })
          try { const j = JSON.parse(Buffer.concat(chunks).toString()); finish(j.ok ? { ok: true, result: j.result, ms: ms2 } : { ok: false, kind: 'error', message: `${j.error?.name}: ${j.error?.message}`, ms: ms2 }) } catch { finish({ ok: false, kind: 'protocol', message: 'bad json', ms: ms2 }) }
        })
      })
      req.on('error', (e) => finish({ ok: false, kind: 'crash', message: `${e.message} (exit ${JSON.stringify(this.exit)})`, ms: performance.now() - t0 }))
      req.end(body)
    })
  }

  private killNow() {
    try {
      if (this.o.wrap === 'podman' && this.containerName) spawnSync('podman', ['kill', '--signal', 'KILL', this.containerName], { stdio: 'ignore' })
      const pid = this.child?.pid
      if (pid) for (const p of [...descendants(pid), pid].reverse()) { try { process.kill(p, 'SIGKILL') } catch {} }
    } catch {}
  }
  async call(hook: string, args: Json[]): Promise<Outcome> {
    if (!this.child) { this.restarts++; this.cleanupFiles(); await this.start() }
    return this.post(callRequest(hook, args), this.limits.wallMs)
  }
  async rssMB() { const pid = this.child?.pid; if (!pid) return null; return [pid, ...descendants(pid)].reduce((n, p) => n + (vmRssMB(p) ?? 0), 0) }
  alive() { return !!this.child }
  private cleanupFiles() { try { rmSync(this.sock, { force: true }) } catch {} try { rmSync(this.dir, { recursive: true, force: true }) } catch {} }
  async stop() {
    if (this.child) this.killNow()
    if (this.o.wrap === 'podman' && this.containerName) spawnSync('podman', ['rm', '-f', '-t', '0', this.containerName], { stdio: 'ignore' })
    await sleep(50)
    this.cleanupFiles()
    if (this.o.wrap === 'podman') try { rmSync(join(RUN_DIR, `ali38-sockdir-${process.pid}`), { recursive: true, force: true }) } catch {}
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
