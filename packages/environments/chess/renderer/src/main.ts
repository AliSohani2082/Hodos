/**
 * The chess board renderer. It runs in the Hodos workspace's sandboxed
 * iframe (opaque origin, no network) and talks to the host only through the
 * port handed over by `connectRenderer`. chess.js limits input to legal
 * moves; the server grades every move again, so nothing here is trusted.
 *
 * Input: click a piece then a square, drag with a mouse, or use the keyboard
 * (arrow keys move over the grid, Enter or Space picks up and drops a piece,
 * Escape cancels).
 */
import type { Chess, PieceSymbol, Square } from 'chess.js'
import { connectRenderer, type RendererConnection } from '@hodos/plugin-sdk/renderer'
import type { Exercise, JsonValue, LessonNode } from '@hodos/plugin-sdk/protocol'
import {
  applyMove, chessOf, EMPTY_FEN, findMove, formatLine, GLYPH, isSquare, movesFrom, navigate, PIECE_NAME, positionOf,
  readDiagram, readPayload, readProgress, readReveal, sideToMove, squareAt, squareLabel, type Orientation, type Reveal,
} from './logic.js'

const PUZZLE_KIND = 'chess.puzzle'
const PROMOTIONS: readonly PieceSymbol[] = ['q', 'r', 'b', 'n']
const SVG_NS = 'http://www.w3.org/2000/svg'

interface State {
  mode: 'idle' | 'exercise' | 'diagram'
  exerciseId: string | null
  /** Moves can be entered (stepwise puzzles only). */
  interactive: boolean
  prompt: string
  /** Position the current attempt starts from. */
  initial: string
  /** Position the learner moves from now. */
  start: string
  /** Position shown. */
  fen: string
  orientation: Orientation
  locked: boolean
  /** A move was sent and neither progress nor a result has come back. */
  pending: boolean
  selected: Square | null
  focus: Square
  last: readonly [Square, Square] | null
  played: string[]
  arrows: ReadonlyArray<readonly [Square, Square]>
  highlights: readonly Square[]
  promotion: { from: Square; to: Square } | null
  outcome: 'correct' | 'incorrect' | null
  reveal: Reveal | null
  replaying: boolean
  status: string
}

const state: State = {
  mode: 'idle', exerciseId: null, interactive: false, prompt: '', initial: EMPTY_FEN, start: EMPTY_FEN, fen: EMPTY_FEN,
  orientation: 'white', locked: true, pending: false, selected: null, focus: 'e2', last: null, played: [], arrows: [],
  highlights: [], promotion: null, outcome: null, reveal: null, replaying: false, status: '',
}

let connection: RendererConnection | null = null
let builtFor: Orientation | null = null
let dragFrom: Square | null = null
let selectedOnPointerDown = false
let replayTimer: ReturnType<typeof setTimeout> | null = null
let promotionShown: string | null = null
const cells = new Map<Square, HTMLElement>()

function element<T extends Element>(id: string, type: abstract new () => T): T {
  const found = document.getElementById(id)
  if (!(found instanceof type)) throw new Error(`renderer markup is missing #${id}`)
  return found
}

const boardEl = element('board', HTMLDivElement)
const arrowsEl = element('arrows', SVGSVGElement)
const promptEl = element('prompt', HTMLParagraphElement)
const turnEl = element('turn', HTMLParagraphElement)
const statusEl = element('status', HTMLParagraphElement)
const historyEl = element('history', HTMLParagraphElement)
const promotionEl = element('promotion', HTMLDivElement)
const flipEl = element('flip', HTMLButtonElement)
const cancelEl = element('cancel', HTMLButtonElement)
const replayEl = element('replay', HTMLButtonElement)

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function stopReplay(): void {
  if (replayTimer !== null) clearTimeout(replayTimer)
  replayTimer = null
  state.replaying = false
}

