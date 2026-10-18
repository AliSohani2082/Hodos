// Shared fixtures for the toy plugin: node/item/response cases. `expect` is hand-written for the cases that matter;
// the bench also diffs every mechanism against an in-process reference run of the same plugin.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const node = (id, fen, extra = {}) => ({ id, type: 'position', attrs: { fen, ...extra } })
const vctx = { courseId: 'course-1', locale: 'en' }

const mcq = (over = {}) => ({
  id: 'item-mcq-1', isomorphGroup: 'g1', kind: 'mcq',
  skills: [{ id: 'chess.fork', weight: 1, role: 'target' }],
  difficulty: { b: 0.2, source: 'llm', n: 0 }, modes: ['practice', 'checkpoint'],
  prompt: { text: 'Which squares does the knight fork?', choices: [{ id: 'a', text: 'e8 and a8' }, { id: 'b', text: 'd8 and b8' }, { id: 'c', text: 'none' }] },
  key: { correct: 'a' }, hints: [{ level: 1, text: 'Look at the knight.' }, { level: 2, text: 'Count the jumps.' }],
  distractors: [{ id: 'b', misconception: 'chess.misc.knight-straight', feedback: 'Knights never move along a line.' }],
  ...over,
})
const numeric = (over = {}) => ({
  id: 'item-num-1', isomorphGroup: 'g2', kind: 'numeric',
  skills: [{ id: 'math.pi', weight: 0.6, role: 'target' }, { id: 'math.round', weight: 0.4, role: 'prereq' }],
  difficulty: { b: -0.5, source: 'teacher', n: 12 }, modes: ['practice'],
  prompt: { text: 'Approximate pi to 2 dp.' }, key: { value: 3.14, tolerance: 0.01 }, hints: [], ...over,
})

/** An item whose payload is about `kb` kilobytes (long choice texts), to measure RPC cost against payload size. */
export function bigItem(kb) {
  const choices = Array.from({ length: Math.max(2, Math.floor((kb * 1024) / 200)) }, (_, i) => ({ id: 'c' + i, text: 'x'.repeat(190) }))
  return mcq({ id: 'item-big', prompt: { text: 'big', choices }, key: { correct: 'c1' } })
}

export const CASES = [
  { name: 'validate: start position', hook: 'block:position#validate', args: [node('n1', START), vctx], expect: [] },
  { name: 'validate: 5 fields', hook: 'block:position#validate', args: [node('n2', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'), vctx], expectIds: ['toy/fen-fields'] },
  { name: 'validate: two white kings, 9 white pawns (one on rank 8), 17 white pieces', hook: 'block:position#validate', args: [node('n3', 'rnbqkbnP/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBKR w KQkq - 0 1'), vctx], expectIds: ['toy/fen-pawn-rank', 'toy/fen-kings', 'toy/fen-pawns', 'toy/fen-pieces'] },
  { name: 'validate: bad orientation warns', hook: 'block:position#validate', args: [node('n4', START, { orientation: 'sideways' }), vctx], expectIds: ['toy/orientation'] },
  { name: 'validate: fen not a string', hook: 'block:position#validate', args: [node('n5', 42), vctx], expectIds: ['toy/fen-type'] },
  { name: 'fallback.text', hook: 'block:position#fallback.text', args: [node('n1', '8/8/8/8/8/8/8/k6K w - - 0 1')], expect: '[Chess position: 8/8/8/8/8/8/8/k6K w - - 0 1]' },
  { name: 'validateItem: good mcq', hook: 'exercise:toy-quiz#validateItem', args: [mcq()], expect: [] },
  { name: 'validateItem: mcq key not a choice', hook: 'exercise:toy-quiz#validateItem', args: [mcq({ key: { correct: 'z' } })], expectIds: ['toy/mcq-key'] },
  { name: 'validateItem: numeric negative tolerance', hook: 'exercise:toy-quiz#validateItem', args: [numeric({ key: { value: 1, tolerance: -1 } })], expectIds: ['toy/num-tol'] },
  { name: 'validateItem: hint order', hook: 'exercise:toy-quiz#validateItem', args: [mcq({ hints: [{ level: 2, text: 'a' }, { level: 1, text: 'b' }] })], expectIds: ['toy/hint-order'] },
  { name: 'grade: mcq correct', hook: 'exercise:toy-quiz#grade', args: [mcq(), { choice: 'a' }, { mode: 'practice', attempt: 1 }], expectScore: 1 },
  { name: 'grade: mcq wrong, misconception tagged', hook: 'exercise:toy-quiz#grade', args: [mcq(), { choice: 'b' }, { mode: 'checkpoint', attempt: 1 }], expectScore: 0, expectMisc: ['chess.misc.knight-straight'] },
  { name: 'grade: numeric within tolerance', hook: 'exercise:toy-quiz#grade', args: [numeric(), { value: '3.145' }, { mode: 'practice', attempt: 1 }], expectScore: 1 },
  { name: 'grade: numeric partial credit in practice', hook: 'exercise:toy-quiz#grade', args: [numeric(), { value: '3.17' }, { mode: 'practice', attempt: 1 }], expectScore: 0.5 },
  { name: 'grade: same answer earns 0 in checkpoint', hook: 'exercise:toy-quiz#grade', args: [numeric(), { value: '3.17' }, { mode: 'checkpoint', attempt: 1 }], expectScore: 0 },
  { name: 'grade: non-numeric response flags human review', hook: 'exercise:toy-quiz#grade', args: [numeric(), { value: 'abc' }, { mode: 'practice', attempt: 1 }], expectScore: 0, expectReview: true },
]
