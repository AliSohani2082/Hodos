#!/usr/bin/env node
/**
 * Remove build output: each workspace package's lib/, dist/ and
 * renderer/dist/, the packed tarballs, coverage and end-to-end scratch
 * files. Sources, node_modules and learner data are left alone.
 *
 * Usage: node scripts/clean.mjs
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Workspace package directories (the patterns in pnpm-workspace.yaml). */
function packageDirs() {
  const dirs = []
  for (const base of ['packages', 'packages/environments', 'examples']) {
    if (!existsSync(join(root, base))) continue
    for (const name of readdirSync(join(root, base))) {
      const dir = join(root, base, name)
      if (existsSync(join(dir, 'package.json'))) dirs.push(dir)
    }
  }
  return dirs
}

const targets = [
  ...packageDirs().flatMap(dir => ['lib', 'dist', 'renderer/dist'].map(out => join(dir, out))),
  join(root, 'dist-packages'),
  join(root, 'coverage'),
  join(root, '.e2e'),
]

let removed = 0
for (const target of targets) {
  if (!existsSync(target)) continue
  rmSync(target, { recursive: true, force: true })
  console.log(`removed ${relative(root, target)}`)
  removed += 1
}
console.log(removed === 0 ? 'Nothing to clean.' : `Cleaned ${removed} director${removed === 1 ? 'y' : 'ies'}.`)
