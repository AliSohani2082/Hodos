/**
 * Chess helpers on top of chess.js: the only authority on legality in this
 * plugin. Position validation, move parsing (SAN or UCI), board mirroring,
 * and the attack facts used for hints and misconception detection.
 * @module @hodos/chess/position
 */
import { Chess, SQUARES, validateFen, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'

/** Piece names used in learner-facing text. */
export const PIECE_NAME: Readonly<Record<PieceSymbol, string>> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }

/** Conventional material values (king high so it counts as a target). */
export const PIECE_VALUE: Readonly<Record<PieceSymbol, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }

const SQUARE_SET: ReadonlySet<string> = new Set(SQUARES)

/** Whether a string names a board square. */
export function isSquare(value: string): value is Square {
  return SQUARE_SET.has(value)
}

/** A validation finding. */
export interface PositionProblem {
  readonly code: string
  readonly message: string
}

/**
 * Validate a puzzle position: a legal FEN whose side not to move is not in
 * check (otherwise the position could not have arisen).
 * @param fen - candidate FEN.
 * @returns problems; empty when the position is usable.
 */
export function positionProblems(fen: string): PositionProblem[] {
  const result = validateFen(fen)
  if (!result.ok) return [{ code: 'chess/fen', message: `invalid FEN: ${result.error ?? 'unknown error'}` }]
  const flipped = fen.split(' ')
  flipped[1] = flipped[1] === 'w' ? 'b' : 'w'
  flipped[3] = '-'
  try {
    const other = new Chess(flipped.join(' '))
    if (other.inCheck()) return [{ code: 'chess/opponent-in-check', message: 'the side not to move is in check' }]
  } catch {
    // The flipped FEN can be invalid only if the original was; reported above.
  }
  return []
}

/**
 * Parse a learner move given as SAN (`Nf3`, `exd5`, `O-O`) or UCI (`g1f3`, `e7e8q`).
 * @param fen - position.
 * @param text - the move text.
 * @returns the move, or null when it is not legal in the position.
 */
export function parseMove(fen: string, text: string): Move | null {
  const chess = new Chess(fen)
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 12) return null
  const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(trimmed)
  try {
    if (uci !== null) {
      const from = (uci[1] ?? '').toLowerCase()
      const to = (uci[2] ?? '').toLowerCase()
      const promotion = uci[3]?.toLowerCase()
      if (!isSquare(from) || !isSquare(to)) return null
      return chess.move({ from, to, ...(promotion === undefined ? {} : { promotion }) })
    }
    // Accept a missing or extra check/mate suffix and 0-0 for castling.
    return chess.move(trimmed.replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O'), { strict: false })
  } catch {
    // chess.js throws for illegal or unparsable moves.
    return null
  }
}

/**
 * Apply a SAN line to a position.
 * @param fen - start position.
 * @param line - SAN moves.
 * @returns the resulting FEN, or null when a move is illegal.
 */
export function playLine(fen: string, line: readonly string[]): string | null {
  const chess = new Chess(fen)
  try {
    for (const san of line) chess.move(san)
  } catch {
    // An illegal move invalidates the line.
    return null
  }
  return chess.fen()
}

