// Toy plugin server entry (spike b). Single self-contained ES module: no imports, no Node/Bun globals.
// The same file runs (1) in-process under cordis, (2) in a plain worker process, (3) inside QuickJS,
// isolated-vm and workerd. Everything a hook receives and returns is JSON.

export const name = 'ali38-toy-quiz'
// cordis 4 refuses `ctx.lesson` unless the plugin declares it; the internal adapter will add this for SDK plugins.
export const inject = ['lesson', 'exercise', 'pedagogy']

const PIECES = 'pnbrqkPNBRQK'

// --- block `position`: validate + fallback.text (mirrors the chess example in lesson-ir.md section 4) ---
function validatePosition(node) {
  const out = []
  const err = (id, message) => out.push({ level: 'error', id, message, nodeId: node.id })
  const fen = node.attrs && node.attrs.fen
  if (typeof fen !== 'string') { err('toy/fen-type', 'fen must be a string'); return out }
  const parts = fen.trim().split(/\s+/)
  if (parts.length !== 6) { err('toy/fen-fields', 'FEN needs 6 fields, got ' + parts.length); return out }
  const [board, side, castling, ep, half, full] = parts
  const ranks = board.split('/')
  if (ranks.length !== 8) err('toy/fen-ranks', 'board needs 8 ranks, got ' + ranks.length)
  const count = {}
  ranks.forEach((rank, i) => {
    let width = 0
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') width += Number(ch)
      else if (PIECES.includes(ch)) {
        width += 1
        count[ch] = (count[ch] || 0) + 1
        if ((ch === 'p' || ch === 'P') && (i === 0 || i === 7)) err('toy/fen-pawn-rank', 'pawn on rank ' + (8 - i))
      } else err('toy/fen-char', 'bad character ' + JSON.stringify(ch))
    }
    if (width !== 8) err('toy/fen-width', 'rank ' + (8 - i) + ' has width ' + width)
  })
  if (count.K !== 1 || count.k !== 1) err('toy/fen-kings', 'need exactly one king per side')
  if ((count.P || 0) > 8 || (count.p || 0) > 8) err('toy/fen-pawns', 'more than 8 pawns')
  const total = (c) => [...c].reduce((n, ch) => n + (count[ch] || 0), 0)
  if (total('PNBRQK') > 16 || total('pnbrqk') > 16) err('toy/fen-pieces', 'more than 16 pieces')
  if (side !== 'w' && side !== 'b') err('toy/fen-side', 'side to move must be w or b')
  if (!/^(-|K?Q?k?q?)$/.test(castling) || castling === '') err('toy/fen-castling', 'bad castling field')
  if (!/^(-|[a-h][36])$/.test(ep)) err('toy/fen-ep', 'bad en passant square')
  if (!/^\d+$/.test(half) || !/^[1-9]\d*$/.test(full)) err('toy/fen-clock', 'bad move counters')
  const orientation = node.attrs.orientation
  if (orientation !== undefined && orientation !== 'white' && orientation !== 'black')
    out.push({ level: 'warning', id: 'toy/orientation', message: 'orientation should be white or black', nodeId: node.id })
  return out
}

