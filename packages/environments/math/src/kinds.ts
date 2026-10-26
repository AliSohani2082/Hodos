/**
 * Exercise kinds and lesson blocks of the math environment. Prompts may show
 * a formula (rendered as MathML) and a graph (rendered as SVG) in the
 * sandboxed `math-view` renderer; the learner answers in the workspace's own
 * text form, and every prompt also has a plain-text form.
 * @module @hodos/math/kinds
 */
import { unreachable, type Diagnostic, type ExerciseItem, type ExerciseKindSpec, type JsonObject, type JsonSchema, type JsonValue, type LessonBlockSpec, type LessonNode } from '@hodos/plugin-sdk'
import { equivalent, hasUnexpandedProduct, isProduct, parse, type Expr } from './expr.js'
import { toText } from './present.js'

export const ENVIRONMENT = 'math.expression'
export const RENDERER_ID = 'math-view'
export const GRADER_ID = 'math.grader'

/** Kind ids. */
export const KIND = { numeric: 'math.numeric', expression: 'math.expression' } as const

/** Forms an expression answer can be required to have. */
export const FORMS = ['any', 'simplified', 'expanded', 'factored'] as const

/** One required form. */
export type Form = (typeof FORMS)[number]

const TEXT = (max: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength: max })
const VARIABLE = { type: 'string', pattern: '^[a-df-z]$' } as const
const RANGE: JsonSchema = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }

const GRAPH_PROPERTIES = {
  x: RANGE,
  y: RANGE,
  functions: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['expr'], properties: { expr: TEXT(120), label: TEXT(40) } } },
  points: { type: 'array', maxItems: 12, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } },
  lines: { type: 'array', maxItems: 4, items: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } } },
} satisfies Record<string, JsonSchema>

/** Schema of a graph: functions of x, points, and lines through two points, in a viewport. */
export const GRAPH_SCHEMA: JsonSchema = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: GRAPH_PROPERTIES }

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