/** Create the 64 cells in display order for the current orientation. */
function build(): void {
  const hadFocus = boardEl.contains(document.activeElement)
  boardEl.replaceChildren()
  cells.clear()
  for (let row = 0; row < 8; row += 1) {
    const rowEl = document.createElement('div')
    rowEl.setAttribute('role', 'row')
    rowEl.className = 'row'
    for (let col = 0; col < 8; col += 1) {
      const square = squareAt(row, col, state.orientation)
      const cell = document.createElement('div')
      cell.setAttribute('role', 'gridcell')
      cell.dataset.square = square
      cell.className = `cell ${(row + col) % 2 === 0 ? 'light' : 'dark'}`
      const piece = document.createElement('span')
      piece.className = 'piece'
      piece.setAttribute('aria-hidden', 'true')
      cell.append(piece)
      if (col === 0) cell.append(coordinate('rank', square[1] ?? ''))
      if (row === 7) cell.append(coordinate('file', square[0] ?? ''))
      rowEl.append(cell)
      cells.set(square, cell)
    }
    boardEl.append(rowEl)
  }
  builtFor = state.orientation
  if (hadFocus) cells.get(state.focus)?.focus()
}

function coordinate(kind: 'rank' | 'file', text: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = `coord ${kind}`
  span.setAttribute('aria-hidden', 'true')
  span.textContent = text
  return span
}

function checkedKing(chess: Chess): Square | null {
  if (!chess.inCheck()) return null
  const turn = chess.turn()
  for (const row of chess.board()) for (const p of row) if (p !== null && p.type === 'k' && p.color === turn) return p.square
  return null
}

function drawArrows(): void {
  arrowsEl.replaceChildren()
  const defs = document.createElementNS(SVG_NS, 'defs')
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', 'head')
  marker.setAttribute('viewBox', '0 0 4 4')
  marker.setAttribute('refX', '2.2')
  marker.setAttribute('refY', '2')
  marker.setAttribute('markerWidth', '3')
  marker.setAttribute('markerHeight', '3')
  marker.setAttribute('orient', 'auto-start-reverse')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M0,0 L4,2 L0,4 z')
  path.setAttribute('class', 'arrow-head')
  marker.append(path)
  defs.append(marker)
  arrowsEl.append(defs)
  for (const [from, to] of state.arrows) {
    const a = positionOf(from, state.orientation)
    const b = positionOf(to, state.orientation)
    const line = document.createElementNS(SVG_NS, 'line')
    const [x1, y1, x2, y2] = [a.col + 0.5, a.row + 0.5, b.col + 0.5, b.row + 0.5]
    // Stop short of the target centre so the head sits on the square.
    const length = Math.hypot(x2 - x1, y2 - y1)
    const shorten = length === 0 ? 0 : 0.3 / length
    line.setAttribute('x1', String(x1))
    line.setAttribute('y1', String(y1))
    line.setAttribute('x2', String(x2 - (x2 - x1) * shorten))
    line.setAttribute('y2', String(y2 - (y2 - y1) * shorten))
    line.setAttribute('class', 'arrow')
    line.setAttribute('marker-end', 'url(#head)')
    arrowsEl.append(line)
  }
}

function canMove(): boolean {
  return state.mode === 'exercise' && state.interactive && !state.locked && !state.pending && state.outcome === null && !state.replaying
}

/** Bring every cell, label and control up to date with the state. */
function paint(): void {
  if (builtFor !== state.orientation) build()
  let chess: Chess
  try {
    chess = chessOf(state.fen)
  } catch (_invalid) {
    chess = chessOf(EMPTY_FEN)
  }
  const targets = state.selected === null ? [] : movesFrom(state.fen, state.selected)
  const check = checkedKing(chess)
  for (const [square, cell] of cells) {
    const piece = chess.get(square)
    const target = targets.find(m => m.to === square)
    const flags = {
      selected: state.selected === square,
      target: target !== undefined,
      capture: target?.captured !== undefined,
      last: state.last !== null && (state.last[0] === square || state.last[1] === square),
      check: check === square,
      highlight: state.highlights.includes(square),
    }
    const glyph = cell.firstElementChild
    if (glyph !== null) {
      glyph.textContent = piece === undefined ? '' : GLYPH[piece.type]
      glyph.className = piece === undefined ? 'piece' : `piece ${piece.color === 'w' ? 'white' : 'black'}`
    }
    cell.classList.toggle('selected', flags.selected)
    cell.classList.toggle('target', flags.target && !flags.capture)
    cell.classList.toggle('capture', flags.capture)
    cell.classList.toggle('last', flags.last)
    cell.classList.toggle('check', flags.check)
    cell.classList.toggle('hl', flags.highlight)
    cell.setAttribute('aria-label', squareLabel(square, piece, flags))
    cell.setAttribute('aria-selected', String(flags.selected))
    cell.tabIndex = square === state.focus ? 0 : -1
  }
  drawArrows()
  boardEl.setAttribute('aria-disabled', String(!canMove()))
  boardEl.classList.toggle('locked', !canMove())
  boardEl.classList.toggle('correct', state.outcome === 'correct')
  boardEl.classList.toggle('incorrect', state.outcome === 'incorrect')
  promptEl.textContent = state.prompt
  promptEl.hidden = state.prompt === ''
  turnEl.textContent = state.mode === 'idle' ? '' : sideToMove(state.fen)
  statusEl.textContent = state.status
  historyEl.textContent = state.played.length === 0 ? '' : `Moves: ${formatLine(state.initial, state.played)}`
  historyEl.hidden = state.played.length === 0
  cancelEl.hidden = state.selected === null && state.promotion === null
  replayEl.hidden = state.reveal === null
  replayEl.disabled = state.replaying
  flipEl.hidden = state.mode === 'idle'
  paintPromotion()
}

