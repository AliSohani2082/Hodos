/**
 * The chess tactics course: skill graph, lessons and exercise items built
 * from the verified puzzle set.
 * @module @hodos/chess/content
 */
import type { ContentPack, CourseSpec, ExerciseItem, ExerciseMode, LessonSpec } from '@hodos/plugin-sdk'
import { MISCONCEPTIONS } from './grader.js'
import { ENVIRONMENT } from './kinds.js'
import { expandPuzzles, explanationFor, hintsFor, keyFacts, promptFor, SKILL, type Puzzle, type PuzzleTheme } from './puzzles.js'

/** Puzzles that Stockfish confirmed (see `verification.ts`), by id. */
export type VerifiedSet = ReadonlySet<string>

function puzzleItem(p: Puzzle, engineVerified: VerifiedSet): ExerciseItem {
  const facts = keyFacts(p)
  return {
    id: p.id,
    kind: 'chess.puzzle',
    isomorphGroup: p.group,
    skills: [{ skillId: p.skill, weight: 1 }],
    difficulty: p.difficulty,
    modes: [...p.modes],
    expectedTimeSec: 60,
    payload: {
      fen: p.fen,
      orientation: facts.side === 'White' ? 'white' : 'black',
      prompt: promptFor(p),
      goal: p.goal,
      plies: Math.ceil(p.line.length / 2),
    },
    key: { line: [...p.line], ...(p.alternatives === undefined ? {} : { alternatives: [...p.alternatives] }), theme: p.theme },
    hints: hintsFor(p),
    explanation: explanationFor(p),
    misconceptionFeedback: { ...MISCONCEPTIONS },
    provenance: { source: 'authored', verifiedBy: ['chess.js', ...(engineVerified.has(p.id) ? ['stockfish'] : [])] },
  }
}

const IDENTIFY_OPTIONS = [
  { id: 'fork', text: 'A fork (one move attacks two pieces)' },
  { id: 'pin', text: 'A pin' },
  { id: 'skewer', text: 'A skewer' },
  { id: 'mate', text: 'Checkmate in one' },
]

function themeAnswer(theme: PuzzleTheme): string {
  return theme === 'double-attack' ? 'fork' : theme
}

function identifyItem(p: Puzzle, modes: readonly ExerciseMode[]): ExerciseItem {
  const facts = keyFacts(p)
  // Deterministic option order that differs between items.
  const shift = p.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % IDENTIFY_OPTIONS.length
  const options = IDENTIFY_OPTIONS.map((_, i) => IDENTIFY_OPTIONS[(i + shift) % IDENTIFY_OPTIONS.length] ?? IDENTIFY_OPTIONS[0])
  return {
    id: `spot-${p.id}`,
    kind: 'chess.identify',
    isomorphGroup: `spot-${p.group}`,
    skills: [{ skillId: SKILL.spot, weight: 1 }],
    difficulty: p.difficulty,
    modes: [...modes],
    format: { guessable: true, options: options.length },
    expectedTimeSec: 30,
    payload: {
      fen: p.fen,
      orientation: facts.side === 'White' ? 'white' : 'black',
      prompt: `${facts.side} to move. Which tactic wins here?`,
      options: options.flatMap(o => (o === undefined ? [] : [{ id: o.id, text: o.text }])),
    },
    key: { correct: themeAnswer(p.theme) },
    hints: [
      { level: 1, text: 'Find the strongest move first, then name what it does.' },
      { level: 2, text: `Look at the ${facts.piece} on ${facts.from}.` },
    ],
    explanation: `${explanationFor(p)} That is ${themeAnswer(p.theme) === 'mate' ? 'checkmate' : `a ${themeAnswer(p.theme)}`}.`,
    provenance: { source: 'authored', verifiedBy: ['chess.js'] },
  }
}

