#!/usr/bin/env node
/**
 * Pack Hodos for installing without a registry. Nothing is published.
 *
 * Output in dist-packages/:
 *  - one tarball per DeepSeek Harness bundle (@hodos/dsh and the
 *    environments), installed with
 *    `dsh plugin --profile <name> add /absolute/path/to/it.tgz`;
 *  - the plugin-author libraries (@hodos/plugin-sdk, @hodos/testing).
 *
 * The @hodos packages are not on a registry, so each tarball carries the ones
 * it needs as bundled dependencies: copies under its node_modules/, listed in
 * `bundleDependencies`. Their third-party dependencies become dependencies of
 * the tarball's package and install from the registry as usual. @hodos/dsh
 * carries the built workspace app as app/ instead of depending on @hodos/ui.
 *
 * Usage: node scripts/pack-bundles.mjs [--no-build]
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'dist-packages')

/** What to pack: DSH bundles, then libraries for plugin authors. */
const TARGETS = ['@hodos/dsh', '@hodos/chess', '@hodos/code', '@hodos/language', '@hodos/math', '@hodos/plugin-sdk', '@hodos/testing']
/** Shipped inside @hodos/dsh as app/ rather than as a package. */
const APP_PACKAGE = '@hodos/ui'

const args = process.argv.slice(2)
for (const arg of args) {
  if (arg !== '--no-build') fail(`unknown argument ${arg}; usage: node scripts/pack-bundles.mjs [--no-build]`)
}

function fail(message) {
  console.error(`pack-bundles: ${message}`)
  process.exit(1)
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', shell: false })
  if (result.error !== undefined) fail(`${command} could not start: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${commandArgs.join(' ')} failed in ${cwd}:\n${result.stdout}${result.stderr}`)
  return result.stdout
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

/** Workspace packages by name. */
function workspacePackages() {
  const found = new Map()
  for (const base of ['packages', 'packages/environments']) {
    for (const name of readdirSync(join(root, base))) {
      const dir = join(root, base, name)
      if (!existsSync(join(dir, 'package.json'))) continue
      const pkg = readJson(join(dir, 'package.json'))
      found.set(pkg.name, { dir, pkg })
    }
  }
  return found
}

if (!args.includes('--no-build')) {
  console.log('Building…')
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const workspace = workspacePackages()
const work = mkdtempSync(join(tmpdir(), 'hodos-pack-'))

/**
 * `pnpm pack` a workspace package (its `files`, with workspace: ranges
 * rewritten to versions) and unpack it.
 * @returns the unpacked package directory.
 */
const unpacked = new Map()
function packOne(name) {
  const cached = unpacked.get(name)
  if (cached !== undefined) return cached
  const entry = workspace.get(name)
  if (entry === undefined) fail(`${name} is not a workspace package`)
  const raw = join(work, 'raw')
  mkdirSync(raw, { recursive: true })
  const { filename } = JSON.parse(run('pnpm', ['pack', '--json', '--pack-destination', raw], entry.dir))
  const dir = join(work, 'unpacked', name)
  mkdirSync(dir, { recursive: true })
  run('tar', ['-xzf', filename, '-C', dir, '--strip-components=1'], root)
  // Build bookkeeping, not part of the package.
  rmSync(join(dir, 'lib/.tsbuildinfo'), { force: true })
  checkExports(name, dir)
  unpacked.set(name, dir)
  return dir
}

/** Every file the package exports must be in it (a missing build would otherwise ship). */
function checkExports(name, dir) {
  const { exports = {}, bin = {} } = readJson(join(dir, 'package.json'))
  const targets = Object.values(bin)
  for (const target of Object.values(exports)) {
    if (typeof target === 'string') targets.push(target)
    else if (typeof target?.default === 'string') targets.push(target.default)
  }
  for (const target of targets) {
    if (target.includes('*')) continue
    if (!existsSync(join(dir, target))) fail(`${name} does not contain ${target}; build first (run without --no-build)`)
  }
}

const isInternal = name => workspace.has(name)

/** The internal packages `name` needs at run time, transitively (the app package excluded). */
function internalClosure(name, seen = new Set()) {
  const deps = readJson(join(packOne(name), 'package.json')).dependencies ?? {}
  for (const dep of Object.keys(deps)) {
    if (!isInternal(dep) || dep === APP_PACKAGE || seen.has(dep)) continue
    seen.add(dep)
    internalClosure(dep, seen)
  }
  return seen
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const summary = []

for (const name of TARGETS) {
  const stage = join(work, 'stage', name, 'package')
  cpSync(packOne(name), stage, { recursive: true })
  const manifest = readJson(join(stage, 'package.json'))
  const dependencies = { ...manifest.dependencies }

  if (APP_PACKAGE in dependencies) {
    const app = join(packOne(APP_PACKAGE), 'dist')
    if (!existsSync(join(app, 'index.html'))) fail(`${APP_PACKAGE} has no built app; run without --no-build`)
    cpSync(app, join(stage, 'app'), { recursive: true })
    delete dependencies[APP_PACKAGE]
    if (!(manifest.files ?? []).includes('app')) fail(`${name} must list "app" in its files`)
  }

  const bundled = Array.from(internalClosure(name)).toSorted((a, b) => a.localeCompare(b))
  for (const dep of bundled) {
    cpSync(packOne(dep), join(stage, 'node_modules', dep), { recursive: true })
    // A bundled package's third-party dependencies are installed for the package that carries it.
    for (const [third, range] of Object.entries(readJson(join(packOne(dep), 'package.json')).dependencies ?? {})) {
      if (isInternal(third)) continue
      if (third in dependencies && dependencies[third] !== range) fail(`${name} and its bundled ${dep} need different ${third} ranges: ${dependencies[third]} and ${range}`)
      dependencies[third] = range
    }
  }

  manifest.dependencies = Object.fromEntries(Object.entries(dependencies).toSorted(([a], [b]) => a.localeCompare(b)))
  if (bundled.length > 0) manifest.bundleDependencies = bundled
  delete manifest.devDependencies
  delete manifest.scripts
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const { filename } = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', OUT], stage))[0]
  const file = join(OUT, filename)
  summary.push({ name, file, bytes: statSync(file).size, bundled, bundle: manifest.dsh?.bundle !== undefined })
}

rmSync(work, { recursive: true, force: true })

console.log('\nPacked into dist-packages/ (nothing was published):')
for (const s of summary) {
  const carries = s.bundled.length === 0 ? '' : `, carries ${s.bundled.join(', ')}`
  console.log(`  ${s.file.slice(OUT.length + 1)}  ${(s.bytes / 1024).toFixed(0)} KiB${carries}`)
}
console.log('\nInstall into a DeepSeek Harness profile (here `web`), @hodos/dsh first:')
for (const s of summary.filter(x => x.bundle)) console.log(`  dsh plugin --profile web add ${s.file}`)
