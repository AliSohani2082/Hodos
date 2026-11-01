/**
 * The tactics puzzle set. Positions are hand-authored; every one is checked
 * by chess.js on each test run (legal position, legal solution line, goal
 * reached) and, where marked, by Stockfish (`pnpm verify:puzzles`). Mirrored
 * variants (colours swapped, ranks flipped) are generated, so hints and
 * explanations are derived from the position rather than written per item.
 * @module @hodos/chess/puzzles
 */
import { Chess } from 'chess.js'
import type { ExerciseMode, HintLevel } from '@hodos/plugin-sdk'
import { bareSan, behind, mirrorFen, mirrorSan, parseMove, PIECE_NAME, targetsAfter } from './position.js'

/** What solving a puzzle means. `best` is judged by the solution line (and engine, when configured). */
export type PuzzleGoal = 'best' | 'mate' | 'check' | 'capture'

/** Tactical theme, used for prompts, hints and the "spot the tactic" items. */
export type PuzzleTheme = 'fork' | 'double-attack' | 'pin' | 'skewer' | 'mate' | 'check' | 'capture'

/** One authored puzzle. */
export interface PuzzleSpec {
  readonly id: string
  readonly skill: string
  readonly fen: string
  /** SAN solution: learner move, opponent reply, learner move… */
  readonly line: readonly string[]
  readonly goal: PuzzleGoal
  readonly theme: PuzzleTheme
  /** Other first moves accepted as correct (verified like the main line). */
  readonly alternatives?: readonly string[]
  readonly difficulty: number
  readonly modes: readonly ExerciseMode[]
  /** Generate a colour-mirrored variant with these id and modes. */
  readonly mirror?: { readonly id: string; readonly modes: readonly ExerciseMode[] }
  /** Whether the Stockfish check applies (mate/check/capture goals are decided by chess.js alone). */
  readonly engineChecked: boolean
}

/** Skill ids of the tactics course. */
export const SKILL = {
  rules: 'chess.rules',
  doubleAttack: 'chess.tactics.double-attack',
  knightFork: 'chess.tactics.fork.knight',
  pin: 'chess.tactics.pin',
  skewer: 'chess.tactics.skewer',
  mate: 'chess.mate.one',
  spot: 'chess.tactics.spot',
} as const

const P: ExerciseMode[] = ['practice', 'review']
const C: ExerciseMode[] = ['checkpoint']
const D: ExerciseMode[] = ['diagnostic']

