import { describe, expect, it } from 'vitest'
import type { ExerciseItem, GradeInput, JsonObject } from '@hodos/plugin-sdk'
import { equivalent, evaluate, expressionsCourse, FORM_CREDIT, gradeMath, KIND, KINDS, linesCourse, meetsForm, parse, serializeMath, toMathTree, toText, type Expr } from '../src/index.js'
import { LIMITS } from '../src/expr.js'

function ok(text: string, variables: readonly string[] = ['x']): Expr {
  const result = parse(text, variables)
  if (!result.ok) throw new Error(`${text}: ${result.error}`)
  return result.expr
}

const at = (text: string, x: number): number => evaluate(ok(text), { x })
const courses = [expressionsCourse(), linesCourse()]
const items = courses.flatMap(c => c.items)
const item = (id: string): ExerciseItem => {
  const found = items.find(i => i.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}
const kind = (id: string) => {
  const found = KINDS.find(k => k.id === id)
  if (found === undefined) throw new Error(`no kind ${id}`)
  return found
}
const input = (entry: ExerciseItem, response: JsonObject): GradeInput => ({ kind: entry.kind, payload: entry.payload, key: entry.key, response, mode: 'practice', skills: entry.skills, attempt: 1 })
const errors = (entry: ExerciseItem): string[] => (kind(entry.kind).validateItem?.(entry) ?? []).filter(d => d.severity === 'error').map(d => d.code)

describe('parsing', () => {
  it('follows the usual precedence, with implicit multiplication', () => {
    expect(at('2 + 3x', 2)).toBe(8)
    expect(at('2x^2', 3)).toBe(18)
    expect(at('-x^2', 3)).toBe(-9)
    expect(at('2^3^2', 0)).toBe(512)
    expect(at('3(x + 1)', 1)).toBe(6)
    expect(at('(x + 1)(x - 1)', 3)).toBe(8)
    expect(at('x^-1', 4)).toBe(0.25)
    expect(evaluate(ok('xy', ['x', 'y']), { x: 2, y: 5 })).toBe(10)
  })

  it('understands what learners type', () => {
    expect(at('2×x − 1', 3)).toBe(5)
    expect(at('x² ÷ 2', 4)).toBe(8)
    expect(at('2π', 0)).toBeCloseTo(2 * Math.PI)
    expect(at('e^1', 0)).toBeCloseTo(Math.E)
    expect(at('sqrt(x) + abs(-2)', 9)).toBe(5)
    expect(at('x**2', 3)).toBe(9)
  })

  it('reports errors in words', () => {
    expect(parse('2y', ['x'])).toEqual({ ok: false, error: 'unknown symbol "y"' })
    expect(parse('(x + 1', ['x'])).toEqual({ ok: false, error: 'a parenthesis is not closed' })
    expect(parse('x +', ['x'])).toEqual({ ok: false, error: 'the expression ends too early' })
    const sqrt = parse('sqrt x', ['x'])
    expect(sqrt.ok ? '' : sqrt.error).toContain('needs parentheses')
    expect(parse('', ['x'])).toEqual({ ok: false, error: 'the expression is empty' })
    expect(parse('2 $ 3', [])).toMatchObject({ ok: false })
  })

  it('stays bounded on hostile input', () => {
    const long = parse('x'.repeat(LIMITS.maxLength + 1), ['x'])
    expect(long.ok ? '' : long.error).toContain('longer')
    expect(parse(`${'('.repeat(100)}x${')'.repeat(100)}`, ['x'])).toEqual({ ok: false, error: 'the expression is nested too deeply' })
    // 250 letters multiply implicitly: 499 nodes.
    expect(parse('x'.repeat(250), ['x'])).toEqual({ ok: false, error: 'the expression is too large' })
    expect(parse('-'.repeat(200) + 'x', ['x'])).toEqual({ ok: false, error: 'the expression is nested too deeply' })
  })

  it('evaluates outside the domain as NaN, never throwing', () => {
    expect(at('1/(x - 2)', 2)).toBeNaN()
    expect(at('sqrt(x)', -1)).toBeNaN()
    expect(at('ln(x)', 0)).toBeNaN()
  })
})

describe('equivalence and form', () => {
  it('compares expressions as functions', () => {
    expect(equivalent(ok('(x + 1)^2'), ok('x^2 + 2x + 1'), ['x'])).toBe('equivalent')
    expect(equivalent(ok('x^2 + 1'), ok('(x + 1)^2'), ['x'])).toBe('different')
    expect(equivalent(ok('x/x'), ok('1'), ['x'])).toBe('equivalent')
    expect(equivalent(ok('sqrt(x^2)'), ok('x'), ['x'])).toBe('different')
    expect(equivalent(ok('ln(-x^2 - 1)'), ok('1'), ['x'])).toBe('undetermined')
    expect(equivalent(ok('2(y + 1)', ['y']), ok('2y + 2', ['y']), ['y'])).toBe('equivalent')
  })

  it('checks the requested form', () => {
    expect(meetsForm(ok('x^2 + 2x + 1'), ok('x^2 + 2x + 1'), 'expanded')).toBe(true)
    expect(meetsForm(ok('(x + 1)^2'), ok('x^2 + 2x + 1'), 'expanded')).toBe(false)
    expect(meetsForm(ok('2(x + 3)'), ok('2(x + 3)'), 'factored')).toBe(true)
    expect(meetsForm(ok('2x + 6'), ok('2(x + 3)'), 'factored')).toBe(false)
    expect(meetsForm(ok('3x + 2x'), ok('5x'), 'simplified')).toBe(false)
    expect(meetsForm(ok('x5'), ok('5x'), 'simplified')).toBe(true)
  })

  it('does not take a wrapped copy of the formula as factored or expanded', () => {
    const factoredKey = ok('(x + 2)(x + 3)')
    for (const answer of ['(x + 2)(x + 3)', '(x+3)(x+2)', '-(-x - 2)(x + 3)', '(2x + 4)(0.5x + 1.5)']) expect(meetsForm(ok(answer), factoredKey, 'factored'), answer).toBe(true)
    expect(meetsForm(ok('(x + 1)^2'), ok('(x + 1)^2'), 'factored')).toBe(true)
    expect(meetsForm(ok('x(x + 4)'), ok('x(x + 4)'), 'factored')).toBe(true)
    expect(meetsForm(ok('-2(x + 3)'), ok('-2(x + 3)'), 'factored')).toBe(true)
    for (const answer of ['1(x^2 + 5x + 6)', '(x^2 + 5x + 6)^1', '1*(x^2 + 5x + 6)*1', '(x^2 + 5x + 6)(x - x + 1)', '-(-(x^2 + 5x + 6))', '2((x^2 + 5x + 6)/2)', '2(0.5x^2 + 2.5x + 3)', 'sqrt(x^2 + 5x + 6)^2', '(x^2 + 5x + 6)/(x/x)']) {
      expect(meetsForm(ok(answer), factoredKey, 'factored'), answer).toBe(false)
    }
    const expandedKey = ok('x^2 + 3x + 2')
    for (const answer of ['x^2 + 3x + 2', 'x*x + 3x + 2', '2 + 3x + x^2', 'x^2/1 + 3x + 2']) expect(meetsForm(ok(answer), expandedKey, 'expanded'), answer).toBe(true)
    for (const answer of ['(x + 1)/(1/(x + 2))', '(x + 1)(x + 2)', '-(-x - 1)(x + 2)', '(x^2 + 3x + 2)^1', '(2x^2 + 6x + 4)/2', 'abs(x + 1)^2 + x + 1', 'exp(ln(x^2 + 3x + 2))']) {
      expect(meetsForm(ok(answer), expandedKey, 'expanded'), answer).toBe(false)
    }
    // A key that is not a polynomial keeps the syntactic check.
    expect(meetsForm(ok('(e^x - 1)(e^x + 1)'), ok('(e^x - 1)(e^x + 1)'), 'factored')).toBe(true)
  })
})

describe('presenting', () => {
  it('writes plain text with only the parentheses it needs', () => {
    expect(toText(ok('2x^2 + 3x - 1'))).toBe('2x^2 + 3x - 1')
    expect(toText(ok('(x + 1)(x - 1)'))).toBe('(x + 1) · (x - 1)')
    expect(toText(ok('x - (x + 1)'))).toBe('x - (x + 1)')
  })

  it('builds MathML trees', () => {
    expect(serializeMath(toMathTree(ok('x^2/2')))).toBe('<math display="inline"><mfrac><msup><mi>x</mi><mn>2</mn></msup><mn>2</mn></mfrac></math>')
    expect(serializeMath(toMathTree(ok('sqrt(x)')))).toBe('<math display="inline"><msqrt><mi>x</mi></msqrt></math>')
  })
})

describe('grading', () => {
  it('reads numbers in several forms and checks them with the tolerance', () => {
    expect(gradeMath(input(item('sol-1'), { text: '4' })).correct).toBe(true)
    expect(gradeMath(input(item('sol-1'), { text: '8/2' })).correct).toBe(true)
    expect(gradeMath(input(item('slo-c3'), { text: '-1/2' })).correct).toBe(true)
    expect(gradeMath(input(item('slo-c3'), { text: '-0,5' })).correct).toBe(true)
    expect(gradeMath(input(item('sol-1'), { value: 4 })).correct).toBe(true)
    expect(gradeMath(input(item('sol-3'), { text: '15.004' })).correct).toBe(true)
  })

  it('names the mistake behind a wrong number', () => {
    expect(gradeMath(input(item('sol-1'), { text: '7' })).misconceptions).toEqual(['added-instead-of-subtracted'])
    expect(gradeMath(input(item('sol-3'), { text: '1.67' })).misconceptions).toEqual(['divided-instead-of-multiplied'])
    expect(gradeMath(input(item('slo-1'), { text: '0.5' })).misconceptions).toEqual(['run-over-rise'])
    const unreadable = gradeMath(input(item('sol-1'), { text: 'four' }))
    expect(unreadable.correct).toBe(false)
    expect(unreadable.feedback).toContain('could not read')
  })

  it('accepts any equivalent expression in the requested form', () => {
    expect(gradeMath(input(item('exp-c2'), { text: '1 + 2x + x^2' })).correct).toBe(true)
    const unexpanded = gradeMath(input(item('exp-c2'), { text: '(x + 1)(x + 1)' }))
    expect(unexpanded).toMatchObject({ correct: false, score: FORM_CREDIT, misconceptions: ['not-expanded'] })
    expect(gradeMath(input(item('exp-c2'), { text: 'x^2 + 1' })).misconceptions).toEqual(['freshmans-dream'])
    expect(gradeMath(input(item('fac-2'), { text: '(x+3)(x+2)' })).correct).toBe(true)
    expect(gradeMath(input(item('fac-2'), { text: 'x^2 + 5x + 6' })).misconceptions).toEqual(['not-factored'])
    // Wrapping the formula is not factoring or expanding it (and earns no more than the equivalent-form credit).
    for (const [id, text] of [['fac-2', '1(x^2 + 5x + 6)'], ['fac-c2', '(x^2 + 7x + 12)^1'], ['fac-c3', '1*(x^2 - 9)'], ['exp-3', '(x + 1)/(1/(x + 2))'], ['exp-c3', '(x - 3)/(1/(x + 3))']] as const) {
      expect(gradeMath(input(item(id), { text })), `${id}: ${text}`).toMatchObject({ correct: false, score: FORM_CREDIT })
    }
    expect(gradeMath(input(item('simp-1'), { text: '3x + 2x' })).misconceptions).toEqual(['not-simplified'])
    expect(gradeMath(input(item('simp-1'), { text: 'y' })).feedback).toContain('could not read')
  })

  it('never states the answer in feedback', () => {
    for (const entry of items.filter(i => i.kind === KIND.expression)) {
      const answer = (entry.key as JsonObject).answer
      if (typeof answer !== 'string') throw new Error(`${entry.id} has no answer`)
      for (const text of ['x', '', 'x^2 + 99', '((']) {
        expect(gradeMath(input(entry, { text })).feedback ?? '', entry.id).not.toContain(answer)
      }
    }
  })
})

describe('items and validation', () => {
  it('has only valid items and covers every skill', () => {
    for (const entry of items) expect(errors(entry), entry.id).toEqual([])
    for (const course of courses) {
      for (const skill of course.skills) {
        const of = (mode: string): number => course.items.filter(i => i.skills.some(s => s.skillId === skill.id) && i.modes.some(m => m === mode)).length
        expect(of('practice'), skill.id).toBeGreaterThanOrEqual(3)
        expect(of('checkpoint'), skill.id).toBeGreaterThanOrEqual(3)
        expect(of('diagnostic'), skill.id).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('catches broken items', () => {
    const exp = item('exp-c2')
    const key = exp.key as JsonObject
    expect(errors({ ...exp, key: { ...key, answer: '(x + 1)^2' } })).toContain('math/answer-form')
    expect(errors({ ...exp, key: { ...key, misconceptions: [{ expression: '1 + 2x + x^2', id: 'oops' }] } })).toContain('math/misconception')
    expect(errors({ ...exp, payload: { ...(exp.payload as JsonObject), formula: 'x^2 + 2x + 1' } })).toContain('math/formula-is-answer')
    expect(errors({ ...exp, key: { ...key, answer: 'x^2 +' } })).toContain('math/answer')
    // A key that is not the formula rewritten, in the right form, would mark right answers wrong.
    expect(errors({ ...exp, key: { ...key, answer: 'x^2 + x + 1' } })).toContain('math/answer-not-equivalent')
    const num = item('slo-1')
    expect(errors({ ...num, payload: { ...(num.payload as JsonObject), graph: { x: [5, -1], y: [0, 1] } } })).toContain('math/graph-range')
    expect(errors({ ...num, key: { value: 2, misconceptions: [{ value: 2, id: 'same' }] } })).toContain('math/misconception-value')
  })

  it('shows every exercise as plain text', () => {
    for (const entry of items) expect(kind(entry.kind).fallbackText(entry.payload).length, entry.id).toBeGreaterThan(10)
    expect(kind(KIND.numeric).fallbackText(item('slo-1').payload)).toContain('a line through (0, 1) and (2, 5)')
  })
})
