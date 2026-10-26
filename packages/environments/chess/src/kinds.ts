/**
 * Exercise kinds and the lesson block of the chess environment, with the
 * semantic item checks that keep invalid positions out of every course
 * (including agent-proposed ones).
 * @module @hodos/chess/kinds
 */
import { Chess } from 'chess.js'
import type { Diagnostic, ExerciseItem, ExerciseKindSpec, JsonObject, JsonValue, LessonBlockSpec, LessonNode } from '@hodos/plugin-sdk'
import { readKey, readPayload } from './grader.js'
import { behind, describePosition, parseMove, playLine, positionProblems, targetsAfter } from './position.js'

export const ENVIRONMENT = 'chess.board'
export const RENDERER_ID = 'chess-board'
export const GRADER_ID = 'chess.grader'

const FEN = { type: 'string', minLength: 15, maxLength: 120 } as const
const SQUARE = { type: 'string', pattern: '^[a-h][1-8]$' } as const

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function error(code: string, message: string): Diagnostic {
  return { severity: 'error', code, message }
}

/**
 * Semantic checks of a puzzle item: legal position, legal solution line, and
 * a key move that actually does what the goal and theme claim.
 * @param item - the item.
 * @returns findings.
 */
export function validatePuzzleItem(item: ExerciseItem): Diagnostic[] {
  const payload = readPayload(item.payload)
  const key = readKey(item.key)
  const problems = positionProblems(payload.fen).map(p => error(p.code, p.message))
  if (problems.length > 0) return problems
  if (key.line.length === 0) return [error('chess/no-solution', 'the solution line is empty')]
  if (playLine(payload.fen, key.line) === null) return [error('chess/illegal-line', 'the solution line contains an illegal move')]
  const out: Diagnostic[] = []
  const first = parseMove(payload.fen, key.line[0] ?? '')
  if (first === null) return [error('chess/illegal-line', 'the first solution move is illegal')]
  const after = new Chess(payload.fen)
  after.move(first.san)
  if (payload.plies !== Math.ceil(key.line.length / 2)) out.push(error('chess/plies', `payload.plies must be ${Math.ceil(key.line.length / 2)}`))
  if (payload.goal === 'mate' && !after.isCheckmate()) out.push(error('chess/not-mate', 'the key move is not checkmate'))
  if (payload.goal === 'check' && !after.inCheck()) out.push(error('chess/not-check', 'the key move does not give check'))
  if (payload.goal === 'capture') {
    if (first.captured === undefined) out.push(error('chess/not-capture', 'the key move is not a capture'))
    else if (after.isAttacked(first.to, after.turn())) out.push(error('chess/capture-defended', 'the captured piece is defended'))
  }
  if (payload.goal === 'best') {
    const targets = targetsAfter(payload.fen, first)
    if ((key.theme === 'fork' || key.theme === 'double-attack') && targets.length < 2) out.push(error('chess/not-double-attack', 'the key move does not attack two valuable pieces'))
    if (key.theme === 'pin' || key.theme === 'skewer') {
      const front = targets[0]
      if (front === undefined || behind(payload.fen, first, front.square) === null) out.push(error(`chess/not-${key.theme}`, `the key move does not create a ${key.theme}`))
    }
    if (leavesPieceHangingAfter(after, first.to)) out.push({ severity: 'warning', code: 'chess/key-hanging', message: 'the key move leaves the moved piece undefended and attacked; check the line' })
  }
  for (const alternative of key.alternatives ?? []) {
    if (parseMove(payload.fen, alternative) === null) out.push(error('chess/illegal-alternative', `alternative ${alternative} is illegal`))
  }
  return out
}

function leavesPieceHangingAfter(after: Chess, square: Parameters<Chess['isAttacked']>[0]): boolean {
  const mover = after.turn() === 'w' ? 'b' : 'w'
  return after.isAttacked(square, after.turn()) && !after.isAttacked(square, mover) && after.get(square)?.type !== 'k'
}