function paintPromotion(): void {
  const key = state.promotion === null ? null : `${state.promotion.from}${state.promotion.to}`
  if (key === promotionShown) return
  promotionShown = key
  promotionEl.hidden = key === null
  promotionEl.replaceChildren()
  if (key === null) return
  const color = chessOf(state.fen).turn() === 'w' ? 'white' : 'black'
  const label = document.createElement('span')
  label.textContent = 'Promote to:'
  promotionEl.append(label)
  for (const type of PROMOTIONS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'promote'
    button.setAttribute('aria-label', PIECE_NAME[type])
    const glyph = document.createElement('span')
    glyph.className = `piece ${color}`
    glyph.setAttribute('aria-hidden', 'true')
    glyph.textContent = GLYPH[type]
    button.append(glyph)
    button.addEventListener('click', () => choosePromotion(type))
    promotionEl.append(button)
  }
  promotionEl.querySelector('button')?.focus()
}

function announce(text: string): void {
  state.status = text
}

function select(square: Square): boolean {
  const moves = movesFrom(state.fen, square)
  if (moves.length === 0) return false
  state.selected = square
  const piece = chessOf(state.fen).get(square)
  const name = piece === undefined ? 'piece' : PIECE_NAME[piece.type]
  announce(`${name.charAt(0).toUpperCase()}${name.slice(1)} on ${square} selected: ${moves.length} legal move${moves.length === 1 ? '' : 's'}.`)
  return true
}

/** Click, tap, Enter or Space on a square. */
function activate(square: Square): void {
  if (!canMove()) return
  state.focus = square
  if (state.promotion !== null) return
  const selected = state.selected
  if (selected === square) {
    state.selected = null
    announce('Selection cleared.')
  } else if (selected !== null && movesFrom(state.fen, selected).some(m => m.to === square)) {
    tryMove(selected, square)
  } else if (!select(square)) {
    if (selected !== null) announce(`No legal move to ${square}.`)
    else {
      const piece = chessOf(state.fen).get(square)
      announce(piece === undefined ? `${square} is empty.` : `That ${PIECE_NAME[piece.type]} cannot move now.`)
    }
  }
  paint()
}

function tryMove(from: Square, to: Square): void {
  const options = movesFrom(state.fen, from).filter(m => m.to === to)
  if (options.length === 0) return
  if (options.some(m => m.promotion !== undefined)) {
    state.promotion = { from, to }
    announce('Choose a piece to promote to.')
    return
  }
  commit(from, to)
}

function choosePromotion(type: PieceSymbol): void {
  const pending = state.promotion
  state.promotion = null
  if (pending !== null) commit(pending.from, pending.to, type)
  paint()
  cells.get(state.focus)?.focus()
}

