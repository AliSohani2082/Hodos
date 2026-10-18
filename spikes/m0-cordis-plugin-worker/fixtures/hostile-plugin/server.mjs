// HOSTILE test plugin (spike b, ALI-53). One block whose `validate` performs the attack named in node.attrs.attack, one exercise kind whose `grade` forges results.
// It only ever targets canaries and dummy listeners supplied by the harness through attrs (never real services). It reports what it believes happened;
// the harness does NOT trust that report and checks host-side ground truth (connection counters, files, canary text in the output).
// Single self-contained ES module; dynamic import() is used so it can load, and fail gracefully, in runtimes that have no Node builtins.

export const name = 'ali38-hostile'

const rep = (attack, succeeded, detail) => ({ attack, succeeded: !!succeeded, detail: String(detail).slice(0, 400) })
const tryIt = async (f) => { try { return { ok: true, v: await f() } } catch (e) { return { ok: false, e: String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e).slice(0, 160) } } }
const has = (v, token) => typeof v === 'string' && v.includes(token)

async function importOr(spec) { try { return await import(spec) } catch (e) { return null } }

async function connectRead(net, opts, token, ms = 900) {
  return new Promise((resolve, reject) => {
    const s = net.connect(opts)
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')) }, ms)
    s.on('connect', () => s.write('GET / HTTP/1.0\r\nHost: x\r\n\r\n'))
    s.on('data', (d) => { if (has(String(d), token)) { clearTimeout(t); s.destroy(); resolve('banner read') } })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

const ATTACKS = {
  // ---- capability attacks: the plugin tries to obtain something it must not have ----
  async env(a) {
    const found = []
    const probe = (label, f) => { try { if (has(String(f()), a.canary)) found.push(label) } catch {} }
    probe('process.env', () => process.env.ALI38_CANARY_SECRET)
    probe('Bun.env', () => Bun.env.ALI38_CANARY_SECRET)
    probe('globalThis', () => globalThis.ALI38_CANARY_SECRET)
    probe('import.meta.env', () => import.meta.env.ALI38_CANARY_SECRET)
    const fs = await importOr('node:fs')
    if (fs) for (const p of ['/proc/self/environ', `/proc/${process.ppid}/environ`]) probe(p, () => fs.readFileSync(p, 'latin1'))
    return rep('env', found.length, found.length ? 'canary readable via ' + found.join(', ') : 'canary not reachable (process: ' + typeof process + ', Bun: ' + typeof Bun + ')')
  },
  async 'fs-outside'(a) {
    const fs = await importOr('node:fs')
    if (!fs) return rep('fs-outside', false, 'no node:fs')
    const r = await tryIt(() => fs.readFileSync(a.canaryFile, 'utf8'))
    const h = await tryIt(() => fs.readFileSync('/etc/hostname', 'utf8'))
    return rep('fs-outside', r.ok && has(r.v, a.canary), `canary file: ${r.ok ? 'READ' : r.e}; /etc/hostname (informational, may be the sandbox's own): ${h.ok ? 'readable' : h.e}`)
  },
  async 'fs-inside'(a) { // control: reading its OWN package is allowed (PRD: plugin package mounted read-only)
    const fs = await importOr('node:fs')
    if (!fs) return rep('fs-inside', false, 'no fs at all (own files arrive as module source, not via fs)')
    const r = await tryIt(() => fs.readFileSync(a.ownFile, 'utf8'))
    return rep('fs-inside', r.ok, r.ok ? 'own package.json readable' : r.e)
  },
  async 'fs-write'(a) {
    const fs = await importOr('node:fs')
    if (!fs) return rep('fs-write', false, 'no node:fs')
    const w1 = await tryIt(() => fs.writeFileSync(a.writeTarget, 'pwned'))
    const w2 = await tryIt(() => fs.writeFileSync(a.ownFile + '.pwned', 'pwned'))
    return rep('fs-write', w1.ok || w2.ok, `outside: ${w1.ok ? 'WROTE' : w1.e}; into own package: ${w2.ok ? 'WROTE' : w2.e}`)
  },
  async 'net-loopback'(a) { // stand-in for Postgres on localhost
    const net = await importOr('node:net')
    if (!net) return rep('net-loopback', false, 'no node:net')
    const r = await tryIt(() => connectRead(net, { host: '127.0.0.1', port: a.port }, a.canary))
    return rep('net-loopback', r.ok, r.ok ? 'connected and read banner' : r.e)
  },
  async 'net-lan'(a) { // stand-in for a LAN host / the runner API on the internal network
    const net = await importOr('node:net')
    if (!net) return rep('net-lan', false, 'no node:net')
    const r = await tryIt(() => connectRead(net, { host: a.lanIp, port: a.port }, a.canary))
    return rep('net-lan', r.ok, r.ok ? 'connected and read banner' : r.e)
  },
  async 'net-unix'(a) { // stand-in for a unix socket such as a database or container-runtime socket
    const net = await importOr('node:net')
    if (!net) return rep('net-unix', false, 'no node:net')
    const r = await tryIt(() => connectRead(net, { path: a.sock }, a.canary))
    return rep('net-unix', r.ok, r.ok ? 'connected and read banner' : r.e)
  },
  async fetch(a) {
    if (typeof fetch !== 'function') return rep('fetch', false, 'no fetch global')
    const r = await tryIt(async () => (await fetch(`http://127.0.0.1:${a.port}/`)).text())
    return rep('fetch', r.ok && has(r.v, a.canary), r.ok ? 'got ' + String(r.v).slice(0, 40) : r.e)
  },
  async 'cf-connect'(a) { // workerd-only API: raw sockets. Must be denied by globalOutbound, not just by missing APIs
    const m = await importOr('cloudflare:sockets')
    if (!m) return rep('cf-connect', false, 'no cloudflare:sockets module')
    const r = await tryIt(async () => { const s = m.connect({ hostname: '127.0.0.1', port: a.port }); const w = s.writable.getWriter(); await w.write(new TextEncoder().encode('GET / HTTP/1.0\r\n\r\n')); const { value } = await s.readable.getReader().read(); return new TextDecoder().decode(value) })
    return rep('cf-connect', r.ok && has(r.v, a.canary), r.ok ? 'got ' + String(r.v).slice(0, 40) : r.e)
  },
  async spawn() {
    const cp = await importOr('node:child_process')
    if (cp) { const r = await tryIt(() => cp.execSync('id').toString()); return rep('spawn', r.ok && /uid=/.test(r.v), r.ok ? r.v.trim() : r.e) }
    if (typeof Bun !== 'undefined') { const r = await tryIt(() => Bun.spawnSync(['id']).stdout.toString()); return rep('spawn', r.ok && /uid=/.test(r.v), r.ok ? r.v.trim() : r.e) }
    return rep('spawn', false, 'no child_process')
  },
  async escape() {
    const out = []
    const g = await tryIt(() => (function () {}).constructor('return globalThis')())
    out.push('Function ctor: ' + (g.ok ? 'typeof process=' + typeof g.v.process : g.e))
    const e = await tryIt(() => (0, eval)('typeof process'))
    out.push('indirect eval: ' + (e.ok ? e.v : e.e))
    const secret = await tryIt(() => (0, eval)('process.env.ALI38_CANARY_SECRET'))
    const req = await tryIt(() => (0, eval)('typeof require'))
    out.push('require: ' + (req.ok ? req.v : req.e))
    const reached = (g.ok && g.v && typeof g.v.process !== 'undefined') || (e.ok && e.v !== 'undefined')
    return rep('escape', reached, out.join(' | ') + (secret.ok && typeof secret.v === 'string' && secret.v.length > 0 ? ' | CANARY READ' : ''))
  },
  async imports(a) {
    const specs = ['node:fs', 'node:net', 'node:child_process', 'node:os', 'bun:ffi', 'cloudflare:sockets', 'data:text/javascript,export default 1', `http://127.0.0.1:${a.port}/x.js`, 'file://' + a.canaryFile]
    const got = []
    for (const s of specs) { const r = await tryIt(() => import(s)); if (r.ok) got.push(s.split(',')[0].replace(/^file:.*/, 'file:<canary>').replace(/^http:.*/, 'http:<fake service>')) }
    // cloudflare:sockets and data: are resolvable in workerd by design; they grant no access by themselves (see cf-connect), so they do not count.
    const dangerous = got.filter((s) => /^(node:|bun:|file:|http:)/.test(s))
    return rep('imports', dangerous.length > 0, got.length ? 'resolved: ' + got.join(', ') : 'nothing resolved')
  },

  async noop() { return rep('noop', false, 'ok') },
  async compute(a) { const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2)); let t = 0; for (let i = 0; i < (a.reps || 1); i++) t += fib(a.n || 25); return rep('compute', false, 'fib sum ' + t) }, // throughput probe, not an attack // recovery probe: a benign call after the worker was killed

  // ---- resource attacks: the plugin tries to starve the host ----
  async 'cpu-loop'() { for (;;) {} },
  async 'async-spin'() { for (;;) await null },
  async redos() { return rep('redos', false, /(a+)+$/.test('a'.repeat(48) + '!')) },
  async 'hang-promise'() { await new Promise(() => {}); return rep('hang-promise', false, 'unreachable') },
  async 'sleep-wall'() { await new Promise((r) => setTimeout(r, 60000)); return rep('sleep-wall', false, 'slept') },
  async 'mem-array'(a) { const keep = []; for (let i = 0; i < a.capMB; i++) keep.push(new Array(131072).fill(i)); return rep('mem-array', false, 'allocated ' + keep.length + ' MB') },
  async 'mem-string'(a) { let s = 'x'.repeat(1 << 20); for (let i = 0; i < 12; i++) s += s; return rep('mem-string', false, 'built ' + (s.length >> 20) + ' MB string') },
  async 'mem-buffer'(a) { const keep = []; for (let i = 0; i < a.capMB; i++) keep.push(new Uint8Array(1 << 20).fill(1)); return rep('mem-buffer', false, 'allocated ' + keep.length + ' MB of typed arrays') },
  async stack() { const f = (n) => f(n + 1) + 1; return rep('stack', false, 'recursed to ' + f(0)) },
  async flood() { return { attack: 'flood', succeeded: false, detail: 'x'.repeat(20 * 1024 * 1024) } },
  async fork() {
    const cp = await importOr('node:child_process')
    if (!cp) return rep('fork', false, 'no child_process')
    let ok = 0, err = ''
    for (let i = 0; i < 48; i++) { const r = await tryIt(() => cp.spawn('sleep', ['4'], { stdio: 'ignore' })); if (r.ok && r.v.pid) ok++; else err = r.e || 'no pid' }
    return rep('fork', ok > 0, `spawned ${ok} of 48 sleep processes ${err ? '(last error: ' + err + ')' : ''}`)
  },
}

export function apply(ctx) {
  ctx.lesson.block({
    name: 'attack', version: 1, kind: 'leaf', body: 'none', attrs: { type: 'object' },
    guidance: { when: 'never', syntax: '{% attack /%}' },
    validate: async (node) => {
      const fn = ATTACKS[node.attrs.attack]
      if (!fn) return [{ level: 'warning', id: 'attack/unknown', message: 'unknown attack' }]
      const r = await fn(node.attrs)
      return [{ level: 'warning', id: 'attack/result', message: JSON.stringify(r) }]
    },
    fallback: { mode: 'hide', text: () => '' },
    renderer: { entry: 'ui.js', trust: 'first-party' }, // a lie in the manifest: ignored, trust comes from the platform allowlist
  })
  ctx.exercise.kind({
    name: 'hostile-quiz', version: 1, kinds: ['mcq'], responseKind: 'choice', grader: 'deterministic',
    supports: { steps: false, hints: false, partialCredit: false, timed: false, variants: false }, itemSchema: {},
    ui: { entry: 'ui.js', trust: 'first-party' },
    validateItem: () => [],
    grade: (item, response) => {
      const base = { misconceptionsDetected: [], graderConfidence: 1, needsHumanReview: false, correct: true, feedback: { text: 'ok', revealsAnswer: false } }
      switch (item.prompt.variant) {
        case 'always-correct': return { ...base, score: 1 }                                  // shape-valid forgery: undetectable by shape checks
        case 'out-of-range': return { ...base, score: 99 }
        case 'nan': return { ...base, score: NaN }
        case 'negative': return { ...base, score: -5 }
        case 'huge-feedback': return { ...base, score: 1, feedback: { text: 'x'.repeat(200000), revealsAnswer: false } }
        case 'proto': return JSON.parse('{"__proto__":{"isAdmin":true},"score":1,"misconceptionsDetected":[],"graderConfidence":1,"needsHumanReview":false,"feedback":{"text":"ok","revealsAnswer":false}}')
        case 'reveal': return { ...base, score: 0, feedback: { text: 'the answer is B', revealsAnswer: true } } // shape-valid; checkpoint policy is the platform's job
        default: return { ...base, score: 1 }
      }
    },
  })
}
