/**
 * Chess grading. chess.js decides legality and what a move does (check,
 * mate, a free capture), which is all that check, mate and capture goals
 * need; for `best` goals the authored solution line decides correctness. An
 * optional engine may accept a different first move that is as strong as
 * the key move (it can never reject the key, and no language model is
 * involved). Feedback never names the solution before it is released.
 * @module @hodos/chess/grader
 */
import { Chess } from 'chess.js'
import type { GradeInput, GradeResult, JsonObject, JsonValue, StepInput, StepResult } from '@hodos/plugin-sdk'
import { scoreCp, type UciEngine } from './engine.js'
import { leavesPieceHanging, parseMove, targetsAfter } from './position.js'
import { sameMove, type PuzzleGoal, type PuzzleTheme } from './puzzles.js'

/** Client-visible puzzle payload. */
export interface PuzzlePayload {
  readonly fen: string
  readonly orientation: 'white' | 'black'
  readonly prompt: string
  readonly goal: PuzzleGoal
  /** Learner moves the solution needs. */
  readonly plies: number
}

/** Server-only puzzle key. */
export interface PuzzleKey {
  readonly line: readonly string[]
  readonly alternatives?: readonly string[]
  readonly theme: PuzzleTheme
}

/** Server-held, client-visible progress of a stepwise puzzle. */
export interface PuzzleProgress {
  readonly fen: string
  readonly played: readonly string[]
}

/** Misconception ids this grader reports, with learner feedback. */
export const MISCONCEPTIONS: Readonly<Record<string, string>> = {
  'hanging-piece': 'Your piece can be captured for free on its new square.',
  'single-threat': 'That move makes only one threat; look for a square that attacks two valuable pieces at once.',
  'missed-check': 'Look for a move that also gives check, so the opponent has no time to save everything.',
  'check-not-mate': 'That is check, but the king can still escape, block or capture.',
}