function commit(from: Square, to: Square, promotion?: PieceSymbol): void {
  const exerciseId = state.exerciseId
  const result = applyMove(state.fen, promotion === undefined ? { from, to } : { from, to, promotion })
  if (result === null || exerciseId === null || connection === null) return
  state.fen = result.fen
  state.last = [from, to]
  state.played = [...state.played, result.move.san]
  state.selected = null
  state.pending = true
  state.focus = to
  announce(`You played ${result.move.san}.`)
  connection.respond(exerciseId, { move: result.move.san })
}

function cancel(): void {
  state.selected = null
  state.promotion = null
  announce('Selection cleared.')
  paint()
  cells.get(state.focus)?.focus()
}

/** Replay the released solution on the board. */
function replay(): void {
  const reveal = state.reveal
  if (reveal === null) return
  stopReplay()
  state.replaying = true
  state.selected = null
  state.fen = reveal.fen
  state.last = null
  announce(`Solution: ${formatLine(reveal.fen, reveal.line)}`)
  paint()
  let index = 0
  const step = (): void => {
    const san = reveal.line[index]
    const move = san === undefined ? null : findMove(state.fen, san)
    const after = move === null ? null : applyMove(state.fen, { from: move.from, to: move.to, ...(move.promotion === undefined ? {} : { promotion: move.promotion }) })
    if (move === null || after === null) {
      stopReplay()
      paint()
      return
    }
    state.fen = after.fen
    state.last = [move.from, move.to]
    index += 1
    if (index >= reveal.line.length) stopReplay()
    else replayTimer = setTimeout(step, reducedMotion() ? 0 : 900)
    paint()
  }
  replayTimer = setTimeout(step, reducedMotion() ? 0 : 600)
}

// ------------------------------------------------------------------ host messages

function present(exercise: Exercise): void {
  stopReplay()
  const payload = readPayload(exercise.payload)
  const progress = readProgress(exercise.progress)
  state.mode = 'exercise'
  state.exerciseId = exercise.id
  state.interactive = exercise.kind === PUZZLE_KIND
  state.prompt = payload.prompt
  state.initial = payload.fen
  state.start = progress?.fen ?? payload.fen
  state.fen = state.start
  state.played = progress === null ? [] : [...progress.played]
  state.last = progress === null ? null : lastMoveOf(payload.fen, progress.played)
  state.orientation = payload.orientation
  // A new exercise is answerable until the host locks it.
  state.locked = false
  state.pending = false
  state.selected = null
  state.promotion = null
  state.outcome = null
  state.reveal = null
  state.arrows = []
  state.highlights = []
  state.focus = state.orientation === 'white' ? 'e2' : 'e7'
  announce(state.interactive ? `${sideToMove(state.fen)}. Choose a piece, then its square.` : 'Look at the position, then choose your answer below the board.')
  paint()
}

/** The from/to squares of the last move of a line, by replaying it. */
function lastMoveOf(fen: string, line: readonly string[]): readonly [Square, Square] | null {
  let position = fen
  let last: readonly [Square, Square] | null = null
  for (const san of line) {
    const move = findMove(position, san)
    const after = move === null ? null : applyMove(position, { from: move.from, to: move.to, ...(move.promotion === undefined ? {} : { promotion: move.promotion }) })
    if (move === null || after === null) return last
    position = after.fen
    last = [move.from, move.to]
  }
  return last
}

function onProgress(exerciseId: string, progress: JsonValue, message?: string): void {
  if (exerciseId !== state.exerciseId) return
  const next = readProgress(progress)
  if (next === null) return
  state.start = next.fen
  state.fen = next.fen
  state.played = [...next.played]
  state.last = lastMoveOf(state.initial, next.played)
  state.pending = false
  state.outcome = null
  announce(message ?? 'Your move.')
  paint()
}

function onResult(exerciseId: string, correct: boolean, reveal: Reveal | null): void {
  if (exerciseId !== state.exerciseId) return
  state.pending = false
  state.outcome = correct ? 'correct' : 'incorrect'
  state.reveal = reveal
  state.selected = null
  announce(correct ? 'Correct!' : reveal === null ? 'Not quite.' : 'Not quite. You can replay the solution.')
  paint()
}

