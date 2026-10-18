// Plugin-worker child process. Speaks newline-delimited JSON on stdin/stdout. Runs under Bun or Node (and inside a container).
//   <runtime> child.mjs --engine native|quickjs|ivm --plugin <path/to/server.mjs> [--mem-mb 32] [--wall-ms 1000]
// stdout carries ONLY protocol lines; plugin console output is diverted to stderr.
import { createInterface } from 'node:readline'
import { createEngine, LimitError } from './engines.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')

const opts = { pluginPath: args.plugin, memoryMB: Number(args['mem-mb'] ?? 32), memoryBytes: Number(args['mem-mb'] ?? 32) * 1048576, wallMs: Number(args['wall-ms'] ?? 1000) }
let engine = await createEngine(args.engine ?? 'native', opts)
let lastConfig
const send = (obj) => process.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n')
send({ ready: true, engine: engine.name, runtime: typeof Bun !== 'undefined' ? 'bun ' + Bun.version : 'node ' + process.versions.node, pid: process.pid })

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let chain = Promise.resolve()
rl.on('line', (line) => {
  chain = chain.then(async () => {
    let id = null
    try {
      id = JSON.parse(line).id
      if (JSON.parse(line).op === 'load') lastConfig = JSON.parse(line).config
      if (JSON.parse(line).op === 'stats') return send({ id, ok: true, result: { rss: process.memoryUsage().rss, engineBytes: engine.memoryBytes?.() ?? null } })
      send(await engine.call(line))
    } catch (e) {
      send({ id, ok: false, error: { name: e instanceof LimitError ? 'LimitError' : String(e?.name || 'Error'), kind: e?.kind, message: String(e?.message || e) } })
      if (e instanceof LimitError && (e.kind === 'memory' || engine.isDead?.())) { // engine unusable: rebuild it and reload the plugin
        try { engine.close() } catch {}
        engine = await createEngine(args.engine ?? 'native', opts)
        await engine.load(lastConfig)
      }
    }
  })
})
rl.on('close', () => { try { engine.close() } catch {} ; process.exit(0) })