function obj(value: JsonValue | null | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Read the payload (already schema-validated by the platform). */
export function readPayload(value: JsonValue): PuzzlePayload {
  const p = obj(value)
  const goal = p.goal === 'mate' || p.goal === 'check' || p.goal === 'capture' ? p.goal : 'best'
  return {
    fen: typeof p.fen === 'string' ? p.fen : '',
    orientation: p.orientation === 'black' ? 'black' : 'white',
    prompt: typeof p.prompt === 'string' ? p.prompt : '',
    goal,
    plies: typeof p.plies === 'number' ? p.plies : 1,
  }
}

/** Read the key (already schema-validated by the platform). */
export function readKey(value: JsonValue): PuzzleKey {
  const k = obj(value)
  const themes: readonly PuzzleTheme[] = ['fork', 'double-attack', 'pin', 'skewer', 'mate', 'check', 'capture']
  return {
    line: strings(k.line),
    alternatives: strings(k.alternatives),
    theme: themes.find(t => t === k.theme) ?? 'fork',
  }
}

function readProgress(value: JsonValue | null, start: string): PuzzleProgress {
  const p = obj(value)
  return typeof p.fen === 'string' ? { fen: p.fen, played: strings(p.played) } : { fen: start, played: [] }
}

function result(input: GradeInput, score: number, correct: boolean, misconceptions: string[], feedback: string): GradeResult {
  return { score, correct, skillEvidence: input.skills.map(s => ({ skillId: s.skillId, score })), misconceptions, feedback }
}

/** Options for the puzzle grader. */
export interface GraderOptions {
  /** Optional engine for accepting equally strong alternative first moves. */
  readonly engine?: () => UciEngine | null
  /** Engine think time per position, ms. */
  readonly engineMovetimeMs?: number
}

async function engineAccepts(engine: UciEngine, fen: string, learner: string, key: string, movetimeMs: number): Promise<boolean> {
  const evalAfter = async (san: string): Promise<number> => {
    const chess = new Chess(fen)
    chess.move(san)
    if (chess.isCheckmate()) return 100_000
    const analysis = await engine.analyse(chess.fen(), { movetimeMs, timeoutMs: movetimeMs + 1500 })
    const best = analysis.lines[0]
    // Scores are from the opponent's point of view after our move.
    return best === undefined ? 0 : -scoreCp(best.score)
  }
  const [mine, theirs] = [await evalAfter(learner), await evalAfter(key)]
  return mine >= 200 && mine >= theirs - 50
}

/**
 * One step of a puzzle.
 * @param input - step input (payload, key, progress, response).
 * @param options - optional engine.
 * @returns continue (opponent replied, or an illegal move was ignored) or complete.
 */
export async function stepPuzzle(input: StepInput, options: GraderOptions = {}): Promise<StepResult> {
  const payload = readPayload(input.payload)
  const key = readKey(input.key)
  const progress = readProgress(input.progress, payload.fen)
  const typed = obj(input.response).move
  const text = typeof typed === 'string' ? typed : ''
  const move = parseMove(progress.fen, text)
  if (move === null) {
    // An illegal move costs nothing: the board is unchanged.
    return { status: 'continue', progress: { fen: progress.fen, played: [...progress.played] }, message: `${text.slice(0, 12) || 'That'} is not a legal move in this position.` }
  }
  const ply = progress.played.length
  const after = new Chess(progress.fen)
  after.move(move.san)
  const played = [...progress.played, move.san]
  const learnerPlies = Math.ceil(key.line.length / 2)
  const done = Math.floor(ply / 2)

  let correct: boolean
  switch (payload.goal) {
    case 'mate': correct = after.isCheckmate(); break
    case 'check': correct = after.inCheck(); break
    // Any capture of an undefended piece: the capturing piece cannot be taken back.
    case 'capture': correct = move.captured !== undefined && !after.isAttacked(move.to, after.turn()); break
    default: {
      const expected = key.line[ply] ?? ''
      correct = sameMove(move.san, expected) || (ply === 0 && (key.alternatives ?? []).some(a => sameMove(a, move.san)))
      if (!correct && ply === 0 && payload.goal === 'best') {
        const engine = options.engine?.() ?? null
        if (engine !== null) {
          try {
            correct = await engineAccepts(engine, progress.fen, move.san, expected, options.engineMovetimeMs ?? 300)
          } catch {
            // Without a verdict the authored line stands.
            correct = false
          }
        }
      }
    }
  }

  if (!correct) {
    const misconceptions: string[] = []
    if (leavesPieceHanging(progress.fen, move)) misconceptions.push('hanging-piece')
    const keyMove = parseMove(progress.fen, key.line[ply] ?? '')
    if ((key.theme === 'fork' || key.theme === 'double-attack') && targetsAfter(progress.fen, move).length < 2) misconceptions.push('single-threat')
    if (keyMove !== null && payload.goal === 'best') {
      const keyGivesCheck = new Chess(progress.fen)
      keyGivesCheck.move(keyMove.san)
      if (keyGivesCheck.inCheck() && !after.inCheck()) misconceptions.push('missed-check')
    }
    if (payload.goal === 'mate' && after.inCheck()) misconceptions.push('check-not-mate')
    const score = learnerPlies === 0 ? 0 : done / learnerPlies
    const nudge = payload.goal === 'mate' ? 'That move is not checkmate.'
      : payload.goal === 'check' ? 'That move does not give check.'
      : payload.goal === 'capture' ? (move.captured === undefined ? 'That move does not capture anything.' : 'That piece is defended: you would lose your piece in return.')
      : done > 0 ? 'Good start, but that follow-up lets the material escape.' : 'That move does not win material.'
    return { status: 'complete', progress: { fen: after.fen(), played }, grade: result(input, score, false, misconceptions, nudge) }
  }

  const reply = key.line[ply + 1]
  if (payload.goal === 'best' && reply !== undefined && sameMove(move.san, key.line[ply] ?? '')) {
    const replied = new Chess(after.fen())
    let replySan: string
    try {
      replySan = replied.move(reply).san
    } catch {
      // Validated content cannot reach this; finish rather than strand the learner.
      return { status: 'complete', progress: { fen: after.fen(), played }, grade: result(input, 1, true, [], 'Correct.') }
    }
    if (key.line[ply + 2] !== undefined) {
      return { status: 'continue', progress: { fen: replied.fen(), played: [...played, replySan] }, message: `Good. ${replied.turn() === 'w' ? 'Black' : 'White'} replied ${replySan}. Your move.` }
    }
  }
  const feedback = payload.goal === 'mate' ? `Checkmate! ${move.san}.`
    : payload.goal === 'check' ? `Yes — ${move.san} gives check.`
    : payload.goal === 'capture' ? `Yes — ${move.san} wins a piece for free.`
    : `Correct — ${move.san}.`
  return { status: 'complete', progress: { fen: after.fen(), played }, grade: result(input, 1, true, [], feedback) }
}

/**
 * Grade a "spot the tactic" choice.
 * @param input - grade input.
 * @returns the grade.
 */
export function gradeIdentify(input: GradeInput): GradeResult {
  const choice = obj(input.response).choice
  const correct = typeof choice === 'string' && choice === obj(input.key).correct
  return result(input, correct ? 1 : 0, correct, [], correct ? 'Right.' : 'Not that one — look at what the strongest move attacks.')
}
