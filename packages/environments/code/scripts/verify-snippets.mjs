#!/usr/bin/env node
/**
 * Verify the expected output of every shipped program (exercise keys and
 * lesson snippets) by running it with CPython.
 *
 * These are the course's own reviewed programs, never learner code. Each
 * program runs twice as `python -I -X utf8 -c <source>` in an empty temporary
 * directory with an empty environment, empty standard input and a 5 s
 * timeout; `-I` turns on hash randomization, so the two runs use different
 * hash seeds and an output that depends on set or dict-of-str ordering shows
 * up as a mismatch. A program passes when both runs exit 0 with nothing on
 * stderr and print exactly the expected output (after the same normalization
 * the grader uses).
 *
 * With --write, the ids that passed are recorded in src/verification.ts with
 * the Python version, the date and the program-set hash; the record stops
 * applying as soon as any program or output changes. Without --write it only
 * reports.
 *
 * Usage:
 *   pnpm build
 *   node packages/environments/code/scripts/verify-snippets.mjs [--python /usr/bin/python3] [--write]
 * The interpreter may also come from HODOS_PYTHON (default: python3 on PATH).
 * Exit code 1 when any program fails.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '../lib/index.js')
if (!existsSync(lib)) {
  console.error(`Build first (pnpm build): ${lib} is missing.`)
  process.exit(2)
}
const { outputLines, snippets, snippetSetHash } = await import(pathToFileURL(lib).href)

const { values } = parseArgs({ options: { python: { type: 'string' }, write: { type: 'boolean', default: false } } })
const python = values.python ?? process.env.HODOS_PYTHON ?? 'python3'
const scratch = mkdtempSync(join(tmpdir(), 'hodos-snippets-'))
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }

function run(args) {
  return spawnSync(python, ['-I', '-X', 'utf8', ...args], { cwd: scratch, env, input: '', encoding: 'utf8', timeout: 5000 })
}

const version = run(['-c', 'import platform; print(platform.python_implementation(), platform.python_version())'])
if (version.status !== 0) {
  console.error(`Cannot run ${python}: ${version.error?.message ?? version.stderr}`)
  process.exit(2)
}
const interpreter = version.stdout.trim()
console.log(`Interpreter: ${interpreter} (${python})`)

const same = (a, b) => JSON.stringify(outputLines(a)) === JSON.stringify(outputLines(b))
const verified = []
const failures = []
try {
  for (const snippet of snippets()) {
    const problems = []
    for (const attempt of [1, 2]) {
      const result = run(['-c', snippet.source])
      if (result.error !== undefined) problems.push(`run ${attempt}: ${result.error.message}`)
      else if (result.status !== 0) problems.push(`run ${attempt}: exit ${result.status}: ${result.stderr.trim().split('\n').pop()}`)
      else if (result.stderr !== '') problems.push(`run ${attempt}: wrote to stderr: ${result.stderr.trim()}`)
      else if (!same(result.stdout, snippet.output)) problems.push(`run ${attempt}: printed ${JSON.stringify(result.stdout)}, key says ${JSON.stringify(snippet.output)}`)
    }
    if (problems.length === 0) verified.push(snippet.id)
    else failures.push({ id: snippet.id, problems })
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

for (const f of failures) console.log(`FAIL ${f.id}\n  ${f.problems.join('\n  ')}`)
console.log(`${verified.length} of ${verified.length + failures.length} programs print exactly their expected output.`)

if (values.write) {
  const record = { python: interpreter, date: new Date().toISOString().slice(0, 10), snippetSetHash: snippetSetHash(), verified }
  const target = join(here, '../src/verification.ts')
  writeFileSync(target, `/**
 * Result of the last CPython run over every program with a known output
 * (\`pnpm verify:snippets\`). Generated; do not edit by hand. It applies only
 * while \`snippetSetHash\` matches the current programs.
 * @module @hodos/code/verification
 */
export const CPYTHON_VERIFICATION: { readonly python: string; readonly date: string; readonly snippetSetHash: string; readonly verified: readonly string[] } = ${JSON.stringify(record, null, 2)}
`)
  console.log(`Wrote ${target}`)
}
process.exit(failures.length === 0 ? 0 : 1)
