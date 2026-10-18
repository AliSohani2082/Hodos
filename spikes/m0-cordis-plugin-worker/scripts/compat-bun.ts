// ALI-52: can each candidate be loaded by the app runtime (Bun)? And what does it cost to ship? Writes results/bun-compat.json.
//   bun run scripts/compat-bun.ts
import { spawnSync, execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SPIKE_DIR, BIN } from '../src/host/sandboxes.ts'

const du = (p: string) => Number(execFileSync('du', ['-sb', join(SPIKE_DIR, p)]).toString().split('\t')[0])
const mb = (b: number) => +(b / 1048576).toFixed(2)
const ver = (p: string) => JSON.parse(readFileSync(join(SPIKE_DIR, 'node_modules', p, 'package.json'), 'utf8')).version

function tryRun(runtime: 'bun' | 'node', code: string) {
  const r = spawnSync(BIN[runtime], runtime === 'bun' ? ['-e', code] : ['--input-type=module', '-e', code], { cwd: SPIKE_DIR, encoding: 'utf8', timeout: 30_000 })
  const text = (r.stdout + r.stderr).trim().replaceAll(SPIKE_DIR, '<spike>')
  const firstError = text.split('\n').find((l) => /error|undefined symbol|ERR_/i.test(l)) ?? text.split('\n').slice(-1)[0]
  return { ok: r.status === 0, status: r.status, output: r.status === 0 ? text.split('\n').pop() : firstError.slice(0, 300) }
}

const probes = {
  'quickjs-emscripten': `import { getQuickJS } from 'quickjs-emscripten'; const Q = await getQuickJS(); const rt = Q.newRuntime(); rt.setMemoryLimit(1<<20); const c = rt.newContext(); const r = c.evalCode('1+41'); console.log('eval ->', c.dump(c.unwrapResult(r)))`,
  'isolated-vm': `import ivm from 'isolated-vm'; const i = new ivm.Isolate({ memoryLimit: 16 }); const c = await i.createContext(); console.log('eval ->', await c.eval('1+41'))`,
  workerd: `import { spawnSync } from 'node:child_process'; const r = spawnSync('${join(SPIKE_DIR, 'node_modules/@cloudflare/workerd-linux-64/bin/workerd')}', ['--version']); console.log('binary ->', r.stdout.toString().trim())`,
  cordis: `import { Context } from 'cordis'; const c = new Context(); console.log('ctx ->', typeof c.plugin)`,
} as const

const result: any = { spike: 'ALI-52', bun: BIN.bun, node: BIN.node, bunVersion: execFileSync(BIN.bun, ['--version']).toString().trim(), nodeVersion: execFileSync(BIN.node, ['--version']).toString().trim(), options: {} }
for (const [name, code] of Object.entries(probes)) result.options[name] = { onBun: tryRun('bun', code), onNode: tryRun('node', code) }

const staticFacts = {
  'quickjs-emscripten': { version: ver('quickjs-emscripten'), shipped: 'pure JS + wasm; only @jitl/quickjs-wasmfile-release-sync + quickjs-emscripten-core are needed', releaseSyncWasmBytes: existsSync(join(SPIKE_DIR, 'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm')) ? du('node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm') : null, minimalPackageMB: mb(du('node_modules/@jitl/quickjs-wasmfile-release-sync') + du('node_modules/quickjs-emscripten-core') + du('node_modules/@jitl/quickjs-ffi-types')), metaPackageMB: mb(du('node_modules/quickjs-emscripten') + du('node_modules/@jitl')), native: false, installNeeds: 'nothing (no compiler, no postinstall)' },
  'isolated-vm': { version: ver('isolated-vm'), shipped: 'native V8 addon; prebuilds for linux x64/arm64, darwin-arm64, win32-x64 per Node ABI (137 = Node 24, 147 = Node 26) and glibc/musl', packageMB: mb(du('node_modules/isolated-vm')), onePrebuildMB: mb(du('node_modules/isolated-vm/prebuilds/linux-x64/isolated-vm.abi137.glibc.node')), native: true, installNeeds: 'prebuild matching the Node ABI, else node-gyp + C++ toolchain + Node headers (compile takes minutes); engines.node >= 24; must be rebuilt/re-resolved on every Node major' },
  workerd: { version: ver('workerd'), shipped: 'one static-ish 130 MB binary per platform via optional dependency + postinstall', binaryMB: mb(du('node_modules/@cloudflare/workerd-linux-64/bin/workerd')), packageMB: mb(du('node_modules/@cloudflare')), native: true, installNeeds: 'postinstall script (ran under Bun without a trust prompt); needs a CA bundle in the runtime image to start' },
  cordis: { version: ver('cordis'), packageMB: mb(du('node_modules/cordis') + du('node_modules/cosmokit') + du('node_modules/@standard-schema')), native: false, installNeeds: 'nothing' },
}
for (const k of Object.keys(staticFacts)) result.options[k].facts = (staticFacts as any)[k]
writeFileSync(join(SPIKE_DIR, 'results/bun-compat.json'), JSON.stringify(result, null, 2) + '\n')
for (const [k, v] of Object.entries<any>(result.options)) console.log(k.padEnd(20), 'bun:', v.onBun.ok ? 'OK  ' : 'FAIL', '|', 'node:', v.onNode.ok ? 'OK  ' : 'FAIL', '|', v.onBun.ok ? v.onBun.output : v.onBun.output)
