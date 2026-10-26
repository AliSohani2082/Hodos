/**
 * DOM-free logic of the chess board renderer: reading host data, board
 * geometry for both orientations, keyboard navigation and move notation.
 * Everything read from the host is re-checked here; a malformed payload
 * produces an empty board, never an exception.
 * @module @hodos/chess/renderer/logic
 */
import { Chess, validateFen, type Move, type PieceSymbol, type Square } from 'chess.js'
import type { JsonValue } from '@hodos/plugin-sdk/protocol'

export type Orientation = 'white' | 'black'

export const FILES = 'abcdefgh'
export const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1'

export const PIECE_NAME: Readonly<Record<PieceSymbol, string>> = {
  k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn',
}

/** Filled glyphs for both colours (coloured by CSS), with text presentation forced. */
export const GLYPH: Readonly<Record<PieceSymbol, string>> = {
  k: '♚︎', q: '♛︎', r: '♜︎', b: '♝︎', n: '♞︎', p: '♟︎',
}

/** What the renderer shows for one exercise. */
export interface BoardPayload {
  readonly fen: string
  readonly orientation: Orientation
  readonly prompt: string
}

/** Server-held progress of a stepwise puzzle. */
export interface BoardProgress {
  readonly fen: string
  readonly played: readonly string[]
}

/** A lesson diagram. */
export interface Diagram {
  readonly fen: string
  readonly orientation: Orientation
  readonly arrows: ReadonlyArray<readonly [Square, Square]>
  readonly highlights: readonly Square[]
}

/** Released solution of a puzzle. */
export interface Reveal {
  readonly fen: string
  readonly line: readonly string[]
}

function obj(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined, max = 300): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function strings(value: JsonValue | undefined, max = 64): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, max) : []
}

/** Whether a string is a board square. */
export function isSquare(value: string): value is Square {
  return /^[a-h][1-8]$/.test(value)
}

/** A FEN chess.js accepts, or the empty board. */
export function safeFen(value: JsonValue | undefined): string {
  const fen = str(value, 120).trim()
  return fen !== '' && validateFen(fen).ok ? fen : EMPTY_FEN
}

function orientationOf(value: JsonValue | undefined, fen: string): Orientation {
  if (value === 'white' || value === 'black') return value
  return fen.split(' ')[1] === 'b' ? 'black' : 'white'
}

/** Read an exercise payload (puzzle or identify kind). */
export function readPayload(payload: JsonValue): BoardPayload {
  const p = obj(payload)
  const fen = safeFen(p.fen)
  return { fen, orientation: orientationOf(p.orientation, fen), prompt: str(p.prompt) }
}

/** Read stepwise progress, or null when there is none. */
export function readProgress(progress: JsonValue | undefined): BoardProgress | null {
  const p = obj(progress)
  if (typeof p.fen !== 'string') return null
  const fen = safeFen(p.fen)
  return fen === EMPTY_FEN ? null : { fen, played: strings(p.played, 16) }
}

/** Read a `chess-position` lesson block's attributes. */
export function readDiagram(attributes: JsonValue): Diagram {
  const a = obj(attributes)
  const fen = safeFen(a.fen)
  const arrows = strings(a.arrows, 8).flatMap(s => {
    const from = s.slice(0, 2)
    const to = s.slice(2, 4)
    return s.length === 4 && isSquare(from) && isSquare(to) ? [[from, to] as const] : []
  })
  return { fen, orientation: orientationOf(a.orientation, fen), arrows, highlights: strings(a.highlights, 16).filter(isSquare) }
}

/** Read a released solution, or null. */
export function readReveal(reveal: JsonValue | undefined): Reveal | null {
  const r = obj(reveal)
  const line = strings(r.line, 16)
  if (typeof r.fen !== 'string' || line.length === 0) return null
  const fen = safeFen(r.fen)
  return fen === EMPTY_FEN ? null : { fen, line }
}

/**
 * The square shown at a display position.
 * @param row - 0 is the top row on screen.
 * @param col - 0 is the left column on screen.
 * @param orientation - the side shown at the bottom.
 */
export function squareAt(row: number, col: number, orientation: Orientation): Square {
  const file = orientation === 'white' ? col : 7 - col
  const rank = orientation === 'white' ? 8 - row : row + 1
  return `${FILES[file]}${rank}` as Square
}

