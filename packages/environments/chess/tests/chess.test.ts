import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import type { ExerciseItem, JsonObject, StepInput, StepResult } from '@hodos/plugin-sdk'
import { engineVerifiedIds, expandPuzzles, mirrorFen, mirrorSan, PUZZLES, tacticsCourse, UciEngine } from '../src/index.js'
import { parseInfo, scoreCp } from '../src/engine.js'
import { stepPuzzle } from '../src/grader.js'
import { validatePuzzleItem } from '../src/kinds.js'
import { keyFacts } from '../src/puzzles.js'

// Engine tests run when HODOS_STOCKFISH names a UCI engine binary.
const STOCKFISH = process.env.HODOS_STOCKFISH ?? ''
const course = tacticsCourse()
const item = (id: string): ExerciseItem => {
  const found = course.items.find(i => i.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}

function stepInput(it: ExerciseItem, move: string, progress: StepResult['progress'] | null = null): StepInput {
  return { kind: it.kind, payload: it.payload, key: it.key, response: { move }, mode: 'practice', skills: it.skills, attempt: 1, progress }
}

describe('puzzle set', () => {
  it('has at least ten verified tactics and every position is legal', () => {
    const tactics = expandPuzzles().filter(p => ['fork', 'double-attack', 'pin', 'skewer', 'mate'].includes(p.theme))
    expect(tactics.length).toBeGreaterThanOrEqual(10)
    for (const p of expandPuzzles()) {
      const chess = new Chess(p.fen)
      for (const san of p.line) expect(() => chess.move(san), `${p.id}: ${san}`).not.toThrow()
    }
  })

  it('carries a Stockfish verification record for exactly the current puzzle set', () => {
    // Changing any puzzle voids the record; re-run `pnpm verify:puzzles --write` with an engine.
    const checked = expandPuzzles().filter(p => p.engineChecked).map(p => p.id).sort()
    expect([...engineVerifiedIds()].sort()).toEqual(checked)
    const engineItems = tacticsCourse(engineVerifiedIds()).items.filter(i => i.provenance?.verifiedBy?.includes('stockfish'))
    expect(engineItems.map(i => i.id).sort()).toEqual(checked)
  })

  it('passes the plugin\'s semantic validation for every item', () => {
    for (const it of course.items.filter(i => i.kind === 'chess.puzzle')) {
      expect(validatePuzzleItem(it).filter(d => d.severity === 'error'), it.id).toEqual([])
    }
  })

  it('rejects broken positions and false claims', () => {
    const base = item('fork-royal-a8')
    const errors = (patch: Partial<ExerciseItem>): string[] => validatePuzzleItem({ ...base, ...patch }).filter(d => d.severity === 'error').map(d => d.code)
    expect(errors({ payload: { ...(base.payload as JsonObject), fen: 'not a fen' } })).toContain('chess/fen')
    // White to move while Black is in check: impossible position.
    expect(errors({ payload: { ...(base.payload as JsonObject), fen: '4k3/8/8/8/8/8/8/4R1K1 w - - 0 1' } })).toContain('chess/opponent-in-check')
    // A knight on d5 cannot reach d4.
    expect(errors({ key: { line: ['Nd4'], theme: 'fork' } })).toContain('chess/illegal-line')
    expect(errors({ key: { line: ['Nb4'], theme: 'fork' }, payload: { ...(base.payload as JsonObject), plies: 1 } })).toContain('chess/not-double-attack')
    const mate = item('mate-back-rank-rook')
    expect(validatePuzzleItem({ ...mate, key: { line: ['Ra7'], theme: 'mate' } }).map(d => d.code)).toContain('chess/not-mate')
  })

  it('mirrors positions and moves consistently', () => {
    const p = PUZZLES.find(x => x.id === 'fork-royal-a8')
    if (p === undefined) throw new Error('fixture')
    expect(mirrorFen(mirrorFen(p.fen))).toBe(p.fen)
    expect(mirrorSan('Nc7+')).toBe('Nc2+')
    const mirrored = expandPuzzles().find(x => x.id === 'fork-royal-a8-m')
    expect(mirrored?.fen.split(' ')[1]).toBe('b')
    expect(mirrored?.line).toEqual(['Nc2+', 'Kd2', 'Nxa1'])
  })

  it('derives hints and explanations from the position', () => {
    const f = keyFacts(expandPuzzles().find(x => x.id === 'fork-royal-a8-m') ?? expandPuzzles()[0]!)
    expect(f).toMatchObject({ side: 'Black', piece: 'knight', from: 'd4', to: 'c2', check: true })
    expect(f.targets.map(t => t.name)).toEqual(['king', 'rook'])
    const hints = item('fork-royal-a8').hints ?? []
    expect(hints.map(h => h.level)).toEqual([1, 2, 3, 4, 5])
    // Only the bottom-out hint names the solution move.
    expect(hints.filter(h => h.text.includes('Nc7+')).map(h => h.level)).toEqual([5])
    const pinHint = (item('pin-rank-queen').hints ?? []).find(h => h.level === 5)?.text
    expect(pinHint).toContain('to the king on h5')
  })

  it('never puts the solution in the client payload', () => {
    for (const it of course.items) {
      const key = it.key as JsonObject
      const line = Array.isArray(key.line) ? key.line : []
      for (const san of line) if (typeof san === 'string' && san.length >= 4) expect(JSON.stringify(it.payload), it.id).not.toContain(san)
    }
  })
})

describe('grader', () => {
  it('accepts the key move and completes', async () => {
    const r = await stepPuzzle(stepInput(item('fork-king-queen-e7'), 'Ne7+'))
    expect(r.status).toBe('complete')
    if (r.status === 'complete') expect(r.grade).toMatchObject({ correct: true, score: 1 })
  })

  it('accepts UCI notation', async () => {
    const r = await stepPuzzle(stepInput(item('fork-king-queen-e7'), 'd5e7'))
    expect(r.status === 'complete' && r.grade.correct).toBe(true)
  })

  it('ignores illegal moves without consuming the attempt', async () => {
    const r = await stepPuzzle(stepInput(item('fork-king-queen-e7'), 'Qh5'))
    expect(r.status).toBe('continue')
    if (r.status === 'continue') expect(r.message).toContain('not a legal move')
  })

  it('marks a wrong move with misconceptions and feedback that hides the answer', async () => {
    const it = item('fork-king-queen-e7')
    const r = await stepPuzzle(stepInput(it, 'Nb6'))
    expect(r.status).toBe('complete')
    if (r.status !== 'complete') return
    expect(r.grade.correct).toBe(false)
    expect(r.grade.misconceptions).toEqual(expect.arrayContaining(['single-threat', 'missed-check']))
    expect(r.grade.feedback).not.toContain('Ne7')
  })

  it('plays the opponent\'s reply in multi-move lines and gives partial credit', async () => {
    const it = item('fork-royal-a8')
    const first = await stepPuzzle(stepInput(it, 'Nc7+'))
    expect(first.status).toBe('continue')
    if (first.status !== 'continue') return
    expect(first.progress).toMatchObject({ played: ['Nc7+', 'Kd7'] })
    const good = await stepPuzzle(stepInput(it, 'Nxa8', first.progress))
    expect(good.status === 'complete' && good.grade.correct).toBe(true)
    const bad = await stepPuzzle(stepInput(it, 'Nb5', first.progress))
    expect(bad.status === 'complete' && !bad.grade.correct && bad.grade.score === 0.5).toBe(true)
  })

  it('accepts any checkmate, any check and any free capture for those goals', async () => {
    const check = await stepPuzzle(stepInput(item('rules-check-bishop'), 'Bg6+'))
    expect(check.status === 'complete' && check.grade.correct).toBe(true)
    const notMate = await stepPuzzle(stepInput(item('mate-back-rank-rook'), 'Ra7'))
    expect(notMate.status === 'complete' && !notMate.grade.correct).toBe(true)
    // Two undefended pieces: either capture is right; a defended one is not.
    const base = item('rules-capture-bishop')
    const two: ExerciseItem = { ...base, payload: { ...(base.payload as JsonObject), fen: '4k3/8/8/6n1/1r6/8/3B4/6K1 w - - 0 1' } }
    const other = await stepPuzzle(stepInput(two, 'Bxg5'))
    expect(other.status === 'complete' && other.grade.correct).toBe(true)
    const defended: ExerciseItem = { ...base, payload: { ...(base.payload as JsonObject), fen: '4k3/8/2p5/1r6/8/8/4B3/6K1 w - - 0 1' } }
    const lost = await stepPuzzle(stepInput(defended, 'Bxb5'))
    expect(lost.status === 'complete' && !lost.grade.correct).toBe(true)
  })

  it('solves mirrored puzzles with the mirrored line', async () => {
    const it = item('skewer-rank-rook-m')
    const first = await stepPuzzle(stepInput(it, 'Ra3+'))
    expect(first.status).toBe('continue')
    if (first.status !== 'continue') return
    const done = await stepPuzzle(stepInput(it, 'Rxh3', first.progress))
    expect(done.status === 'complete' && done.grade.correct).toBe(true)
  })
})

describe('engine protocol', () => {
  it('parses UCI info lines', () => {
    expect(parseInfo('info depth 12 seldepth 18 multipv 2 score cp -35 nodes 1 pv e7e5 g1f3')).toMatchObject({ depth: 12, multipv: 2, score: { cp: -35 }, pv: ['e7e5', 'g1f3'] })
    expect(parseInfo('info depth 5 score mate 2 pv d1h5')).toMatchObject({ score: { mate: 2 } })
    expect(parseInfo('info depth 5 score cp 10 lowerbound pv d1h5')).toBeNull()
    expect(scoreCp({ mate: 3 })).toBeGreaterThan(scoreCp({ cp: 2000 }))
  })

  it.skipIf(STOCKFISH === '' || !existsSync(STOCKFISH))('finds the knight fork with Stockfish and accepts equally strong alternatives', async () => {
    const engine = new UciEngine(STOCKFISH)
    try {
      const fork = item('fork-king-queen-e7')
      const analysis = await engine.analyse((fork.payload as { fen: string }).fen, { depth: 12, timeoutMs: 20_000 })
      expect(analysis.bestmove).toBe('d5e7')
      // Re1 and Re2/Rd1-style rook moves: a different rook move pinning on the e-file must not be accepted unless as strong.
      const r = await stepPuzzle(stepInput(item('pin-rook-queen-e'), 'Ra7'), { engine: () => engine, engineMovetimeMs: 200 })
      expect(r.status === 'complete' && r.grade.correct).toBe(false)
    } finally {
      engine.dispose()
    }
  }, 60_000)
})