/** SAN without check and mate markers, for comparisons. */
export function bareSan(san: string): string {
  return san.replace(/[+#!?]+$/g, '')
}

const SQUARE = /([a-h])([1-8])/g

/** Swap upper and lower case (FEN text is ASCII). */
function swapCase(s: string): string {
  return s.split('').map(c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')
}

/**
 * Mirror a position: swap colours and flip ranks. Tactics are preserved.
 * @param fen - FEN.
 * @returns the mirrored FEN.
 */
export function mirrorFen(fen: string): string {
  const [board = '', turn = 'w', castling = '-', ep = '-', half = '0', full = '1'] = fen.split(' ')
  const ranks = board.split('/').toReversed().map(swapCase)
  const castle = castling === '-' ? '-' : swapCase(castling).split('').toSorted((a, b) => 'KQkq'.indexOf(a) - 'KQkq'.indexOf(b)).join('')
  const passant = ep === '-' ? '-' : ep.replace(SQUARE, (_m, f: string, r: string) => `${f}${9 - Number(r)}`)
  return [ranks.join('/'), turn === 'w' ? 'b' : 'w', castle, passant, half, full].join(' ')
}

/**
 * Mirror a SAN move (ranks flipped; piece letters unchanged).
 * @param san - SAN.
 * @returns the mirrored SAN.
 */
export function mirrorSan(san: string): string {
  return san.replace(SQUARE, (_m, f: string, r: string) => `${f}${9 - Number(r)}`)
}

/** An enemy piece attacked by the moved piece after a move. */
export interface Target {
  readonly square: Square
  readonly piece: PieceSymbol
}

/**
 * Enemy pieces the moved piece attacks after the move (fork and double-attack facts).
 * @param fen - position before the move.
 * @param move - the move.
 * @returns attacked enemy pieces worth at least a knight, most valuable first.
 */
export function targetsAfter(fen: string, move: Move): Target[] {
  const chess = new Chess(fen)
  chess.move(move.san)
  const us: Color = move.color
  const out: Target[] = []
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell === null || cell.color === us || PIECE_VALUE[cell.type] < PIECE_VALUE.n) continue
      if (chess.attackers(cell.square, us).includes(move.to)) out.push({ square: cell.square, piece: cell.type })
    }
  }
  return out.toSorted((a, b) => PIECE_VALUE[b.piece] - PIECE_VALUE[a.piece])
}

/** File (0–7) of a square name. */
function file(square: string): number {
  return square.charCodeAt(0) - 97
}

/** Rank (0–7) of a square name. */
function rank(square: string): number {
  return Number(square[1]) - 1
}

/**
 * The first piece behind `target` on the line from the moved piece through
 * it (the piece a pin protects or a skewer wins).
 * @param fen - position before the move.
 * @param move - a line-piece move.
 * @param target - the attacked square.
 * @returns the piece behind, or null when there is none or no straight line.
 */
export function behind(fen: string, move: Move, target: Square): Target | null {
  const chess = new Chess(fen)
  chess.move(move.san)
  const df = Math.sign(file(target) - file(move.to))
  const dr = Math.sign(rank(target) - rank(move.to))
  const straight = file(target) === file(move.to) || rank(target) === rank(move.to) || Math.abs(file(target) - file(move.to)) === Math.abs(rank(target) - rank(move.to))
  if (!straight) return null
  let f = file(target) + df
  let r = rank(target) + dr
  while (f >= 0 && f < 8 && r >= 0 && r < 8) {
    const square = `${String.fromCharCode(97 + f)}${r + 1}`
    if (isSquare(square)) {
      const piece = chess.get(square)
      if (piece !== undefined) return piece.color === move.color ? null : { square, piece: piece.type }
    }
    f += df
    r += dr
  }
  return null
}

/**
 * Whether the moved piece can be captured on its new square with no recapture
 * (a common beginner error).
 * @param fen - position before the move.
 * @param move - the move.
 * @returns true when the piece is left hanging.
 */
export function leavesPieceHanging(fen: string, move: Move): boolean {
  const chess = new Chess(fen)
  chess.move(move.san)
  const them: Color = move.color === 'w' ? 'b' : 'w'
  if (!chess.isAttacked(move.to, them)) return false
  return !chess.isAttacked(move.to, move.color) && move.piece !== 'k'
}

/**
 * Pieces of `color`, for describing positions in text.
 * @param fen - position.
 * @param color - side.
 * @returns "knight d5, king g1" style list, most valuable first.
 */
export function pieceList(fen: string, color: Color): string {
  const chess = new Chess(fen)
  const pieces = chess.board().flat().filter((c): c is NonNullable<typeof c> => c !== null && c.color === color)
  return pieces.toSorted((a, b) => PIECE_VALUE[b.type] - PIECE_VALUE[a.type]).map(p => `${PIECE_NAME[p.type]} ${p.square}`).join(', ')
}

/**
 * A plain-text description of a position for learners without the board and for the tutor.
 * @param fen - position.
 * @returns text.
 */
export function describePosition(fen: string): string {
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black'
  return `${turn} to move. White: ${pieceList(fen, 'w')}. Black: ${pieceList(fen, 'b')}.`
}