const LESSONS: readonly LessonSpec[] = [
  {
    id: 'chess-rules',
    skillId: SKILL.rules,
    title: 'Moves, captures and check',
    source: `# Moves, captures and check

Every tactic starts from two questions: **which enemy pieces can I attack**, and **is anything free to take?**

{% chess-position fen="4k3/8/8/8/8/8/8/3QK3 w - - 0 1" arrows=["d1h5"] caption="Qh5+ attacks the king along the diagonal: that is check." /%}

{% callout kind="key-idea" title="Free material" %}
A piece is *free* when you can capture it and nothing can capture back. Always look for free material before anything else — for both sides.
{% /callout %}

{% check question="Your rook can capture a knight that no enemy piece defends. What happens?" options=[{id: "a", text: "You win a knight for free"}, {id: "b", text: "You trade rook for knight"}, {id: "c", text: "Nothing changes"}] answer="a" explain="An undefended piece can be taken without losing anything in return." /%}
`,
  },
  {
    id: 'chess-knight-forks',
    skillId: SKILL.knightFork,
    title: 'Knight forks',
    source: `# Knight forks

A **fork** is one move that attacks two (or more) enemy pieces at once. Knights are the classic forking piece: they jump, so their attack cannot be blocked, and they attack up to eight squares.

{% chess-position fen="4k3/8/8/1q3r2/8/2N5/8/6K1 w - - 0 1" arrows=["c3d4", "d4b5", "d4f5"] caption="Nd4 attacks the queen on b5 and the rook on f5 at the same time." /%}

{% callout kind="key-idea" title="The royal fork" %}
A knight **check** that also attacks a rook or queen wins material: the king must move first, then the knight captures.
{% /callout %}

{% worked-example title="How to find a fork" %}
1. List the enemy king, queen and rooks (and undefended pieces).
2. Find a square your knight can reach that attacks two of them.
3. Make sure no enemy piece can simply capture the knight there.
{% /worked-example %}

{% check question="A knight on c7 attacks which of these pairs of squares?" options=[{id: "a", text: "a8 and e8"}, {id: "b", text: "c8 and d8"}, {id: "c", text: "b7 and d7"}] answer="a" explain="A knight moves two squares one way and one square sideways: from c7 it reaches a8, e8, a6, e6, b5 and d5." /%}
`,
  },
  {
    id: 'chess-double-attack',
    skillId: SKILL.doubleAttack,
    title: 'Double attacks with other pieces',
    source: `# Double attacks with other pieces

Queens, pawns and bishops fork too. A **double attack** gives the opponent two problems and time to solve only one.

{% chess-position fen="4k3/8/8/2n1n3/8/3P4/8/4K3 w - - 0 1" arrows=["d3d4", "d4c5", "d4e5"] caption="The pawn push d4 attacks both knights." /%}

{% callout kind="tip" title="Check first" %}
A double attack that includes **check** is the most forcing: the king must be dealt with before anything else.
{% /callout %}

{% check question="Why does a queen check that also attacks a loose rook win the rook?" options=[{id: "a", text: "The king must escape first, then the queen takes the rook"}, {id: "b", text: "Queens cannot be captured"}, {id: "c", text: "The rook is pinned"}] answer="a" explain="Check must be answered first, so the second threat is carried out on the next move." /%}
`,
  },
  {
    id: 'chess-pins',
    skillId: SKILL.pin,
    title: 'Pins',
    source: `# Pins

A **pin** attacks a piece that cannot move away without exposing a more valuable piece behind it — usually the king.

{% chess-position fen="4k3/3n4/8/1B6/8/8/8/4K3 w - - 0 1" highlights=["d7", "e8"] caption="The bishop on b5 pins the knight on d7 to the king on e8: the knight cannot move." /%}

{% callout kind="key-idea" title="Attack the pinned piece" %}
A piece pinned to the king is frozen. Attack it again, or let it capture along the pin line into your defended piece.
{% /callout %}

{% check question="A knight pinned to its king by a bishop…" options=[{id: "a", text: "cannot legally move"}, {id: "b", text: "can move but loses the king"}, {id: "c", text: "can capture the bishop"}] answer="a" explain="Moving a piece pinned to the king would expose the king to check, which is illegal." /%}
`,
  },
  {
    id: 'chess-skewers',
    skillId: SKILL.skewer,
    title: 'Skewers',
    source: `# Skewers

A **skewer** is a reversed pin: you attack a valuable piece in front, and when it moves out of the way, you capture the piece behind it.

{% chess-position fen="4k2q/8/8/8/8/8/8/R5K1 w - - 0 1" arrows=["a1a8"] caption="Ra8+ checks the king; when it steps off the rank, Rxh8 wins the queen." /%}

{% check question="In a skewer, the more valuable piece is…" options=[{id: "a", text: "in front"}, {id: "b", text: "behind"}] answer="a" explain="It must move away, exposing the piece behind it. In a pin the more valuable piece is behind." /%}
`,
  },
  {
    id: 'chess-mate-in-one',
    skillId: SKILL.mate,
    title: 'Mate in one',
    source: `# Mate in one

**Checkmate**: the king is in check and cannot escape, block or capture. Before every move, check every enemy king flight square.

{% chess-position fen="6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1" arrows=["e1e8"] caption="Re8# — the king's own pawns take away its escape squares: a back-rank mate." /%}

{% check question="What three ways can a king get out of check?" options=[{id: "a", text: "Move, block, capture"}, {id: "b", text: "Castle, move, resign"}, {id: "c", text: "Only by moving"}] answer="a" explain="If none of moving, blocking or capturing works, it is checkmate." /%}
`,
  },
  {
    id: 'chess-spot',
    skillId: SKILL.spot,
    title: 'Spot the tactic',
    source: `# Spot the tactic

Strong players name the pattern before they calculate. For each position ask: **is there a fork, a pin, a skewer, or a mate?**

{% step title="A quick scan" %}
Checks first, then captures, then threats — for both sides.
{% /step %}

{% check question="What should you look at first in a new position?" options=[{id: "a", text: "Checks, captures and threats"}, {id: "b", text: "Pawn structure"}, {id: "c", text: "The clock"}] answer="a" explain="Forcing moves decide most tactics, so scan them first." /%}
`,
  },
]

