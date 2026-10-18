// Compares results/cordis-bun.json and results/cordis-node.json check by check. Timing and stack text are expected to differ; everything else must match.
import { readFileSync } from 'node:fs'
const load = (r: string) => JSON.parse(readFileSync(new URL(`../results/cordis-${r}.json`, import.meta.url), 'utf8'))
const bun = load('bun'), node = load('node')
const strip = (d: any): any => JSON.parse(JSON.stringify(d ?? null, (k, v) => (/ms$|Ms$|MB$|stackHead|effects|msPer/.test(k) ? undefined : v)))
let diffs = 0
console.log(`bun  ${bun.runtime}  ${bun.passed}/${bun.checks.length}  | node ${node.runtime}  ${node.passed}/${node.checks.length}  | cordis ${bun.cordis} / ${node.cordis}`)
for (let i = 0; i < bun.checks.length; i++) {
  const a = bun.checks[i], b = node.checks[i]
  const same = a.id === b.id && a.ok === b.ok && JSON.stringify(strip(a.detail)) === JSON.stringify(strip(b.detail))
  if (!same) { diffs++; console.log('DIFF', a.id, JSON.stringify(strip(a.detail)), JSON.stringify(strip(b.detail))) }
}
console.log(diffs === 0 ? 'identical behaviour on Bun and Node (ignoring timings and stack text)' : diffs + ' difference(s)')
process.exit(diffs ? 1 : 0)