/** A graph coordinate as text (the schema makes it a number). */
function coord(value: JsonValue | undefined): string {
  return typeof value === 'number' ? String(value) : '?'
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function error(code: string, message: string): Diagnostic {
  return { severity: 'error', code, message }
}

/** Read an expression field, reporting a parse failure. */
function expressionProblem(code: string, text: string, variables: readonly string[]): Diagnostic | null {
  const parsed = parse(text, variables)
  return parsed.ok ? null : error(code, `"${text}" does not parse: ${parsed.error}`)
}

/** Check a graph's viewport and functions. */
function graphProblems(graph: JsonValue | undefined): Diagnostic[] {
  if (graph === undefined) return []
  const g = obj(graph)
  const out: Diagnostic[] = []
  for (const [name, range] of [['x', g.x], ['y', g.y]] as const) {
    const r = Array.isArray(range) ? range : []
    if (!(typeof r[0] === 'number' && typeof r[1] === 'number' && r[0] < r[1])) out.push(error('math/graph-range', `graph ${name} range must be [min, max] with min < max`))
  }
  for (const f of Array.isArray(g.functions) ? g.functions : []) {
    const problem = expressionProblem('math/graph-function', str(obj(f).expr), ['x'])
    if (problem !== null) out.push(problem)
  }
  return out
}

/** Whether an answer meets a required form. */
export function meetsForm(answer: Expr, key: Expr, form: Form): boolean {
  switch (form) {
    case 'any': return true
    case 'expanded': return !hasUnexpandedProduct(answer)
    case 'factored': return isProduct(answer)
    case 'simplified': return size(answer) <= size(key)
    default: return unreachable(form, 'form')
  }
}

/** Number of nodes; a simplified answer is no larger than the key. */
export function size(expr: Expr): number {
  switch (expr.type) {
    case 'bin': return 1 + size(expr.left) + size(expr.right)
    case 'neg':
    case 'call': return 1 + size(expr.arg)
    default: return 1
  }
}

function formulaText(payload: JsonObject, variables: readonly string[]): string {
  const formula = str(payload.formula)
  if (formula === '') return ''
  const parsed = parse(formula, variables)
  return parsed.ok ? ` ${toText(parsed.expr)}` : ` ${formula}`
}

/** What a graph shows, in words. */
function graphParts(graph: JsonValue | undefined): string[] {
  if (graph === undefined) return []
  const g = obj(graph)
  const parts: string[] = []
  for (const f of Array.isArray(g.functions) ? g.functions : []) parts.push(`y = ${str(obj(f).expr)}`)
  for (const p of Array.isArray(g.points) ? g.points : []) if (Array.isArray(p)) parts.push(`point (${coord(p[0])}, ${coord(p[1])})`)
  for (const l of Array.isArray(g.lines) ? g.lines : []) if (Array.isArray(l)) parts.push(`a line through (${coord(l[0])}, ${coord(l[1])}) and (${coord(l[2])}, ${coord(l[3])})`)
  return parts
}

function graphText(graph: JsonValue | undefined): string {
  const parts = graphParts(graph)
  return parts.length === 0 ? '' : `\nGraph: ${parts.join('; ')}.`
}

/** A numeric answer, checked with a tolerance. */
export const numericKind: ExerciseKindSpec = {
  id: KIND.numeric,
  title: 'Number answer',
  environment: ENVIRONMENT,
  responseKind: 'number',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['prompt'],
    properties: { prompt: TEXT(300), formula: TEXT(200), unit: TEXT(20), graph: GRAPH_SCHEMA },
  },
  keySchema: {
    type: 'object', additionalProperties: false, required: ['value'],
    properties: {
      value: { type: 'number' },
      tolerance: { type: 'object', additionalProperties: false, properties: { abs: { type: 'number', minimum: 0 }, rel: { type: 'number', minimum: 0 } } },
      misconceptions: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['value', 'id'], properties: { value: { type: 'number' }, id: { type: 'string', pattern: '^[a-z0-9-]{1,48}$' } } } },
    },
  },
  responseSchema: {
    type: 'object', additionalProperties: false,
    properties: { text: { type: 'string', maxLength: 120 }, value: { type: 'number' } },
  },
  guidance: {
    when: 'The answer is one number (a solution, a slope, a value). The learner may type 4, -0.5, 3/4 or sqrt(2).',
    rules: ['`key.value` is the answer; `key.tolerance` (abs or rel) allows rounding.', '`key.misconceptions` lists values a typical mistake produces, with the misconception id.', '`graph` shows points, lines or functions; a graph-reading item must not state the answer in the prompt.'],
    example: {
      payload: { prompt: 'Solve for x.', formula: '2x + 3 = 11' },
      key: { value: 4, misconceptions: [{ value: 7, id: 'added-instead-of-subtracted' }] },
    },
  },
  validateItem: item => {
    const payload = obj(item.payload)
    const key = obj(item.key)
    const out = graphProblems(payload.graph)
    const formula = str(payload.formula)
    if (formula !== '') {
      // Equations are shown as text around '='; each side must parse.
      for (const side of formula.split('=')) {
        const problem = expressionProblem('math/formula', side.trim(), ['x', 'y'])
        if (problem !== null) out.push(problem)
      }
    }
    const value = key.value
    for (const m of Array.isArray(key.misconceptions) ? key.misconceptions : []) {
      if (obj(m).value === value) out.push(error('math/misconception-value', 'a misconception value equals the answer'))
    }
    return out
  },
  fallbackText: payload => {
    const p = obj(payload)
    return `${str(p.prompt)}${str(p.formula) === '' ? '' : ` ${str(p.formula)}`}${graphText(p.graph)}${str(p.unit) === '' ? '' : `\n(Answer in ${str(p.unit)}.)`}`
  },
  reveal: item => ({ value: obj(item.key).value ?? null }),
}