/**
 * Build the tactics course.
 * @param engineVerified - puzzle ids confirmed by Stockfish.
 * @returns the course.
 */
export function tacticsCourse(engineVerified: VerifiedSet = new Set()): CourseSpec {
  const puzzles = expandPuzzles()
  const byId = new Map(puzzles.map(p => [p.id, p]))
  const spotPractice = ['fork-royal-a8', 'pin-rook-queen-e', 'skewer-rank-rook', 'mate-back-rank-rook', 'fork-king-queen-e7', 'pin-bishop-queen', 'skewer-bishop-queen', 'mate-queen-bishop', 'double-queen-rook']
  const spotCheckpoint = ['fork-queen-e6', 'pin-long-diagonal', 'skewer-long-diagonal', 'mate-king-rook']
  const spot = (ids: readonly string[], modes: readonly ExerciseMode[]): ExerciseItem[] =>
    ids.flatMap(id => { const p = byId.get(id); return p === undefined ? [] : [identifyItem(p, modes)] })
  return {
    id: 'chess-tactics',
    version: '1.0.0',
    title: 'Chess tactics',
    description: 'Win material with forks, pins and skewers, and finish with mate in one. For players who know how the pieces move.',
    keywords: ['chess', 'tactics', 'tactic', 'fork', 'forks', 'knight', 'pin', 'pins', 'skewer', 'mate', 'checkmate', 'puzzles'],
    language: 'en',
    goal: SKILL.spot,
    environments: [ENVIRONMENT],
    preset: 'chess-tactics@1',
    skills: [
      { id: SKILL.rules, title: 'Moves, captures and check', kind: 'concept', environment: ENVIRONMENT, description: 'How pieces attack, what check is, and spotting free material.', objectives: ['Give check', 'Capture undefended pieces'] },
      { id: SKILL.knightFork, title: 'Knight forks', kind: 'pattern', environment: ENVIRONMENT, requires: [SKILL.rules], fluencyTargetSec: 90, description: 'One knight move that attacks two valuable pieces.', objectives: ['Find royal forks', 'Fork queen and rook'], confusableWith: [SKILL.doubleAttack] },
      { id: SKILL.doubleAttack, title: 'Double attacks', kind: 'pattern', environment: ENVIRONMENT, requires: [SKILL.knightFork], fluencyTargetSec: 90, description: 'Queen and pawn forks and double attacks with check.', confusableWith: [SKILL.knightFork] },
      { id: SKILL.pin, title: 'Pins', kind: 'pattern', environment: ENVIRONMENT, requires: [SKILL.rules], fluencyTargetSec: 90, description: 'Freezing a piece in front of its king.', confusableWith: [SKILL.skewer] },
      { id: SKILL.skewer, title: 'Skewers', kind: 'pattern', environment: ENVIRONMENT, requires: [SKILL.pin], fluencyTargetSec: 90, description: 'Attacking a valuable piece to win the one behind it.', confusableWith: [SKILL.pin] },
      { id: SKILL.mate, title: 'Mate in one', kind: 'pattern', environment: ENVIRONMENT, requires: [SKILL.rules], fluencyTargetSec: 90, description: 'Checks the king cannot escape.' },
      { id: SKILL.spot, title: 'Spot the tactic', kind: 'judgment', environment: ENVIRONMENT, requires: [SKILL.doubleAttack, SKILL.pin, SKILL.skewer, SKILL.mate], description: 'Name the winning pattern in a position.' },
    ],
    lessons: LESSONS,
    items: [
      ...puzzles.map(p => puzzleItem(p, engineVerified)),
      ...spot(spotPractice, ['practice', 'review']),
      ...spot(spotCheckpoint, ['checkpoint']),
    ],
  }
}

/**
 * The content pack registered by the plugin.
 * @param engineVerified - puzzle ids confirmed by Stockfish.
 * @returns the pack.
 */
export function chessPack(engineVerified: VerifiedSet = new Set()): ContentPack {
  return { id: 'chess-tactics', version: '1.0.0', title: 'Chess tactics', courses: [tacticsCourse(engineVerified)] }
}
