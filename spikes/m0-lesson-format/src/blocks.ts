// BlockSpec registry (lesson-ir.md §4, §9.3, §9.5). Both arms generate their schemas, guidance and
// validators from these definitions, so the only variable between arms is surface syntax (§8.2).
import { checkFen } from './fen.ts'
import type { Arm, Diagnostic, Json, LNode, ValidationContext } from './types.ts'

export const SLUG = '^[a-z][a-z0-9-]*$'
export const DOTTED = '^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)+$'
export const CHUNK = '^src:[a-z0-9-]+#c[0-9]+$'
export const OUTLET = '^src:[a-z0-9-]+$'
const SQUARE = '^[a-h][1-8]$'

type Schema = Record<string, any>

export interface BlockSpec {
  name: string
  kind: 'leaf' | 'container' | 'inline'
  /** JSON Schema of the neutral node's attrs (including lifted part fields). */
  attrs: Schema
  /** Markdoc only: field -> child tag that carries it (lifted into attrs). */
  parts?: Record<string, string>
  /** Directive only: scalar fields that still go in the YAML body (non-scalar fields always do). */
  yamlOnly?: string[]
  /** Blocks this block may appear directly inside (default: anywhere). */
  parents?: string[]
  guidance: { when: string; rules: string[]; avoid?: string[] }
  syntax: Record<Arm, string>
  /** A second canonical form for one arm (e.g. the directive leaf form when no structured field is given). */
  alt?: Partial<Record<Arm, { note: string; example: string }>>
  /** Plain-text projection: feeds the format-normalised rendering the judge and the human check see. */
  plain(node: LNode, inner: string): string
  validate?(node: LNode, ctx: ValidationContext): Diagnostic[]
}

const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra })
const obj = (properties: Schema, required: string[]): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const attrs = (properties: Schema, required: string[]): Schema => obj(properties, required)

function diag(node: LNode, id: Diagnostic['id'], message: string, attr?: string): Diagnostic {
  return { id, message, line: node.line, block: node.type, attr }
}

export const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])
export const isScalarSchema = (s: Schema) => SCALAR_TYPES.has(s.type)

/** Fields that live in the YAML body in the directive arm. */
export function yamlFields(spec: BlockSpec): string[] {
  return Object.entries(spec.attrs.properties as Schema)
    .filter(([k, v]) => !isScalarSchema(v) || spec.yamlOnly?.includes(k))
    .map(([k]) => k)
}

const roles = ['emphasis', 'contrast', 'context', 'critique', 'exemplar']
const EXERCISE_PARTS = ['prompt', 'choices', 'hints', 'steps']

