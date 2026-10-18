// The 36 tasks (§8.3): 30 base = 6 domains x 5 lesson shapes, plus 6 adversarial. Source packs are real
// Wikipedia text (fixtures/packs), built by scripts/build-packs.ts. Checklists are the gold standard for scoring.
import { readFileSync } from 'node:fs'
import type { ChecklistItem, DomainId, LiteralCheck, ShapeId, SourcePack, Task, ValidationContext } from './types.ts'

export function loadPack(id: string): SourcePack {
  return JSON.parse(readFileSync(new URL(`../fixtures/packs/${id}.json`, import.meta.url), 'utf8'))
}

const CORE = ['cite', 'perspective', 'callout', 'term']
type Visual = 'position' | 'plot' | 'animation' | 'timeline'

const DOMAIN: Record<DomainId, { level: string; layout: string; visual: Visual }> = {
  math: { level: 'high-school student, comfortable with arithmetic', layout: 'lecture: single column, formulas inline', visual: 'plot' },
  programming: { level: 'first-year university student who has written a few programs', layout: 'notebook: prose with short code samples', visual: 'animation' },
  chess: { level: 'club player rated about 1200', layout: 'board-first: a position leads each section', visual: 'position' },
  language: { level: 'adult beginner (A1 to A2)', layout: 'phrasebook: short sections with drills', visual: 'animation' },
  history: { level: 'undergraduate in a history survey course', layout: 'seminar reader: sources in conversation', visual: 'timeline' },
  science: { level: 'first-year college student', layout: 'lecture with figures', visual: 'plot' },
}

/** Domain, shape, human concept, dotted concept id. Order within a domain = S1..S5. */
const BASE: [DomainId, string, string][] = [
  ['math', 'The Pythagorean theorem', 'math.geometry.pythagorean-theorem'],
  ['math', 'Derivatives as slope', 'math.calculus.derivative-slope'],
  ['math', 'Prime numbers', 'math.number-theory.prime-numbers'],
  ['math', 'Solving linear equations', 'math.algebra.linear-equations'],
  ['math', "Bayes' theorem", 'math.probability.bayes-theorem'],
  ['programming', 'Recursion', 'cs.fundamentals.recursion'],
  ['programming', 'Binary search', 'cs.algorithms.binary-search'],
  ['programming', 'Hash tables', 'cs.data-structures.hash-tables'],
  ['programming', 'Big O notation', 'cs.analysis.big-o'],
  ['programming', 'Stacks and queues', 'cs.data-structures.stacks-queues'],
  ['chess', 'Pins and skewers', 'chess.tactics.pin-skewer'],
  ['chess', 'The knight fork', 'chess.tactics.fork.knight'],
  ['chess', 'Opening principles', 'chess.strategy.opening-principles'],
  ['chess', 'Checkmate patterns', 'chess.tactics.checkmate-patterns'],
  ['chess', 'Basic endgame principles', 'chess.endgame.principles'],
  ['language', 'Ser and estar in Spanish', 'es.grammar.ser-estar'],
  ['language', 'Japanese writing systems', 'ja.writing.scripts'],
  ['language', 'German grammatical cases', 'de.grammar.cases'],
  ['language', 'Grammatical gender in French', 'fr.grammar.gender'],
  ['language', 'Tones in Mandarin', 'zh.phonology.tones'],
  ['history', 'Causes of the First World War', 'history.modern.ww1-causes'],
  ['history', 'The fall of the Western Roman Empire', 'history.ancient.rome-fall'],
  ['history', 'The Industrial Revolution', 'history.modern.industrial-revolution'],
  ['history', 'The atomic bombings of Japan', 'history.modern.atomic-bombings'],
  ['history', 'The French Revolution', 'history.modern.french-revolution'],
  ['science', 'Photosynthesis', 'bio.metabolism.photosynthesis'],
  ['science', 'Half-life and radioactive decay', 'phys.nuclear.half-life'],
  ['science', 'Plate tectonics', 'geo.tectonics.plate-tectonics'],
  ['science', 'Natural selection', 'bio.evolution.natural-selection'],
  ['science', 'The greenhouse effect', 'earth.climate.greenhouse-effect'],
]

