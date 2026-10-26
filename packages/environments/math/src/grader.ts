/**
 * Deterministic math grading. Numbers are compared with a tolerance; any
 * numeric expression the learner types (3/4, -0.5, sqrt(2)) is evaluated by
 * the safe parser. Expressions are right when they agree with the key as
 * functions (checked at seeded random points) and have the required form.
 * Answers equivalent to a listed buggy rule are reported as that
 * misconception. Feedback never states the key.
 * @module @hodos/math/grader
 */
import { uniformGrade, type GradeInput, type GradeResult, type JsonObject, type JsonValue } from '@hodos/plugin-sdk'
import { equivalent, evaluate, parse } from './expr.js'
import { expressionFacts, KIND, meetsForm } from './kinds.js'

/** Misconception ids for forms, with learner feedback. */
export const FORM_MISCONCEPTIONS: Readonly<Record<string, string>> = {
  'not-simplified': 'Equivalent — now combine like terms so it is as short as it can be.',
  'not-expanded': 'Equivalent — now multiply out the brackets.',
  'not-factored': 'Equivalent — now write it as a product of factors.',
}

/** Credit for an equivalent answer in the wrong form. */
export const FORM_CREDIT = 0.5

function obj(value: JsonValue | null | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** Read the learner's number: a typed text (any numeric expression) or a number. */
function readNumber(response: JsonValue): { value: number } | { problem: string } {
  const r = obj(response)
  if (typeof r.value === 'number' && Number.isFinite(r.value)) return { value: r.value }
  const raw = typeof r.text === 'string' ? r.text.trim() : ''
  // A single comma and no point is a decimal comma: 0,5.
  const text = /^[^.,]*,[^.,]*$/u.test(raw) ? raw.replace(',', '.') : raw
  if (text === '') return { problem: 'Type a number.' }
  const parsed = parse(text, [])
  if (!parsed.ok) return { problem: `I could not read that number: ${parsed.error}.` }
  const value = evaluate(parsed.expr, {})
  return Number.isFinite(value) ? { value } : { problem: 'That expression has no value.' }
}

function within(value: number, target: number, tolerance: JsonObject): boolean {
  const abs = typeof tolerance.abs === 'number' ? tolerance.abs : 1e-9
  const rel = typeof tolerance.rel === 'number' ? tolerance.rel : 1e-9
  return Math.abs(value - target) <= Math.max(abs, rel * Math.abs(target))
}

function gradeNumeric(input: GradeInput): GradeResult {
  const key = obj(input.key)
  const target = typeof key.value === 'number' ? key.value : Number.NaN
  const read = readNumber(input.response)
  if ('problem' in read) return uniformGrade(input.skills, 0, { feedback: read.problem })
  const tolerance = obj(key.tolerance)
  if (within(read.value, target, tolerance)) return uniformGrade(input.skills, 1, { feedback: 'Correct.' })
  const misconceptions = (Array.isArray(key.misconceptions) ? key.misconceptions : [])
    .map(obj)
    .filter(m => typeof m.value === 'number' && within(read.value, m.value, tolerance))
    .map(m => String(m.id))
  return uniformGrade(input.skills, 0, { misconceptions, feedback: 'Not quite.' })
}

function gradeExpression(input: GradeInput): GradeResult {
  const { variables, form, key } = expressionFacts(input)
  if (key === null) throw new Error('the item key does not parse')
  const text = obj(input.response).text
  const parsed = parse(typeof text === 'string' ? text : '', variables)
  if (!parsed.ok) return uniformGrade(input.skills, 0, { feedback: `I could not read that: ${parsed.error}.` })
  const verdict = equivalent(parsed.expr, key, variables)
  if (verdict === 'equivalent') {
    if (meetsForm(parsed.expr, key, form)) return uniformGrade(input.skills, 1, { feedback: 'Correct.' })
    return uniformGrade(input.skills, FORM_CREDIT, { correct: false, misconceptions: [`not-${form}`], feedback: FORM_MISCONCEPTIONS[`not-${form}`] ?? 'Equivalent, but not in the requested form.' })
  }
  if (verdict === 'undetermined') return uniformGrade(input.skills, 0, { feedback: 'That expression is undefined for most values; check it.' })
  const misconceptions: string[] = []
  const listed = obj(input.key).misconceptions
  for (const m of Array.isArray(listed) ? listed : []) {
    const wrong = parse(String(obj(m).expression), variables)
    if (wrong.ok && equivalent(parsed.expr, wrong.expr, variables) === 'equivalent') misconceptions.push(String(obj(m).id))
  }
  return uniformGrade(input.skills, 0, { misconceptions, feedback: 'Not equivalent to the expression asked for.' })
}

/**
 * Grade one response.
 * @param input - kind, key, response and skills.
 * @returns the grade.
 */
export function gradeMath(input: GradeInput): GradeResult {
  return input.kind === KIND.numeric ? gradeNumeric(input) : gradeExpression(input)
}