export const BLOCKS: BlockSpec[] = [
  {
    name: 'cite',
    kind: 'inline',
    attrs: attrs({ chunk: str({ pattern: CHUNK }) }, ['chunk']),
    guidance: {
      when: 'Wrap the span of a sentence that a source chunk supports. Every factual claim taken from the source pack needs one.',
      rules: [
        'chunk must be the id of a chunk in your source pack, exactly as given (for example src:openstax-bio#c4).',
        'The wrapped span is the claim itself, not the whole paragraph.',
      ],
      avoid: ['Do not cite a chunk you were not given. Do not wrap headings or code.'],
    },
    syntax: {
      markdoc: '{% cite chunk="src:wiki-fork#c3" %}a fork only wins material if its targets are undefended{% /cite %}',
      directive: ':cite[a fork only wins material if its targets are undefended]{chunk="src:wiki-fork#c3"}',
    },
    plain: (n, inner) => `${inner} [source: ${n.attrs.chunk}]`,
    validate: (n, ctx) =>
      ctx.chunkIds.has(String(n.attrs.chunk))
        ? []
        : [diag(n, 'bad-citation', `chunk "${n.attrs.chunk}" is not in the source pack`, 'chunk')],
  },
  {
    name: 'term',
    kind: 'inline',
    attrs: attrs({ gloss: str({ minLength: 3, maxLength: 240 }) }, ['gloss']),
    guidance: {
      when: 'Mark the first use of a key term and give its definition in one sentence.',
      rules: ['gloss is a plain one-sentence definition, no Markdown.'],
    },
    syntax: {
      markdoc: '{% term gloss="One move that attacks two pieces at once." %}fork{% /term %}',
      directive: ':term[fork]{gloss="One move that attacks two pieces at once."}',
    },
    plain: (n, inner) => `${inner} (${n.attrs.gloss})`,
  },
  {
    name: 'callout',
    kind: 'container',
    attrs: attrs({ type: str({ enum: ['note', 'tip', 'warning', 'misconception'] }) }, ['type']),
    guidance: {
      when: 'Set apart a short aside: a tip, a warning, a common misconception, or a note.',
      rules: [
        'type is one of note, tip, warning, misconception.',
        'If the lesson needs a kind of block that is not in your allowed list, say so in a note callout instead of inventing a block.',
      ],
    },
    syntax: {
      markdoc: '{% callout type="tip" %}\nCount the loose pieces before you look for the jump.\n{% /callout %}',
      directive: ':::callout{type=tip}\nCount the loose pieces before you look for the jump.\n:::',
    },
    plain: (n, inner) => `[${String(n.attrs.type).toUpperCase()}] ${inner}`,
  },
  {
    name: 'perspective',
    kind: 'container',
    attrs: attrs({ outlet: str({ pattern: OUTLET }), role: str({ enum: roles }) }, ['outlet', 'role']),
    guidance: {
      when: 'Present how one outlet (one source) frames the topic, attributed to that outlet.',
      rules: [
        'outlet is the outlet id of a source in your pack (for example src:silman), exactly as given.',
        `role is one of ${roles.join(', ')}.`,
        'Use a different outlet for each perspective and keep each one faithful to what its chunks say.',
        'A perspective cannot contain another perspective.',
      ],
    },
    syntax: {
      markdoc:
        '{% perspective outlet="src:silman" role="emphasis" %}\nSilman frames forks as a symptom of loose pieces.\n{% /perspective %}',
      directive:
        ':::perspective{outlet="src:silman" role=emphasis}\nSilman frames forks as a symptom of loose pieces.\n:::',
    },
    plain: (n, inner) => `Perspective from ${n.attrs.outlet} (${n.attrs.role}): ${inner}`,
    validate: (n, ctx) => {
      const out: Diagnostic[] = []
      if (!ctx.outlets.has(String(n.attrs.outlet)))
        out.push(diag(n, 'bad-citation', `outlet "${n.attrs.outlet}" is not an outlet in the source pack`, 'outlet'))
      return out
    },
  },
  {
    name: 'position',
    kind: 'leaf',
    attrs: attrs(
      {
        id: str({ pattern: SLUG }),
        fen: str(),
        orientation: str({ enum: ['white', 'black'] }),
        caption: str({ minLength: 3, maxLength: 400 }),
        reveal: obj(
          { move: str({ minLength: 2 }), highlight: { type: 'array', items: str({ pattern: SQUARE }), maxItems: 16 } },
          ['move'],
        ),
      },
      ['id', 'fen', 'orientation', 'caption'],
    ),
    guidance: {
      when: 'Show a concrete chess position the learner should look at.',
      rules: [
        'fen must be a legal six-field FEN. Never invent a position you cannot justify; build it from the source or from a standard example.',
        'reveal (optional) names the move and the squares to highlight once the learner has looked.',
      ],
    },
    syntax: {
      markdoc:
        '{% position id="p1" fen="r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1" orientation="white" caption="White to move: where does the knight fork king and rook?" reveal={move: "Nc7+", highlight: ["c7", "e8", "a8"]} /%}',
      directive:
        ':::position{#p1 fen="r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1" orientation=white caption="White to move: where does the knight fork king and rook?"}\n```yaml\nreveal: {move: Nc7+, highlight: [c7, e8, a8]}\n```\n:::',
    },
    alt: {
      directive: {
        note: 'Without a reveal there is no structured field, so use the leaf form:',
        example: '::position{#p2 fen="4k3/8/8/8/8/8/8/4K3 w - - 0 1" orientation=white caption="A bare kings endgame."}',
      },
    },
    plain: (n) => `[Chess position ${n.attrs.id}: ${n.attrs.caption} FEN ${n.attrs.fen}]`,
    validate: (n) => {
      const problem = checkFen(String(n.attrs.fen ?? ''))
      return problem ? [diag(n, 'bad-value', `fen is not legal: ${problem}`, 'fen')] : []
    },
  },
  {
    name: 'plot',
    kind: 'leaf',
    attrs: attrs(
      {
        id: str({ pattern: SLUG }),
        title: str({ minLength: 3, maxLength: 120 }),
        kind: str({ enum: ['line', 'scatter', 'bar'] }),
        xLabel: str({ maxLength: 60 }),
        yLabel: str({ maxLength: 60 }),
        caption: str({ minLength: 3, maxLength: 600 }),
        series: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: obj(
            {
              label: str({ minLength: 1, maxLength: 60 }),
              points: {
                type: 'array',
                minItems: 2,
                maxItems: 60,
                items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              },
            },
            ['label', 'points'],
          ),
        },
      },
      ['id', 'title', 'kind', 'xLabel', 'yLabel', 'caption', 'series'],
    ),
    guidance: {
      when: 'Show a quantity changing: a function graph, a measured series, or a comparison of bars.',
      rules: [
        'Compute the points yourself; each point is [x, y] with real numbers.',
        'Use 2 to 60 points per series and at most 4 series.',
        'Do not plot numbers you cannot defend from the source or from the formula you state.',
      ],
    },
    syntax: {
      markdoc:
        '{% plot id="pl1" title="Free fall" kind="line" xLabel="time (s)" yLabel="distance (m)" caption="Distance fallen grows with the square of time." series=[{label: "d = 4.9t^2", points: [[0, 0], [1, 4.9], [2, 19.6], [3, 44.1]]}] /%}',
      directive:
        ':::plot{#pl1 title="Free fall" kind=line xLabel="time (s)" yLabel="distance (m)" caption="Distance fallen grows with the square of time."}\n```yaml\nseries:\n  - label: d = 4.9t^2\n    points: [[0, 0], [1, 4.9], [2, 19.6], [3, 44.1]]\n```\n:::',
    },
    plain: (n) => `[Plot ${n.attrs.id}: ${n.attrs.title}. ${n.attrs.caption}]`,
  },
  {
    name: 'animation',
    kind: 'leaf',
    attrs: attrs(
      {
        id: str({ pattern: SLUG }),
        scene: str({ pattern: SLUG }),
        durationSec: { type: 'integer', minimum: 3, maximum: 60 },
        caption: str({ minLength: 3, maxLength: 400 }),
        params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      },
      ['id', 'scene', 'durationSec', 'caption'],
    ),
    guidance: {
      when: 'Describe a short scripted animation of a process, such as a data structure changing step by step.',
      rules: [
        'scene is a short slug naming the animation (for example binary-search-steps).',
        'params is a flat object of strings, numbers or booleans that configures the scene.',
      ],
    },
    syntax: {
      markdoc:
        '{% animation id="a1" scene="binary-search-steps" durationSec=20 caption="The search window halves on every comparison." params={target: 42, size: 16} /%}',
      directive:
        ':::animation{#a1 scene=binary-search-steps durationSec=20 caption="The search window halves on every comparison."}\n```yaml\nparams: {target: 42, size: 16}\n```\n:::',
    },
    alt: {
      directive: {
        note: 'Without params there is no structured field, so use the leaf form:',
        example: '::animation{#a2 scene=stack-push-pop durationSec=10 caption="Push and pop."}',
      },
    },
    plain: (n) => `[Animation ${n.attrs.id} (${n.attrs.scene}): ${n.attrs.caption}]`,
  },
  {
    name: 'timeline',
    kind: 'leaf',
    attrs: attrs(
      {
        id: str({ pattern: SLUG }),
        caption: str({ minLength: 3, maxLength: 400 }),
        events: {
          type: 'array',
          minItems: 3,
          maxItems: 16,
          items: obj({ year: { type: 'integer' }, label: str({ minLength: 2, maxLength: 120 }) }, ['year', 'label']),
        },
      },
      ['id', 'caption', 'events'],
    ),
    guidance: {
      when: 'Lay out dated events in order, when sequence matters.',
      rules: ['Give 3 to 16 events in chronological order; year is an integer (negative for BCE).'],
    },
    syntax: {
      markdoc:
        '{% timeline id="t1" caption="Key steps toward the Great War." events=[{year: 1871, label: "German unification"}, {year: 1879, label: "Dual Alliance"}, {year: 1914, label: "Outbreak of war"}] /%}',
      directive:
        ':::timeline{#t1 caption="Key steps toward the Great War."}\n```yaml\nevents:\n  - {year: 1871, label: German unification}\n  - {year: 1879, label: Dual Alliance}\n  - {year: 1914, label: Outbreak of war}\n```\n:::',
    },
    plain: (n) => {
      const ev = (n.attrs.events as { year: number; label: string }[] | undefined) ?? []
      return `[Timeline ${n.attrs.id}: ${n.attrs.caption} ${ev.map((e) => `${e.year}: ${e.label}`).join('; ')}]`
    },
  },
  {
    name: 'worked-example',
    kind: 'container',
    attrs: attrs(
      {
        id: str({ pattern: SLUG }),
        title: str({ minLength: 3, maxLength: 160 }),
        skills: { type: 'array', items: str({ pattern: DOTTED }), minItems: 1 },
      },
      ['id', 'title', 'skills'],
    ),
    guidance: {
      when: 'Walk through one solved problem as ordered steps the learner can follow.',
      rules: [
        'Contains two or more step blocks, in order. Each step has a unique id and says what is done and why.',
        'skills lists dotted skill ids such as math.algebra.factoring.',
      ],
    },
    syntax: {
      markdoc:
        '{% worked-example id="w1" title="Factor x^2 + 5x + 6" skills=["math.algebra.factoring"] %}\n{% step id="s1" %}\nFind two numbers that multiply to 6 and add to 5.\n{% /step %}\n{% step id="s2" %}\nThey are 2 and 3, so the factors are (x + 2)(x + 3).\n{% /step %}\n{% /worked-example %}',
      directive:
        '::::worked-example{#w1 title="Factor x^2 + 5x + 6"}\n```yaml\nskills: [math.algebra.factoring]\n```\n\n:::step{#s1}\nFind two numbers that multiply to 6 and add to 5.\n:::\n\n:::step{#s2}\nThey are 2 and 3, so the factors are (x + 2)(x + 3).\n:::\n\n::::',
    },
    plain: (n, inner) => `Worked example "${n.attrs.title}":\n${inner}`,
    validate: (n) => {
      const steps = n.children.filter((c) => c.kind === 'block' && c.type === 'step')
      const out: Diagnostic[] = []
      if (steps.length < 2) out.push(diag(n, 'bad-nesting', `worked-example needs at least 2 step blocks, found ${steps.length}`))
      return out
    },
  },
  {
    name: 'step',
    kind: 'container',
    parents: ['worked-example'],
    attrs: attrs({ id: str({ pattern: SLUG }), misconception: str({ pattern: DOTTED }), key: str() }, ['id']),
    guidance: {
      when: 'One step of a worked-example. (Exercise steps use the same fields.)',
      rules: ['id is unique in the lesson. misconception (optional) is a dotted id naming the mistake this step guards against.'],
    },
    syntax: {
      markdoc: '{% step id="s1" %}\nFind two numbers that multiply to 6 and add to 5.\n{% /step %}',
      directive: ':::step{#s1}\nFind two numbers that multiply to 6 and add to 5.\n:::',
    },
    plain: (n, inner) => `- Step ${n.attrs.id}: ${inner}`,
  },
  {
    name: 'exercise',
    kind: 'container',
    parts: { prompt: 'prompt', choices: 'choice', hints: 'hint', steps: 'step' },
    yamlOnly: ['prompt'],
    attrs: attrs(
      {
        id: str({ pattern: SLUG }),
        group: str({ pattern: SLUG }),
        kind: str({ enum: ['mcq', 'short', 'numeric'] }),
        cognitive: str({ enum: ['recall', 'recognize', 'apply', 'analyze'] }),
        scaffold: str({ enum: ['independent', 'hinted', 'faded', 'worked'] }),
        expectedTimeSec: { type: 'integer', minimum: 5, maximum: 900 },
        answer: str({ minLength: 1, maxLength: 200 }),
        skills: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: obj(
            { id: str({ pattern: DOTTED }), weight: { type: 'number', minimum: 0, maximum: 1 }, role: str({ enum: ['target', 'prereq'] }) },
            ['id', 'weight', 'role'],
          ),
        },
        difficulty: obj({ b: { type: 'number', minimum: -3, maximum: 3 }, source: str({ enum: ['llm', 'calibrated'] }) }, ['b', 'source']),
        modes: { type: 'array', minItems: 1, uniqueItems: true, items: str({ enum: ['formative', 'practice', 'checkpoint'] }) },
        cites: { type: 'array', items: str({ pattern: CHUNK }) },
        prompt: str({ minLength: 5 }),
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: 5,
          items: obj(
            {
              id: str({ pattern: '^[a-e]$' }),
              text: str({ minLength: 1 }),
              correct: { type: 'boolean' },
              misconception: str({ pattern: DOTTED }),
              feedback: str({ minLength: 1 }),
            },
            ['id', 'text'],
          ),
        },
        hints: {
          type: 'array',
          maxItems: 5,
          items: obj({ level: { type: 'integer', minimum: 1, maximum: 5 }, text: str({ minLength: 3 }) }, ['level', 'text']),
        },
        steps: {
          type: 'array',
          maxItems: 8,
          items: obj({ id: str({ pattern: SLUG }), text: str({ minLength: 1 }), key: str(), misconception: str({ pattern: DOTTED }) }, ['id', 'text']),
        },
      },
      ['id', 'group', 'kind', 'cognitive', 'scaffold', 'skills', 'difficulty', 'modes', 'prompt'],
    ),
    guidance: {
      when: 'Check understanding with a question. This is the full exercise envelope: the platform grades it server-side.',
      rules: [
        'Every exercise has id, group (isomorph group id), kind, cognitive, scaffold, skills, difficulty, modes and a prompt.',
        'kind mcq: 3 to 5 choices with ids a to e, exactly one with correct=true; every wrong choice should carry a misconception id and may carry feedback.',
        'kind short or numeric: give answer (a short string) and no choices.',
        'hints are levels 1 to 5, in order, each more explicit than the last; the last must not just give the answer away.',
        'modes may include formative and practice. Never include checkpoint: checkpoint items do not appear in lesson text.',
        'skills ids and misconception ids are dotted lowercase ids (for example chess.tactics.fork.knight). difficulty.b is a number from -3 to 3.',
        'steps (optional) break a solution into ordered parts with ids.',
      ],
    },
    syntax: {
      markdoc:
        '{% exercise id="e1" group="fork-recognize-1" kind="mcq" cognitive="recognize" scaffold="independent"\n   skills=[{id: "chess.tactics.fork.knight", weight: 1, role: "target"}]\n   difficulty={b: 0.0, source: "llm"} modes=["formative"] %}\n{% prompt %}Which squares does a knight on c7 attack that matter in the diagram?{% /prompt %}\n{% choice id="a" correct=true %}e8 and a8{% /choice %}\n{% choice id="b" misconception="chess.misc.knight-moves-straight" %}d8 and b8\n{% feedback %}Knights never move along a line.{% /feedback %}{% /choice %}\n{% choice id="c" misconception="chess.misc.one-target" %}Only e8{% /choice %}\n{% hint level=1 %}What is the knight attacking from c7?{% /hint %}\n{% hint level=2 %}Trace the two corners of the L-shape from c7.{% /hint %}\n{% /exercise %}',
      directive:
        ':::exercise{#e1 group=fork-recognize-1 kind=mcq cognitive=recognize scaffold=independent}\n```yaml\nprompt: Which squares does a knight on c7 attack that matter in the diagram?\nskills:\n  - {id: chess.tactics.fork.knight, weight: 1, role: target}\ndifficulty: {b: 0.0, source: llm}\nmodes: [formative]\nchoices:\n  - {id: a, text: e8 and a8, correct: true}\n  - {id: b, text: d8 and b8, misconception: chess.misc.knight-moves-straight, feedback: Knights never move along a line.}\n  - {id: c, text: Only e8, misconception: chess.misc.one-target}\nhints:\n  - {level: 1, text: What is the knight attacking from c7?}\n  - {level: 2, text: Trace the two corners of the L-shape from c7.}\n```\n:::',
    },
    plain: (n) => {
      const a = n.attrs
      const lines = [`Exercise ${a.id} (${a.kind}, ${a.cognitive}): ${a.prompt}`]
      for (const c of (a.choices as { id: string; text: string }[] | undefined) ?? []) lines.push(`  ${c.id}) ${c.text}`)
      if (a.answer) lines.push(`  Answer: ${a.answer}`)
      for (const h of (a.hints as { level: number; text: string }[] | undefined) ?? []) lines.push(`  Hint ${h.level}: ${h.text}`)
      for (const s of (a.steps as { id: string; text: string }[] | undefined) ?? []) lines.push(`  Step ${s.id}: ${s.text}`)
      return lines.join('\n')
    },
    validate: (n, ctx) => {
      const a = n.attrs as Record<string, any>
      const out: Diagnostic[] = []
      const choices: any[] = Array.isArray(a.choices) ? a.choices : []
      if (a.kind === 'mcq') {
        if (choices.length < 3) out.push(diag(n, 'bad-value', 'mcq exercise needs 3 to 5 choices', 'choices'))
        const correct = choices.filter((c) => c.correct === true).length
        if (correct !== 1) out.push(diag(n, 'bad-value', `mcq exercise needs exactly one choice with correct=true, found ${correct}`, 'choices'))
        for (const c of choices)
          if (c.correct === true && c.misconception) out.push(diag(n, 'bad-value', `choice ${c.id} is correct but has a misconception id`, 'choices'))
        if (a.answer !== undefined) out.push(diag(n, 'bad-value', 'mcq exercise must not have an answer attribute; mark the choice with correct=true', 'answer'))
        if (new Set(choices.map((c) => c.id)).size !== choices.length) out.push(diag(n, 'bad-value', 'choice ids must be unique', 'choices'))
      } else {
        if (a.answer === undefined) out.push(diag(n, 'missing-attr', `${a.kind} exercise needs an answer attribute`, 'answer'))
        if (choices.length) out.push(diag(n, 'bad-value', `${a.kind} exercise must not have choices`, 'choices'))
      }
      const hints: any[] = Array.isArray(a.hints) ? a.hints : []
      const levels = hints.map((h) => h.level)
      if (levels.some((l, i) => i > 0 && l <= levels[i - 1]))
        out.push(diag(n, 'bad-value', 'hint levels must be unique and in increasing order', 'hints'))
      if (Array.isArray(a.modes) && a.modes.includes('checkpoint'))
        out.push(diag(n, 'bad-value', 'checkpoint items must not appear in lesson text; use modes formative or practice', 'modes'))
      const steps: any[] = Array.isArray(a.steps) ? a.steps : []
      if (new Set(steps.map((s) => s.id)).size !== steps.length) out.push(diag(n, 'bad-value', 'step ids must be unique', 'steps'))
      for (const c of Array.isArray(a.cites) ? a.cites : [])
        if (typeof c === 'string' && !ctx.chunkIds.has(c)) out.push(diag(n, 'bad-citation', `cites entry "${c}" is not a chunk in the source pack`, 'cites'))
      return out
    },
  },
]

export const REGISTRY = new Map(BLOCKS.map((b) => [b.name, b]))

/** Tags that exist only as Markdoc child tags of `exercise` (lifted into attrs). */
export const MARKDOC_PART_TAGS = ['prompt', 'choice', 'feedback', 'hint'] as const
export const EXERCISE_PART_FIELDS = EXERCISE_PARTS

/** Frontmatter schema, shared by both arms. */
export const FRONTMATTER_SCHEMA: Schema = obj({ lesson: str({ pattern: SLUG }), concept: str({ pattern: DOTTED }) }, ['lesson', 'concept'])

export type { Json }
