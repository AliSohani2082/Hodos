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
  guidance: {
    when: 'The learner finds the move (or a short line) on the board.',
    rules: [
      'The FEN must be a legal position with the learner to move; `orientation` is the learner\'s colour.',
      '`goal`: `best` (judged by the solution line: learner move, opponent reply, learner move…), `mate` (any checkmate), `check` (any check) or `capture` (any capture of an undefended piece).',
      '`plies` is the number of learner moves in the line: ceil(line length / 2).',
      'For `best`, the key move must be clearly the strongest move (no other move nearly as good), and for fork or double-attack themes it must attack two valuable pieces. Hodos checks legality and the theme with chess.js; it cannot check that a line is the best one, so test lines with an engine if you can.',
      'Moves are SAN, e.g. `Nc7+`, `Qxe5`, `e8=Q`.',
      'The prompt must not name the solution or its squares.',
    ],
    example: {
      payload: { fen: '6k1/3q1p1p/8/8/4N3/8/5PPP/6K1 w - - 0 1', orientation: 'white', prompt: 'White to move and win material.', goal: 'best', plies: 2 },
      key: { line: ['Nf6+', 'Kf8', 'Nxd7'], theme: 'fork' },
      hints: [
        { level: 1, text: 'Look for a move that gives check and attacks something else.' },
        { level: 5, text: 'Nf6+ forks the king and the queen on d7; after the king moves, Nxd7.' },
      ],
    },
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
  guidance: {
    when: 'The learner names the tactic available in a position (recognition before calculation).',
    rules: [
      'The FEN must be a legal position; the key\'s `correct` must be one of the option ids.',
      'Offer 3-4 options; option texts must not hint at the answer.',
    ],
    example: {
      payload: {
        fen: '4k3/8/8/1q3r2/8/2N5/8/6K1 w - - 0 1', orientation: 'white', prompt: 'White to move. Which tactic wins material?',
        options: [{ id: 'fork', text: 'A fork' }, { id: 'pin', text: 'A pin' }, { id: 'skewer', text: 'A skewer' }, { id: 'mate', text: 'Mate in one' }],
      },
      key: { correct: 'fork' },
    },
  },
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
    syntax: '{% chess-position fen="4k3/8/8/1q3r2/8/2N5/8/6K1 w - - 0 1" arrows=["c3d4", "d4b5", "d4f5"] caption="Nd4 attacks the queen and the rook." /%}',
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