/** The stepwise puzzle kind: find the move (or line) on the board. */
export const puzzleKind: ExerciseKindSpec = {
  id: 'chess.puzzle',
  title: 'Chess puzzle',
  environment: ENVIRONMENT,
  responseKind: 'moves',
  interaction: 'stepwise',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['fen', 'orientation', 'prompt', 'goal', 'plies'],
    properties: {
      fen: FEN,
      orientation: { enum: ['white', 'black'] },
      prompt: { type: 'string', minLength: 1, maxLength: 300 },
      goal: { enum: ['best', 'mate', 'check', 'capture'] },
      plies: { type: 'integer', minimum: 1, maximum: 5 },
    },
  },
  keySchema: {
    type: 'object',
    additionalProperties: false,
    required: ['line', 'theme'],
    properties: {
      line: { type: 'array', minItems: 1, maxItems: 9, items: { type: 'string', minLength: 2, maxLength: 10 } },
      alternatives: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 2, maxLength: 10 } },
      theme: { enum: ['fork', 'double-attack', 'pin', 'skewer', 'mate', 'check', 'capture'] },
    },
  },
  responseSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['move'],
    properties: { move: { type: 'string', minLength: 1, maxLength: 12 } },
  },
  validateItem: validatePuzzleItem,
  fallbackText: payload => {
    const p = readPayload(payload)
    return `${p.prompt}\n${describePosition(p.fen)}\nAnswer with a move in standard notation (for example Nf3), or a move like g1f3.`
  },
  reveal: item => {
    const key = readKey(item.key)
    return { fen: readPayload(item.payload).fen, line: [...key.line] }
  },
}

/** The "spot the tactic" choice kind. */
export const identifyKind: ExerciseKindSpec = {
  id: 'chess.identify',
  title: 'Spot the tactic',
  environment: ENVIRONMENT,
  responseKind: 'choice',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: true, options: 4 },
  payloadSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['fen', 'orientation', 'prompt', 'options'],
    properties: {
      fen: FEN,
      orientation: { enum: ['white', 'black'] },
      prompt: { type: 'string', minLength: 1, maxLength: 300 },
      options: {
        type: 'array', minItems: 2, maxItems: 6,
        items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } },
      },
    },
  },
  keySchema: { type: 'object', additionalProperties: false, required: ['correct'], properties: { correct: { type: 'string' } } },
  responseSchema: { type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { type: 'string', maxLength: 32 } } },
  validateItem: item => {
    const payload = obj(item.payload)
    const problems = positionProblems(typeof payload.fen === 'string' ? payload.fen : '').map(p => error(p.code, p.message))
    const options = Array.isArray(payload.options) ? payload.options.map(o => obj(o).id) : []
    if (!options.includes(obj(item.key).correct ?? null)) problems.push(error('chess/identify-key', 'the correct option is not offered'))
    return problems
  },
  fallbackText: payload => {
    const p = obj(payload)
    const options = Array.isArray(p.options) ? p.options.map(o => `(${String(obj(o).id)}) ${String(obj(o).text)}`) : []
    return `${String(p.prompt)}\n${typeof p.fen === 'string' ? describePosition(p.fen) : ''}\n${options.join('\n')}`
  },
  reveal: item => ({ correct: obj(item.key).correct ?? null }),
}

/** The `chess-position` lesson block: a board diagram with optional arrows and highlights. */
export const positionBlock: LessonBlockSpec = {
  name: 'chess-position',
  version: 1,
  kind: 'leaf',
  attributes: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'fen'],
    properties: {
      id: { type: 'string' },
      fen: FEN,
      orientation: { enum: ['white', 'black'] },
      arrows: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^[a-h][1-8][a-h][1-8]$' } },
      highlights: { type: 'array', maxItems: 16, items: SQUARE },
      caption: { type: 'string', maxLength: 300 },
    },
  },
  guidance: {
    when: 'Show a chess position (a worked example or a pattern) inside a lesson.',
    syntax: '{% chess-position fen="r3k3/8/8/3N4/8/8/8/6K1 w - - 0 1" arrows=["d5c7"] caption="Nc7+ forks king and rook." /%}',
    rules: ['The FEN must be a legal position.', 'Arrows use from-to squares like "d5c7".', 'Do not reveal answers to the learner\'s current exercises.'],
  },
  validate: (node: LessonNode) => {
    const fen = node.attributes.fen
    return typeof fen === 'string' ? positionProblems(fen).map(p => ({ severity: 'error' as const, code: p.code, message: p.message })) : []
  },
  fallbackText: (node: LessonNode) => {
    const fen = typeof node.attributes.fen === 'string' ? node.attributes.fen : ''
    const caption = typeof node.attributes.caption === 'string' ? ` ${node.attributes.caption}` : ''
    return `[Chess position] ${fen === '' ? '' : describePosition(fen)}${caption}`
  },
  renderer: RENDERER_ID,
}
