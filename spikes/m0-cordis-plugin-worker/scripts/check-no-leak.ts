// ALI-51: proves the platform-facing code does not depend on cordis.
//  1. Import scan: only src/cordis/* (the ALI-50 test bed) and src/host/cordis-adapter.ts may mention cordis.
//  2. Isolated type-check: the SDK types, the PluginHost interface, the shared resolver and the Map-based host are copied to a temp dir with NO node_modules
//     and compiled with `tsc --strict`. It only passes if none of them needs a cordis type.
//   bun run scripts/check-no-leak.ts
import { readdirSync, readFileSync, mkdirSync, copyFileSync, rmSync, writeFileSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { SPIKE_DIR } from '../src/host/sandboxes.ts'

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
const src = walk(join(SPIKE_DIR, 'src')).filter((f) => /\.(ts|mjs)$/.test(f)).map((f) => relative(SPIKE_DIR, f))
const allowed = (f: string) => f.startsWith('src/cordis/') || f === 'src/host/cordis-adapter.ts' || f === 'src/host/conformance.ts'
const code = (f: string) => readFileSync(join(SPIKE_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') // comments may name cordis; code may not
const offenders = src.filter((f) => !allowed(f) && /(from|import\()\s*['"](cordis|@cordisjs\/[^'"]+)['"]/.test(code(f)))
const mentions = src.filter((f) => !allowed(f) && /\bcordis\b/i.test(code(f)))
console.log(`import scan: ${src.length} files, ${offenders.length} import cordis outside the adapter${offenders.length ? ': ' + offenders.join(', ') : ''}`)

const platformFacing = ['src/sdk/types.ts', 'src/host/plugin-host.ts', 'src/host/validate-result.ts', 'src/host/resolve.ts', 'src/host/map-adapter.ts']
// Outside the spike dir on purpose: module resolution walks up parent directories, so a copy under spikes/ would still find node_modules/cordis.
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'ali38-noleak-'))
for (const f of platformFacing) { mkdirSync(join(tmp, f, '..'), { recursive: true }); copyFileSync(join(SPIKE_DIR, f), join(tmp, f)) }
writeFileSync(join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', allowImportingTsExtensions: true, skipLibCheck: false, types: [], lib: ['ES2022'], noUncheckedIndexedAccess: false }, include: platformFacing }, null, 2))
const r = spawnSync(join(SPIKE_DIR, 'node_modules/.bin/tsc'), ['-p', tmp], { encoding: 'utf8', cwd: tmp })
console.log(`isolated tsc --strict (no node_modules, ${platformFacing.length} files): ${r.status === 0 ? 'OK' : 'FAILED\n' + r.stdout + r.stderr}`)
rmSync(tmp, { recursive: true, force: true })
const ok = offenders.length === 0 && r.status === 0
console.log(ok ? 'NO CORDIS LEAK' : 'LEAK')
writeFileSync(join(SPIKE_DIR, 'results/no-leak.json'), JSON.stringify({ spike: 'ALI-51', filesScanned: src.length, importOffenders: offenders, commentFreeMentionsOutsideAdapter: mentions, isolatedTsc: { files: platformFacing, ok: r.status === 0, tsc: '7.0.2' } }, null, 2) + '\n')
process.exit(ok ? 0 : 1)
