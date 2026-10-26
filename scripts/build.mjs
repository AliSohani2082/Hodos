#!/usr/bin/env node
/**
 * Build every Hodos package:
 *  1. TypeScript project references → each package's lib/ (Node half).
 *  2. The workspace SPA (@hodos/ui) → packages/ui/dist/ (React bundled).
 *  3. Browser halves of DSH bundles → lib/client.js in DSH's client module
 *     format (CommonJS factory; react comes from the DSH platform).
 *  4. Environment renderers → their renderer/dist/ folders (static files).
 *
 * Usage: node scripts/build.mjs [types|ui|client|renderers]...  (default: all)
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STEPS = ['types', 'ui', 'client', 'renderers']
const requested = process.argv.slice(2)
for (const step of requested) {
  if (!STEPS.includes(step)) {
    console.error(`unknown build step ${step}; expected one of ${STEPS.join(', ')}`)
    process.exit(2)
  }
}
const want = step => requested.length === 0 || requested.includes(step)
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (want('types')) {
  console.log('• TypeScript (Node packages)')
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.json'])
}

const ui = join(root, 'packages/ui')
if (want('ui')) {
  console.log('• Workspace app (@hodos/ui)')
  rmSync(join(ui, 'dist'), { recursive: true, force: true })
  mkdirSync(join(ui, 'dist'), { recursive: true })
  await build({
    entryPoints: [join(ui, 'src/main.tsx')],
    outfile: join(ui, 'dist/app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    conditions: ['hodos-source'],
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'linked',
    logLevel: 'warning',
  })
  copyFileSync(join(ui, 'src/index.html'), join(ui, 'dist/index.html'))
  copyFileSync(join(ui, 'src/app.css'), join(ui, 'dist/app.css'))
}

/**
 * Bundle a DSH browser half into the client module format: a CommonJS body
 * wrapped in `window.__ModuleLoader__.load({ id, factory })`.
 */
async function clientBundle(entry, outfile, id) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    jsx: 'automatic',
    minify: false,
    conditions: ['hodos-source'],
    logLevel: 'warning',
  })
  const body = result.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports; } });\n`
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(outfile, wrapped)
}

if (want('client')) {
  console.log('• DSH browser halves')
  await clientBundle(join(root, 'packages/dsh-adapter/src/client/index.tsx'), join(root, 'packages/dsh-adapter/lib/client.js'), '@hodos/dsh')
}

const envRoot = join(root, 'packages/environments')
if (want('renderers') && existsSync(envRoot)) {
  for (const name of readdirSync(envRoot)) {
    const dir = join(envRoot, name)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const rendererEntry = join(dir, 'renderer/src/main.ts')
    if (existsSync(rendererEntry)) {
      console.log(`• Renderer ${pkg.name}`)
      const out = join(dir, 'renderer/dist')
      rmSync(out, { recursive: true, force: true })
      mkdirSync(out, { recursive: true })
      await build({
        entryPoints: [rendererEntry],
        outfile: join(out, 'renderer.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        conditions: ['hodos-source'],
        legalComments: 'linked',
        logLevel: 'warning',
      })
      for (const file of readdirSync(join(dir, 'renderer/static'))) copyFileSync(join(dir, 'renderer/static', file), join(out, file))
    }
  }
}
console.log('Build complete.')
