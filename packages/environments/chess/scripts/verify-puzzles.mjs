#!/usr/bin/env node
/**
 * Verify the chess puzzle set with a UCI engine (for example Stockfish).
 *
 * chess.js already checks every puzzle on each test run (legal position,
 * legal line, the goal or theme the key move claims). This script adds the
 * engine's judgment for every puzzle marked `engineChecked` (mirrors too):
 *
 *  - sound: each learner move of the line is the engine's best move or within
 *    MARGIN centipawns of it;
 *  - unique: every other move at that point is at least UNIQUE centipawns
 *    worse, unless the puzzle lists it as an accepted alternative (otherwise a
 *    learner who found it would be marked wrong);
 *  - realistic: each scripted opponent reply is the best defence or within
 *    DEFENCE centipawns of it.
 *
 * With --write, the ids that passed are recorded in src/verification.ts with
 * the engine name, depth, date and the puzzle-set hash; the record stops
 * applying as soon as any puzzle changes. Without --write it only reports.
 *
 * Usage:
 *   pnpm build
 *   node packages/environments/chess/scripts/verify-puzzles.mjs --engine /path/to/stockfish [--depth 18] [--write]
 * The engine path may also come from HODOS_STOCKFISH. Exit code 1 when any
 * checked puzzle fails.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Chess } from 'chess.js'

const MARGIN = 30
const UNIQUE = 150
const DEFENCE = 100
const LINES = 4

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '../lib/index.js')
if (!existsSync(lib)) {
  console.error(`Build first (pnpm build): ${lib} is missing.`)
  process.exit(2)
}
const { expandPuzzles, puzzleSetHash, scoreCp, UciEngine } = await import(pathToFileURL(lib).href)

const { values } = parseArgs({
  options: {
    engine: { type: 'string' },
    depth: { type: 'string', default: '18' },
    write: { type: 'boolean', default: false },
  },
})
const enginePath = values.engine ?? process.env.HODOS_STOCKFISH ?? ''
const depth = Number(values.depth)
if (enginePath === '' || !isAbsolute(enginePath) || !existsSync(enginePath)) {
  console.error('Pass --engine /absolute/path/to/stockfish (or set HODOS_STOCKFISH).')
  process.exit(2)
}
if (!Number.isInteger(depth) || depth < 8 || depth > 30) {
  console.error('--depth must be an integer between 8 and 30.')
  process.exit(2)
}

const engine = new UciEngine(enginePath)
const timeoutMs = 180_000

function uciOf(move) {
  return `${move.from}${move.to}${move.promotion ?? ''}`
}

function sanOf(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length > 4 ? { promotion: uci[4] } : {}) }).san
  } catch {
    return uci
  }
}

function fmt(cp) {
  if (Math.abs(cp) >= 90_000) return cp > 0 ? `mate in ${100_000 - cp}` : `mated in ${100_000 + cp}`
  return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`
}

/** Score of a move from the mover's point of view: its MultiPV line, or a search after it. */
async function moveScore(fen, analysis, move) {
  const line = analysis.lines.find(l => l.pv[0] === uciOf(move))
  if (line !== undefined) return { score: scoreCp(line.score), ranked: true }
  const after = new Chess(fen)
  after.move(move.san)
  if (after.isCheckmate()) return { score: 100_000 - 1, ranked: false }
  if (after.isDraw()) return { score: 0, ranked: false }
  const reply = await engine.analyse(after.fen(), { depth: depth - 1, timeoutMs })
  const best = reply.lines[0]
  return { score: best === undefined ? 0 : -scoreCp(best.score), ranked: false }
}

async function verify(puzzle) {
  const problems = []
  const chess = new Chess(puzzle.fen)
  for (let ply = 0; ply < puzzle.line.length; ply += 1) {
    const fen = chess.fen()
    const move = chess.move(puzzle.line[ply])
    const analysis = await engine.analyse(fen, { depth, multiPv: LINES, timeoutMs })
    const best = analysis.lines[0]
    if (best === undefined) {
      problems.push(`ply ${ply + 1}: the engine returned no line`)
      break
    }
    const bestScore = scoreCp(best.score)
    const own = await moveScore(fen, analysis, move)
    if (ply % 2 === 0) {
      if (own.score < bestScore - MARGIN) {
        problems.push(`ply ${ply + 1} ${move.san}: the engine prefers ${sanOf(fen, best.pv[0])} (${fmt(bestScore)} vs ${fmt(own.score)})`)
      }
      const accepted = new Set([uciOf(move)])
      if (ply === 0) {
        for (const alternative of puzzle.alternatives ?? []) accepted.add(uciOf(new Chess(fen).move(alternative)))
      }
      for (const line of analysis.lines) {
        if (accepted.has(line.pv[0])) continue
        const score = scoreCp(line.score)
        if (score > own.score - UNIQUE) problems.push(`ply ${ply + 1}: ${sanOf(fen, line.pv[0])} is nearly as good (${fmt(score)} vs ${fmt(own.score)})`)
      }
    } else if (own.score < bestScore - DEFENCE) {
      problems.push(`ply ${ply + 1}: the reply ${move.san} is weaker than ${sanOf(fen, best.pv[0])} (${fmt(own.score)} vs ${fmt(bestScore)} for the defender)`)
    }
  }
  return problems
}

try {
  const name = await engine.identify()
  const puzzles = expandPuzzles().filter(p => p.engineChecked)
  console.log(`Engine: ${name || enginePath}, depth ${depth}, ${puzzles.length} engine-checked puzzles`)
  const verified = []
  let failed = 0
  for (const puzzle of puzzles) {
    const problems = await verify(puzzle)
    if (problems.length === 0) {
      verified.push(puzzle.id)
      console.log(`  ok    ${puzzle.id}`)
    } else {
      failed += 1
      console.log(`  FAIL  ${puzzle.id}`)
      for (const problem of problems) console.log(`          ${problem}`)
    }
  }
  console.log(`${verified.length} verified, ${failed} failed`)
  if (values.write) {
    const file = join(here, '../src/verification.ts')
    const record = {
      engine: name || 'unknown UCI engine',
      depth,
      date: new Date().toISOString().slice(0, 10),
      puzzleSetHash: puzzleSetHash(),
      verified,
    }
    writeFileSync(file, `/**
 * Result of the last Stockfish verification run (\`pnpm verify:puzzles\`).
 * Generated; do not edit by hand. It applies only while \`puzzleSetHash\`
 * matches the current puzzle set.
 * @module @hodos/chess/verification
 */
export const STOCKFISH_VERIFICATION: { readonly engine: string; readonly depth: number; readonly date: string; readonly puzzleSetHash: string; readonly verified: readonly string[] } = ${JSON.stringify(record, null, 2)}
`)
    console.log(`Recorded in ${file}; rebuild (pnpm build) to apply.`)
  }
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  engine.dispose()
}