/** Display position (row, col) of a square. */
export function positionOf(square: Square, orientation: Orientation): { row: number; col: number } {
  const file = FILES.indexOf(square[0] ?? 'a')
  const rank = Number(square[1])
  return orientation === 'white' ? { row: 8 - rank, col: file } : { row: rank - 1, col: 7 - file }
}

/**
 * Keyboard navigation in screen terms: ArrowUp always moves up the screen,
 * whichever side is at the bottom.
 * @returns the next focused square, or null for keys that do not navigate.
 */
export function navigate(square: Square, key: string, orientation: Orientation): Square | null {
  const { row, col } = positionOf(square, orientation)
  const clamp = (n: number): number => Math.min(7, Math.max(0, n))
  switch (key) {
    case 'ArrowUp': return squareAt(clamp(row - 1), col, orientation)
    case 'ArrowDown': return squareAt(clamp(row + 1), col, orientation)
    case 'ArrowLeft': return squareAt(row, clamp(col - 1), orientation)
    case 'ArrowRight': return squareAt(row, clamp(col + 1), orientation)
    case 'Home': return squareAt(row, 0, orientation)
    case 'End': return squareAt(row, 7, orientation)
    case 'PageUp': return squareAt(0, col, orientation)
    case 'PageDown': return squareAt(7, col, orientation)
    default: return null
  }
}

/** A chess.js position; the empty board (shown while idle) skips validation. */
export function chessOf(fen: string): Chess {
  return fen === EMPTY_FEN ? new Chess(EMPTY_FEN, { skipValidation: true }) : new Chess(fen)
}

/** Legal moves from a square for the side to move. */
export function movesFrom(fen: string, square: Square): Move[] {
  try {
    return chessOf(fen).moves({ square, verbose: true })
  } catch (_invalid) {
    return []
  }
}

function bare(san: string): string {
  return san.replace(/[+#!?]+$/u, '')
}

/** Find a legal move by SAN (check marks optional), or null. */
export function findMove(fen: string, san: string): Move | null {
  try {
    return chessOf(fen).moves({ verbose: true }).find(m => bare(m.san) === bare(san)) ?? null
  } catch (_invalid) {
    return null
  }
}

/** The position after a move, or null if it is illegal. */
export function applyMove(fen: string, move: { from: Square; to: Square; promotion?: PieceSymbol }): { fen: string; move: Move } | null {
  try {
    const chess = chessOf(fen)
    const played = chess.move(move)
    return { fen: chess.fen(), move: played }
  } catch (_illegal) {
    return null
  }
}

/**
 * Number a line of SAN moves from a starting position:
 * `1. Nc7+ Kd7 2. Nxa8`, or `1... Nc2+ 2. Kd2` when Black starts.
 */
export function formatLine(fen: string, sans: readonly string[]): string {
  const parts = fen.split(' ')
  let number = Number(parts[5] ?? '1')
  if (!Number.isInteger(number) || number < 1) number = 1
  let white = parts[1] !== 'b'
  const out: string[] = []
  sans.forEach((san, i) => {
    if (white) out.push(`${number}. ${san}`)
    else {
      out.push(i === 0 ? `${number}... ${san}` : san)
      number += 1
    }
    white = !white
  })
  return out.join(' ')
}

/** Accessible name of a square. */
export function squareLabel(square: Square, piece: { type: PieceSymbol; color: 'w' | 'b' } | undefined, flags: { selected?: boolean; target?: boolean; capture?: boolean; last?: boolean; check?: boolean; highlight?: boolean }): string {
  const parts = [square, piece === undefined ? 'empty' : `${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAME[piece.type]}`]
  if (flags.selected === true) parts.push('selected')
  if (flags.target === true) parts.push(flags.capture === true ? 'legal capture' : 'legal move')
  if (flags.check === true) parts.push('in check')
  if (flags.last === true) parts.push('last move')
  if (flags.highlight === true) parts.push('highlighted')
  return parts.join(', ')
}

/** "White to move" / "Black to move". */
export function sideToMove(fen: string): string {
  return fen.split(' ')[1] === 'b' ? 'Black to move' : 'White to move'
}