// --- exercise kind `toy-quiz`: validateItem + grade (mirrors intelligent-tutoring.md section 6) ---
function validateItem(item) {
  const out = []
  const err = (id, message) => out.push({ level: 'error', id, message, nodeId: item && item.id })
  if (!item || typeof item.id !== 'string' || !item.id) { err('toy/item-id', 'item.id required'); return out }
  if (item.kind !== 'mcq' && item.kind !== 'numeric') { err('toy/item-kind', 'unsupported kind ' + item.kind); return out }
  if (!Array.isArray(item.skills) || item.skills.length === 0) err('toy/item-skills', 'at least one skill required')
  else if (!item.skills.some((s) => s.role === 'target')) err('toy/item-target', 'one skill must be the target')
  else if (item.skills.some((s) => !(s.weight > 0 && s.weight <= 1))) err('toy/item-weight', 'skill weights must be in (0, 1]')
  if (!item.difficulty || !(item.difficulty.b >= -4 && item.difficulty.b <= 4)) err('toy/item-difficulty', 'difficulty.b must be in [-4, 4]')
  const key = item.key
  if (!key || typeof key !== 'object') { err('toy/item-key', 'key required'); return out }
  if (item.kind === 'mcq') {
    const choices = (item.prompt && item.prompt.choices) || []
    const ids = new Set(choices.map((c) => c.id))
    if (choices.length < 2 || choices.length > 6) err('toy/mcq-choices', 'mcq needs 2 to 6 choices')
    if (ids.size !== choices.length) err('toy/mcq-dup', 'choice ids must be unique')
    if (!ids.has(key.correct)) err('toy/mcq-key', 'key.correct is not a choice id')
  } else {
    if (typeof key.value !== 'number' || !Number.isFinite(key.value)) err('toy/num-key', 'key.value must be a finite number')
    if (typeof key.tolerance !== 'number' || key.tolerance < 0) err('toy/num-tol', 'key.tolerance must be >= 0')
  }
  const levels = (item.hints || []).map((h) => h.level)
  if (levels.some((l, i) => i > 0 && l <= levels[i - 1])) err('toy/hint-order', 'hint levels must strictly increase')
  return out
}

async function grade(item, response, ctx) {
  await Promise.resolve() // grade() is async in the contract: exercises the microtask path in every runtime
  const base = { misconceptionsDetected: [], graderConfidence: 1, needsHumanReview: false }
  if (item.kind === 'mcq') {
    const picked = response && response.choice
    const ok = picked === item.key.correct
    const d = (item.distractors || []).find((x) => x.id === picked)
    return {
      ...base, score: ok ? 1 : 0, correct: ok,
      misconceptionsDetected: !ok && d && d.misconception ? [d.misconception] : [],
      feedback: { text: ok ? 'Correct.' : (d && d.feedback) || 'Not quite.', revealsAnswer: false },
    }
  }
  const v = Number(response && response.value)
  if (!Number.isFinite(v)) return { ...base, score: 0, correct: false, graderConfidence: 0.5, needsHumanReview: true, feedback: { text: 'Enter a number.', revealsAnswer: false } }
  const err = Math.abs(v - item.key.value)
  const tol = item.key.tolerance
  const ok = err <= tol
  const partial = !ok && err <= 5 * tol && ctx.mode !== 'checkpoint'
  return {
    ...base, score: ok ? 1 : partial ? 0.5 : 0, correct: ok,
    oracle: { error: err },
    feedback: { text: ok ? 'Correct.' : partial ? 'Close.' : 'Check your working.', revealsAnswer: false },
  }
}

export function apply(ctx) {
  ctx.lesson.layout({
    name: 'toy-reader', guidance: 'Linear prose with inline positions.', accepts: ['position'],
    renderer: { entry: 'ui/layout.js', trust: 'sandboxed' },
  })
  ctx.lesson.block({
    name: 'position', version: 1, kind: 'leaf', body: 'none',
    attrs: { type: 'object', required: ['fen'], properties: { fen: { type: 'string' }, orientation: { enum: ['white', 'black'] } } },
    guidance: { when: 'A concrete position the learner should look at.', syntax: '{% position fen="..." /%}', rules: ['FEN must be legal'] },
    validate: validatePosition,
    fallback: { mode: 'text', text: (n) => '[Chess position: ' + n.attrs.fen + ']' },
    renderer: { entry: 'ui/board.js', trust: 'sandboxed', capabilities: ['event:answer'] },
  })
  ctx.exercise.kind({
    name: 'toy-quiz', version: 1, kinds: ['mcq', 'numeric'], responseKind: 'structured', grader: 'deterministic',
    supports: { steps: false, hints: true, partialCredit: true, timed: false, variants: true },
    itemSchema: { type: 'object' }, validateItem, grade, ui: { entry: 'ui/quiz.js', trust: 'sandboxed' },
  })
  ctx.pedagogy.preset({ name: 'toy-drill', version: 1, data: { loop: 'drill', gate: 0.95, hintsMax: 3 } })
}