const SHAPE_WORDS: Record<string, number> = { S1: 500, S2: 600, S3: 600, S4: 700, S5: 1500 }

function shapeSpec(shape: ShapeId, visual: Visual): { allowed: string[]; checklist: ChecklistItem[] } {
  const exerciseNote =
    'full envelope: kind mcq with 4 choices (one correct, a misconception id on each wrong one), hints at levels 1 to 5, and at least 2 steps'
  switch (shape) {
    case 'S1':
      return { allowed: CORE, checklist: [{ block: 'perspective', min: 2 }, { block: 'cite', min: 4 }] }
    case 'S2':
      return { allowed: [...CORE, visual], checklist: [{ block: 'perspective', min: 2 }, { block: 'cite', min: 4 }, { block: visual, min: 1 }] }
    case 'S3':
      return {
        allowed: [...CORE, 'exercise'],
        checklist: [{ block: 'perspective', min: 2 }, { block: 'cite', min: 4 }, { block: 'exercise', min: 1, note: exerciseNote }],
      }
    case 'S4':
      return {
        allowed: [...CORE, 'worked-example', 'step', 'exercise'],
        checklist: [
          { block: 'worked-example', min: 1, note: 'at least 3 steps' },
          { block: 'exercise', min: 1, note: 'a faded exercise: scaffold faded, with steps that continue the worked example' },
          { block: 'cite', min: 3 },
          { block: 'perspective', min: 1 },
        ],
      }
    default:
      return {
        allowed: [...CORE, visual, 'worked-example', 'step', 'exercise'],
        checklist: [
          { block: 'cite', min: 5 }, { block: 'perspective', min: 2 }, { block: 'callout', min: 1 }, { block: 'term', min: 2 },
          { block: visual, min: 1 }, { block: 'worked-example', min: 1 }, { block: 'exercise', min: 2 },
        ],
      }
  }
}

const baseTasks: Task[] = BASE.map(([domain, concept, concept_id], i) => {
  const shape = (['S1', 'S2', 'S3', 'S4', 'S5'] as const)[i % 5]!
  const d = DOMAIN[domain]
  const pack = loadPack(`${domain}-s${(i % 5) + 1}`)
  const { allowed, checklist } = shapeSpec(shape, d.visual)
  return {
    id: `${domain}-s${(i % 5) + 1}`, domain, shape, concept, concept_id, level: d.level, layout: d.layout,
    allowed, pack: pack.id, chunkIds: pack.chunks.map((c) => c.id), checklist, targetWords: SHAPE_WORDS[shape]!, brief: '',
  }
})

function adv(n: number, domain: DomainId, concept: string, concept_id: string, over: Partial<Task> & Pick<Task, 'allowed' | 'checklist' | 'brief'>): Task {
  const pack = loadPack(`adv${n}`)
  const d = DOMAIN[domain]
  return {
    id: `adv${n}`, domain, shape: `ADV${n}` as ShapeId, concept, concept_id, level: d.level, layout: d.layout,
    pack: pack.id, chunkIds: pack.chunks.map((c) => c.id), targetWords: 600, ...over,
  }
}

const lit = (l: LiteralCheck) => l