/** An expression answer, checked for algebraic equivalence and form. */
export const expressionKind: ExerciseKindSpec = {
  id: KIND.expression,
  title: 'Expression answer',
  environment: ENVIRONMENT,
  responseKind: 'expression',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['prompt', 'variables'],
    properties: { prompt: TEXT(300), formula: TEXT(200), variables: { type: 'array', minItems: 1, maxItems: 3, items: VARIABLE }, form: { enum: [...FORMS] }, graph: GRAPH_SCHEMA },
  },
  keySchema: {
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: {
      answer: TEXT(200),
      misconceptions: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['expression', 'id'], properties: { expression: TEXT(200), id: { type: 'string', pattern: '^[a-z0-9-]{1,48}$' } } } },
    },
  },
  responseSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 300 } } },
  guidance: {
    when: 'The answer is an expression: simplify, expand or factor. Any equivalent expression is accepted, in the required `form`.',
    rules: [
      '`variables` lists the letters the learner may use (not e, which is Euler\'s number).',
      '`form`: any, simplified (no larger than the key), expanded (no product of sums) or factored (a product).',
      '`key.misconceptions` lists expressions a typical mistake produces, e.g. (x + 1)^2 → x^2 + 1.',
    ],
    example: {
      payload: { prompt: 'Expand and simplify.', formula: '(x + 1)^2', variables: ['x'], form: 'expanded' },
      key: { answer: 'x^2 + 2x + 1', misconceptions: [{ expression: 'x^2 + 1', id: 'freshmans-dream' }] },
    },
  },
  validateItem: item => {
    const payload = obj(item.payload)
    const key = obj(item.key)
    const variables = strings(payload.variables)
    const out = graphProblems(payload.graph)
    const answer = parse(str(key.answer), variables)
    if (!answer.ok) return [...out, error('math/answer', `the key does not parse: ${answer.error}`)]
    const form: Form = FORMS.find(f => f === payload.form) ?? 'any'
    if (!meetsForm(answer.expr, answer.expr, form)) out.push(error('math/answer-form', `the key is not in the required ${form} form`))
    const formula = str(payload.formula)
    if (formula !== '') {
      const shown = parse(formula, variables)
      if (!shown.ok) out.push(error('math/formula', `the formula does not parse: ${shown.error}`))
      else if (form !== 'any' && equivalent(shown.expr, answer.expr, variables) === 'equivalent' && meetsForm(shown.expr, answer.expr, form)) {
        out.push(error('math/formula-is-answer', 'the formula already is an accepted answer'))
      }
    }
    for (const m of Array.isArray(key.misconceptions) ? key.misconceptions : []) {
      const wrong = parse(str(obj(m).expression), variables)
      if (!wrong.ok) out.push(error('math/misconception', `misconception "${str(obj(m).expression)}" does not parse: ${wrong.error}`))
      else if (equivalent(wrong.expr, answer.expr, variables) === 'equivalent') out.push(error('math/misconception', `misconception "${str(obj(m).expression)}" is equivalent to the answer`))
    }
    return out
  },
  fallbackText: payload => {
    const p = obj(payload)
    const form = str(p.form)
    const note = form === 'expanded' ? ' Give it expanded.' : form === 'factored' ? ' Give it factored.' : form === 'simplified' ? ' Simplify fully.' : ''
    return `${str(p.prompt)}${formulaText(p, strings(p.variables))}${graphText(p.graph)}\n(Type an expression in ${strings(p.variables).join(', ')}, e.g. 2x^2 + 3x - 1.${note})`
  },
  reveal: item => ({ answer: str(obj(item.key).answer) }),
}

/** All kinds. */
export const KINDS: readonly ExerciseKindSpec[] = [numericKind, expressionKind]

/** The `math-formula` lesson block. */
export const formulaBlock: LessonBlockSpec = {
  name: 'math-formula',
  version: 1,
  kind: 'leaf',
  attributes: {
    type: 'object', additionalProperties: false, required: ['id', 'expr'],
    properties: { id: { type: 'string' }, expr: TEXT(200), variables: { type: 'array', maxItems: 3, items: VARIABLE }, caption: TEXT(200) },
  },
  guidance: {
    when: 'Show a formula in a lesson.',
    syntax: '{% math-formula expr="(x + 1)^2 = x^2 + 2x + 1" variables=["x"] /%}',
    rules: ['Write expressions in the same syntax learners type: 2x^2 + 3x - 1, (x + 1)(x - 1), sqrt(x).', 'An equation may contain one "=".'],
  },
  validate: (node: LessonNode) => {
    const variables = strings(node.attributes.variables)
    return str(node.attributes.expr).split('=').flatMap(side => {
      const problem = expressionProblem('math/formula', side.trim(), variables)
      return problem === null ? [] : [problem]
    })
  },
  fallbackText: (node: LessonNode) => `${str(node.attributes.expr)}${str(node.attributes.caption) === '' ? '' : ` — ${str(node.attributes.caption)}`}`,
  renderer: RENDERER_ID,
}

/** The `math-graph` lesson block. */
export const graphBlock: LessonBlockSpec = {
  name: 'math-graph',
  version: 1,
  kind: 'leaf',
  attributes: {
    type: 'object', additionalProperties: false, required: ['id', 'x', 'y'],
    properties: { ...GRAPH_PROPERTIES, id: { type: 'string' }, caption: TEXT(200) },
  },
  guidance: {
    when: 'Show the graph of a function, points, or a line through two points.',
    syntax: '{% math-graph x=[-5, 5] y=[-5, 5] functions=[{expr: "2x - 1", label: "y = 2x - 1"}] points=[[0, -1]] /%}',
    rules: ['Functions are in x.', 'Keep the viewport small enough to read the grid.'],
  },
  validate: (node: LessonNode) => graphProblems(node.attributes),
  fallbackText: (node: LessonNode) => `[Graph: ${graphParts(node.attributes).join('; ')}]${str(node.attributes.caption) === '' ? '' : ` ${str(node.attributes.caption)}`}`,
  renderer: RENDERER_ID,
}

/** Read the variables, form and parsed key of an expression item (for the grader). */
export function expressionFacts(item: Pick<ExerciseItem, 'payload' | 'key'>): { variables: string[]; form: Form; key: Expr | null } {
  const payload = obj(item.payload)
  const variables = strings(payload.variables)
  const parsed = parse(str(obj(item.key).answer), variables)
  return { variables, form: FORMS.find(f => f === payload.form) ?? 'any', key: parsed.ok ? parsed.expr : null }
}