function onLock(locked: boolean): void {
  state.locked = locked
  if (!locked && state.mode === 'exercise') {
    if (state.outcome === 'incorrect' && state.reveal === null) {
      // Another attempt: it starts again from the puzzle position.
      state.start = state.initial
      state.fen = state.initial
      state.played = []
      state.last = null
      state.outcome = null
      announce('Try again from the start position.')
    } else if (state.pending) {
      // The move was not accepted (for example a network error): take it back.
      state.fen = state.start
      state.played = state.played.slice(0, -1)
      state.last = lastMoveOf(state.initial, state.played)
      state.pending = false
      announce('That move was not sent. Try again.')
    }
  }
  if (locked) state.selected = null
  paint()
}

function showDiagram(block: LessonNode): void {
  stopReplay()
  const diagram = readDiagram(block.attributes)
  state.mode = 'diagram'
  state.exerciseId = null
  state.interactive = false
  state.prompt = ''
  state.initial = diagram.fen
  state.start = diagram.fen
  state.fen = diagram.fen
  state.orientation = diagram.orientation
  state.arrows = diagram.arrows
  state.highlights = diagram.highlights
  state.played = []
  state.last = null
  state.outcome = null
  state.reveal = null
  state.selected = null
  state.locked = true
  announce('')
  paint()
}

function clear(): void {
  stopReplay()
  Object.assign(state, {
    mode: 'idle', exerciseId: null, interactive: false, prompt: '', initial: EMPTY_FEN, start: EMPTY_FEN, fen: EMPTY_FEN,
    pending: false, selected: null, last: null, played: [], arrows: [], highlights: [], promotion: null, outcome: null,
    reveal: null, status: '',
  } satisfies Partial<State>)
  paint()
}

// ------------------------------------------------------------------ input

function squareOf(target: EventTarget | null): Square | null {
  if (!(target instanceof Element)) return null
  const cell = target.closest<HTMLElement>('[data-square]')
  const square = cell?.dataset.square
  return square !== undefined && isSquare(square) ? square : null
}

boardEl.addEventListener('pointerdown', event => {
  const square = squareOf(event.target)
  dragFrom = null
  selectedOnPointerDown = false
  if (square === null || !canMove() || event.button !== 0) return
  if (state.selected !== square && movesFrom(state.fen, square).length > 0) {
    state.focus = square
    selectedOnPointerDown = select(square)
    paint()
  }
  if (state.selected === square) dragFrom = square
})

boardEl.addEventListener('pointerup', event => {
  const from = dragFrom
  dragFrom = null
  if (from === null || !canMove()) return
  // Touch pointers stay captured by the first cell, so look up the cell under the pointer.
  const square = squareOf(document.elementFromPoint(event.clientX, event.clientY))
  if (square === null || square === from) return
  selectedOnPointerDown = true
  if (movesFrom(state.fen, from).some(m => m.to === square)) {
    state.focus = square
    tryMove(from, square)
    paint()
  }
})

boardEl.addEventListener('click', event => {
  const square = squareOf(event.target)
  if (square === null) return
  if (selectedOnPointerDown) {
    // The pointerdown (or the drag) already handled this press.
    selectedOnPointerDown = false
    cells.get(square)?.focus()
    return
  }
  activate(square)
  cells.get(square)?.focus()
})

boardEl.addEventListener('keydown', event => {
  const square = squareOf(event.target) ?? state.focus
  const next = navigate(square, event.key, state.orientation)
  if (next !== null) {
    event.preventDefault()
    state.focus = next
    paint()
    cells.get(next)?.focus()
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activate(square)
    if (state.promotion === null) cells.get(state.focus)?.focus()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
})

promotionEl.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
})

flipEl.addEventListener('click', () => {
  state.orientation = state.orientation === 'white' ? 'black' : 'white'
  paint()
})
cancelEl.addEventListener('click', cancel)
replayEl.addEventListener('click', replay)

// ------------------------------------------------------------------ connection

void connectRenderer(window, {
  onInit: init => { document.documentElement.dataset.theme = init.colorScheme },
  onPresent: present,
  onProgress,
  onResult: result => onResult(result.exerciseId, result.correct, readReveal(result.reveal)),
  onBlock: showDiagram,
  onLock,
  onClear: clear,
}).then(conn => {
  connection = conn
  const report = (): void => conn.resize(Math.ceil(document.documentElement.scrollHeight))
  new ResizeObserver(report).observe(document.body)
  report()
})

paint()