/** The authored puzzles. */
export const PUZZLES: readonly PuzzleSpec[] = [
  // Rules: check and free captures.
  { id: 'rules-check-rook', skill: SKILL.rules, fen: '4k3/8/8/8/8/8/8/R5K1 w - - 0 1', line: ['Ra8+'], goal: 'check', theme: 'check', difficulty: -2, modes: P, mirror: { id: 'rules-check-rook-m', modes: C }, engineChecked: false },
  { id: 'rules-capture-bishop', skill: SKILL.rules, fen: '4k3/8/8/8/1r6/8/3B4/6K1 w - - 0 1', line: ['Bxb4'], goal: 'capture', theme: 'capture', difficulty: -1.5, modes: P, mirror: { id: 'rules-capture-bishop-m', modes: D }, engineChecked: false },
  { id: 'rules-capture-rook', skill: SKILL.rules, fen: '4k3/8/8/2n5/8/8/8/2R3K1 w - - 0 1', line: ['Rxc5'], goal: 'capture', theme: 'capture', difficulty: -1.5, modes: P, mirror: { id: 'rules-capture-rook-m', modes: C }, engineChecked: false },
  { id: 'rules-check-bishop', skill: SKILL.rules, fen: '4k3/8/8/8/8/3B4/8/6K1 w - - 0 1', line: ['Bb5+'], alternatives: ['Bg6+'], goal: 'check', theme: 'check', difficulty: -1.5, modes: P, engineChecked: false },

  // Double attacks with queen and pawn.
  { id: 'double-queen-rook', skill: SKILL.doubleAttack, fen: 'r3k3/pp3ppp/8/8/7r/8/PP4PP/3Q2K1 w - - 0 1', line: ['Qe1+'], goal: 'best', theme: 'double-attack', difficulty: -0.5, modes: P, mirror: { id: 'double-queen-rook-m', modes: C }, engineChecked: true },
  { id: 'double-pawn-knights', skill: SKILL.doubleAttack, fen: '6k1/6pp/2n1n3/8/3P4/8/6PP/R5K1 w - - 0 1', line: ['d5'], goal: 'best', theme: 'double-attack', difficulty: -0.5, modes: P, mirror: { id: 'double-pawn-knights-m', modes: D }, engineChecked: true },
  { id: 'double-queen-corner', skill: SKILL.doubleAttack, fen: 'r5k1/6pp/8/8/8/8/1r3PPP/3Q2K1 w - - 0 1', line: ['Qd5+'], goal: 'best', theme: 'double-attack', difficulty: 0, modes: P, mirror: { id: 'double-queen-corner-m', modes: C }, engineChecked: true },

  // Knight forks.
  { id: 'fork-royal-a8', skill: SKILL.knightFork, fen: 'r3k3/pp3ppp/8/3N4/8/8/PPP2PPP/6K1 w - - 0 1', line: ['Nc7+', 'Kd7', 'Nxa8'], goal: 'best', theme: 'fork', difficulty: -0.5, modes: P, mirror: { id: 'fork-royal-a8-m', modes: D }, engineChecked: true },
  { id: 'fork-king-queen-e7', skill: SKILL.knightFork, fen: '2q3k1/5ppp/8/3N4/8/8/5PPP/6K1 w - - 0 1', line: ['Ne7+'], goal: 'best', theme: 'fork', difficulty: -0.3, modes: P, mirror: { id: 'fork-king-queen-e7-m', modes: P }, engineChecked: true },
  { id: 'fork-corner-f7', skill: SKILL.knightFork, fen: '3r3k/6pp/8/6N1/8/8/6PP/6K1 w - - 0 1', line: ['Nf7+'], goal: 'best', theme: 'fork', difficulty: 0, modes: P, engineChecked: true },
  { id: 'fork-queen-c6', skill: SKILL.knightFork, fen: '8/q3k1pp/8/8/1N6/8/6PP/7K w - - 0 1', line: ['Nc6+'], goal: 'best', theme: 'fork', difficulty: 0.2, modes: P, engineChecked: true },
  { id: 'fork-back-rank-d7', skill: SKILL.knightFork, fen: '1k3r2/ppp5/8/4N3/8/8/5PPP/6K1 w - - 0 1', line: ['Nd7+'], goal: 'best', theme: 'fork', difficulty: 0.3, modes: P, engineChecked: true },
  { id: 'fork-queen-e6', skill: SKILL.knightFork, fen: '8/2q3k1/8/8/3N4/8/6PP/6K1 w - - 0 1', line: ['Ne6+'], goal: 'best', theme: 'fork', difficulty: 0.2, modes: C, engineChecked: true },
  { id: 'fork-queen-rook-f6', skill: SKILL.knightFork, fen: 'k7/pp1q1p1r/8/8/4N3/6P1/2Q2P1P/6K1 w - - 0 1', line: ['Nf6'], goal: 'best', theme: 'fork', difficulty: 0.6, modes: C, engineChecked: true },

  // Pins.
  { id: 'pin-rook-queen-e', skill: SKILL.pin, fen: '4k3/4q3/8/8/8/8/5K2/R7 w - - 0 1', line: ['Re1'], goal: 'best', theme: 'pin', difficulty: -0.3, modes: P, mirror: { id: 'pin-rook-queen-e-m', modes: D }, engineChecked: true },
  { id: 'pin-bishop-queen', skill: SKILL.pin, fen: '6k1/5q2/8/8/8/1P6/4B3/6K1 w - - 0 1', line: ['Bc4'], goal: 'best', theme: 'pin', difficulty: 0, modes: P, mirror: { id: 'pin-bishop-queen-m', modes: C }, engineChecked: true },
  { id: 'pin-rank-queen', skill: SKILL.pin, fen: '8/8/8/3q3k/1P6/8/8/R5K1 w - - 0 1', line: ['Ra5'], goal: 'best', theme: 'pin', difficulty: 0.2, modes: P, engineChecked: true },
  { id: 'pin-long-diagonal', skill: SKILL.pin, fen: '7k/8/5q2/8/8/2P5/5B2/6K1 w - - 0 1', line: ['Bd4'], goal: 'best', theme: 'pin', difficulty: 0.4, modes: C, engineChecked: true },

  // Skewers.
  { id: 'skewer-rank-rook', skill: SKILL.skewer, fen: '8/8/4k2r/8/8/8/8/R5K1 w - - 0 1', line: ['Ra6+', 'Kd5', 'Rxh6'], goal: 'best', theme: 'skewer', difficulty: -0.2, modes: P, mirror: { id: 'skewer-rank-rook-m', modes: C }, engineChecked: true },
  { id: 'skewer-bishop-queen', skill: SKILL.skewer, fen: '6q1/8/8/3k4/8/8/8/3B3K w - - 0 1', line: ['Bb3+'], goal: 'best', theme: 'skewer', difficulty: 0, modes: P, engineChecked: true },
  { id: 'skewer-file-queen', skill: SKILL.skewer, fen: '3q4/8/8/8/3k4/8/8/4R1K1 w - - 0 1', line: ['Rd1+'], goal: 'best', theme: 'skewer', difficulty: 0.1, modes: P, mirror: { id: 'skewer-file-queen-m', modes: D }, engineChecked: true },
  { id: 'skewer-long-diagonal', skill: SKILL.skewer, fen: '7r/pp5p/5k2/2B5/8/8/PP5P/6K1 w - - 0 1', line: ['Bd4+'], goal: 'best', theme: 'skewer', difficulty: 0.4, modes: C, engineChecked: true },

  // Mate in one.
  { id: 'mate-back-rank-rook', skill: SKILL.mate, fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', line: ['Ra8#'], goal: 'mate', theme: 'mate', difficulty: -0.5, modes: P, mirror: { id: 'mate-back-rank-rook-m', modes: D }, engineChecked: false },
  { id: 'mate-queen-bishop', skill: SKILL.mate, fen: '7k/6pp/5Q2/8/8/8/1B4PP/6K1 w - - 0 1', line: ['Qxg7#'], goal: 'mate', theme: 'mate', difficulty: 0, modes: P, engineChecked: false },
  { id: 'mate-smothered', skill: SKILL.mate, fen: '6rk/6pp/8/6N1/8/8/6PP/6K1 w - - 0 1', line: ['Nf7#'], goal: 'mate', theme: 'mate', difficulty: 0.3, modes: P, engineChecked: false },
  { id: 'mate-back-rank-queen', skill: SKILL.mate, fen: '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1', line: ['Qd8#'], goal: 'mate', theme: 'mate', difficulty: 0, modes: C, engineChecked: false },
  { id: 'mate-king-rook', skill: SKILL.mate, fen: '7k/8/6K1/8/8/8/8/R7 w - - 0 1', line: ['Ra8#'], goal: 'mate', theme: 'mate', difficulty: 0.2, modes: C, engineChecked: false },
]

/** A puzzle with its mirrored variants expanded. */
export interface Puzzle extends PuzzleSpec {
  /** Isomorph group: a puzzle and its mirror share one. */
  readonly group: string
  readonly mirrored: boolean
}

/**
 * Expand mirrors.
 * @param specs - authored puzzles.
 * @returns every puzzle, original first.
 */
export function expandPuzzles(specs: readonly PuzzleSpec[] = PUZZLES): Puzzle[] {
  return specs.flatMap(p => {
    const base: Puzzle = { ...p, group: p.id, mirrored: false }
    if (p.mirror === undefined) return [base]
    const mirrored: Puzzle = {
      ...p,
      id: p.mirror.id,
      fen: mirrorFen(p.fen),
      line: p.line.map(mirrorSan),
      ...(p.alternatives === undefined ? {} : { alternatives: p.alternatives.map(mirrorSan) }),
      modes: p.mirror.modes,
      group: p.id,
      mirrored: true,
    }
    return [base, mirrored]
  })
}

/** Facts about a puzzle's key move for prompts, hints and explanations. */
export interface KeyFacts {
  readonly side: 'White' | 'Black'
  readonly san: string
  readonly piece: string
  readonly from: string
  readonly to: string
  readonly targets: ReadonlyArray<{ readonly square: string; readonly name: string }>
  /** For pins and skewers: the piece behind the first target. */
  readonly behind: { readonly square: string; readonly name: string } | null
  readonly check: boolean
}

/**
 * Derive the key move's facts with chess.js.
 * @param puzzle - the puzzle.
 * @returns key facts.
 * @throws Error when the key move is illegal (caught by the content tests).
 */
export function keyFacts(puzzle: Puzzle): KeyFacts {
  const san = puzzle.line[0] ?? ''
  const move = parseMove(puzzle.fen, san)
  if (move === null) throw new Error(`puzzle ${puzzle.id}: key move ${san} is illegal`)
  const after = new Chess(puzzle.fen)
  after.move(move.san)
  const targets = targetsAfter(puzzle.fen, move)
  const first = targets[0]
  const back = first === undefined ? null : behind(puzzle.fen, move, first.square)
  return {
    side: move.color === 'w' ? 'White' : 'Black',
    san: move.san,
    piece: PIECE_NAME[move.piece],
    from: move.from,
    to: move.to,
    targets: targets.map(t => ({ square: t.square, name: PIECE_NAME[t.piece] })),
    behind: back === null ? null : { square: back.square, name: PIECE_NAME[back.piece] },
    check: after.inCheck(),
  }
}

const THEME_PROMPT: Readonly<Record<PuzzleTheme, string>> = {
  fork: 'find the knight fork',
  'double-attack': 'find the double attack',
  pin: 'find the pin that wins material',
  skewer: 'find the skewer',
  mate: 'find checkmate in one',
  check: 'give check',
  capture: 'win material for free',
}

/**
 * The learner-facing prompt. Practice prompts name the theme; checkpoint and
 * diagnostic prompts only state the goal.
 * @param puzzle - the puzzle.
 * @returns the prompt.
 */
export function promptFor(puzzle: Puzzle): string {
  const facts = keyFacts(puzzle)
  const themed = puzzle.modes.includes('practice') || puzzle.modes.includes('review')
  if (puzzle.goal === 'mate') return `${facts.side} to move: checkmate in one.`
  if (puzzle.goal === 'check') return `${facts.side} to move: give check.`
  if (themed) return `${facts.side} to move: ${THEME_PROMPT[puzzle.theme]}.`
  return `${facts.side} to move and win material.`
}

function targetText(facts: KeyFacts): string {
  const t = facts.targets.slice(0, 2).map(x => `the ${x.name} on ${x.square}`)
  return t.length === 2 ? `${t[0]} and ${t[1]}` : t[0] ?? 'two targets'
}

/**
 * The five-level hint ladder (orient, point, analogous principle, partial step, bottom-out).
 * @param puzzle - the puzzle.
 * @returns hints by level.
 */
export function hintsFor(puzzle: Puzzle): Array<{ level: HintLevel; text: string }> {
  const f = keyFacts(puzzle)
  const follow = puzzle.line.length >= 3 ? ` After ${puzzle.line[1]}, play ${puzzle.line[2]}.` : ''
  const ladder: Record<PuzzleTheme, [string, string, string, string, string]> = {
    fork: [
      'Look for one move that attacks two valuable enemy pieces at the same time.',
      `Your ${f.piece} on ${f.from} is the piece to use.`,
      'A knight attacks up to eight squares at once; a knight check that also hits a rook or queen wins material, because the king must move first.',
      `Move the ${f.piece} to ${f.to}.`,
      `${f.san} attacks ${targetText(f)} at once.${follow}`,
    ],
    'double-attack': [
      'Look for one move that attacks two enemy pieces at once, ideally with check.',
      `Your ${f.piece} on ${f.from} can make two threats at once.`,
      'A double attack works when the opponent can answer only one threat; a check is the strongest first threat.',
      `Move the ${f.piece} to ${f.to}.`,
      `${f.san} attacks ${targetText(f)}; only one of them can be saved.${follow}`,
    ],
    pin: [
      'Look for an enemy piece standing in front of its king on a line one of your pieces can reach.',
      `Your ${f.piece} on ${f.from} can create the pin.`,
      'A pinned piece cannot move without exposing the king behind it, so attacking it again (or capturing it) wins it.',
      `Put the ${f.piece} on ${f.to}.`,
      `${f.san} pins the ${f.targets[0]?.name ?? 'piece'} on ${f.targets[0]?.square ?? f.to}${f.behind === null ? '' : ` to the ${f.behind.name} on ${f.behind.square}`}; the pinned piece is lost.${follow}`,
    ],
    skewer: [
      'Look for two enemy pieces on one line, the more valuable one in front.',
      `Your ${f.piece} on ${f.from} can attack along that line.`,
      'A skewer attacks a valuable piece (often the king); when it steps aside, the piece behind it falls.',
      `Move the ${f.piece} to ${f.to}${f.check ? ' with check' : ''}.`,
      `${f.san} attacks the ${f.targets[0]?.name ?? 'piece'} on ${f.targets[0]?.square ?? f.to}${f.behind === null ? '' : `; when it moves, the ${f.behind.name} on ${f.behind.square} behind it falls`}.${follow}`,
    ],
    mate: [
      'Look for a check that leaves the king no escape square.',
      `Your ${f.piece} on ${f.from} delivers it.`,
      'List the king\'s escape squares and what covers each one; mate needs check plus no escape, no block and no capture.',
      `The ${f.piece} goes to ${f.to}.`,
      `${f.san} is checkmate.`,
    ],
    check: [
      'Which of your pieces can attack the enemy king in one move?',
      `Your ${f.piece} on ${f.from} can do it.`,
      'Rooks attack along ranks and files, bishops along diagonals.',
      `Move the ${f.piece} to ${f.to}.`,
      `${f.san} gives check.`,
    ],
    capture: [
      'Is an enemy piece attacked by you and defended by nothing?',
      `Look at what your ${f.piece} on ${f.from} attacks.`,
      'A piece is free when you can take it and the opponent cannot take back.',
      `Capture on ${f.to}.`,
      `${f.san} wins the ${f.targets[0]?.name ?? 'piece'} for free.`,
    ],
  }
  const [l1, l2, l3, l4, l5] = ladder[puzzle.theme]
  return [{ level: 1, text: l1 }, { level: 2, text: l2 }, { level: 3, text: l3 }, { level: 4, text: l4 }, { level: 5, text: l5 }]
}

/**
 * The worked explanation released after the attempt.
 * @param puzzle - the puzzle.
 * @returns explanation text.
 */
export function explanationFor(puzzle: Puzzle): string {
  const f = keyFacts(puzzle)
  const rest = puzzle.line.length > 1 ? ` The solution line is ${puzzle.line.join(' ')}.` : ''
  switch (puzzle.theme) {
    case 'mate': return `${f.san} is checkmate: the king is in check and every escape square is covered.`
    case 'check': return `${f.san} attacks the king.${puzzle.alternatives !== undefined && puzzle.alternatives.length > 0 ? ` ${puzzle.alternatives.join(', ')} also gives check.` : ''}`
    case 'capture': return `${f.san} takes a piece nothing defends.`
    case 'pin': return `${f.san} pins the ${f.targets[0]?.name ?? 'piece'}${f.behind === null ? '' : ` to the ${f.behind.name}`}: it cannot escape without exposing what stands behind it.${rest}`
    case 'skewer': return `${f.san} attacks the ${f.targets[0]?.name ?? 'piece'}; once it moves, the ${f.behind?.name ?? 'piece'} behind it can be taken.${rest}`
    default: return `${f.san} creates two threats at once (${targetText(f)}); the opponent cannot meet both.${rest}`
  }
}

/**
 * Normalize SAN for comparison with the line (check markers dropped).
 * @param san - SAN.
 * @returns the bare move.
 */
export function sameMove(a: string, b: string): boolean {
  return bareSan(a) === bareSan(b)
}