const advTasks: Task[] = [
  adv(1, 'programming', 'Template syntax and delimiters', 'cs.web.template-syntax', {
    allowed: CORE,
    checklist: [{ block: 'perspective', min: 2 }, { block: 'cite', min: 4 }],
    literals: [
      lit({ where: 'code', value: '{% if user %}Hello{% endif %}' }),
      lit({ where: 'code', value: ':::note' }),
      lit({ where: 'code', value: '{% raw %}' }),
    ],
    brief:
      'Include (1) a fenced code sample in Jinja syntax containing exactly `{% if user %}Hello{% endif %}`, (2) a fenced code sample of a Docusaurus admonition that starts with `:::note` and ends with `:::`, and (3) an inline code mention of `{% raw %}`. These are examples of other tools\' syntax, shown as code.',
  }),
  adv(2, 'math', 'Taylor series and notation', 'math.analysis.taylor-series', {
    allowed: CORE,
    checklist: [{ block: 'perspective', min: 2 }, { block: 'cite', min: 4 }],
    literals: [
      lit({ where: 'text', value: 'f: \\mathbb{R} \\to \\mathbb{R}' }),
      lit({ where: 'text', value: 'a_{n+1} = \\frac{a_n}{2}' }),
      lit({ where: 'text', value: '\\sum_{k=0}^{\\infty}' }),
      lit({ where: 'text', value: '3:1' }),
    ],
    brief:
      'Write the maths in LaTeX and include these formulas exactly as written: `f: \\mathbb{R} \\to \\mathbb{R}`, `a_{n+1} = \\frac{a_n}{2}` and `\\sum_{k=0}^{\\infty}`, each between dollar signs in running text. Also mention that the ratio of two consecutive terms is 3:1 in the geometric example, written as 3:1.',
  }),
  adv(3, 'language', 'Hiragana with awkward glosses', 'ja.writing.hiragana-glosses', {
    allowed: CORE,
    checklist: [{ block: 'term', min: 3 }, { block: 'cite', min: 3 }, { block: 'perspective', min: 2 }],
    literals: [
      lit({ where: 'attr', block: 'term', attr: 'gloss', value: 'The verb 読む ("to read") — pronounced yomu' }),
      lit({ where: 'attr', block: 'term', attr: 'gloss', value: 'Windows path C:\\Users\\ひらがな\\notes.txt' }),
      lit({ where: 'attr', block: 'term', attr: 'gloss', value: 'He said "ありがとう" — "thank you"' }),
    ],
    brief:
      'Use three term blocks whose gloss values are exactly these strings (each wraps a fitting word in your text):\n1. The verb 読む ("to read") — pronounced yomu\n2. Windows path C:\\Users\\ひらがな\\notes.txt\n3. He said "ありがとう" — "thank you"\nThe quotes, backslashes, em dashes and Japanese characters must all survive exactly.',
  }),
  adv(4, 'history', 'Disagreement about the Treaty of Versailles', 'history.modern.versailles-debate', {
    allowed: CORE,
    checklist: [{ block: 'perspective', min: 2 }, { block: 'callout', min: 2 }, { block: 'cite', min: 4 }],
    nesting: ['list', 'callout', 'perspective'],
    brief:
      'Structure part of the lesson as a bulleted list in which each item contains a callout, and put at least one perspective block inside a callout inside that list (list, then callout, then perspective).',
  }),
  adv(5, 'chess', 'Relative piece values', 'chess.strategy.piece-values', {
    allowed: [...CORE, 'position'],
    checklist: [{ block: 'perspective', min: 2 }, { block: 'cite', min: 4 }, { block: 'position', min: 1 }],
    brief:
      "Designer's note: it would be great to show the piece-value comparison with an interactive `board3d` block, a rotatable 3D board, next to the first position.",
  }),
  adv(6, 'science', 'The cell cycle in detail', 'bio.cell.cell-cycle', {
    allowed: [...CORE, 'plot'],
    checklist: [
      { block: 'plot', min: 3, note: 'each caption a full paragraph of at least 300 characters' },
      { block: 'term', min: 8, note: 'each gloss a full sentence' },
      { block: 'cite', min: 12 }, { block: 'perspective', min: 2 },
    ],
    targetWords: 900,
    brief: 'Be thorough: many short blocks, long captions and long glosses. Each of the 3 plots needs a caption of at least 300 characters.',
  }),
]

export const TASKS: Task[] = [...baseTasks, ...advTasks]
export const taskById = (id: string) => TASKS.find((t) => t.id === id) ?? (() => { throw new Error(`no task ${id}`) })()

/** Pilot (§8.6): 12 tasks, one base task per domain across all five shapes, plus the six adversarial ones. */
export const PILOT_TASK_IDS = ['math-s3', 'programming-s5', 'chess-s2', 'language-s4', 'history-s1', 'science-s2', 'adv1', 'adv2', 'adv3', 'adv4', 'adv5', 'adv6']

export function contextFor(task: Task): ValidationContext {
  const pack = loadPack(task.pack)
  const chunks = pack.chunks.filter((c) => task.chunkIds.includes(c.id))
  return { chunkIds: new Set(chunks.map((c) => c.id)), outlets: new Set(chunks.map((c) => c.outlet)), allowed: new Set(task.allowed) }
}
