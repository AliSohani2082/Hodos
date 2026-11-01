/**
 * The shipped courses: "Algebra: simplify, expand, factor" and "Algebra:
 * linear equations and slope". Hand-written; every key, form and buggy-rule
 * expression is checked by the kinds' validators, and lesson examples are not
 * exercise answers.
 * @module @hodos/math/content
 */
import type { ContentPack, CourseSpec, ExerciseItem, ExerciseMode, JsonObject, LessonSpec, SkillSpec } from '@hodos/plugin-sdk'
import { FORM_MISCONCEPTIONS } from './grader.js'
import { ENVIRONMENT, KIND, type Form } from './kinds.js'

/** Skill ids. */
export const SKILL = {
  simplify: 'alg.simplify',
  expand: 'alg.expand',
  factor: 'alg.factor',
  solve: 'alg.solve-linear',
  slope: 'alg.slope',
} as const

const P: readonly ExerciseMode[] = ['practice', 'review']
const C: readonly ExerciseMode[] = ['checkpoint']
const D: readonly ExerciseMode[] = ['diagnostic']

/** Feedback per misconception (none states an answer). */
const FEEDBACK: Readonly<Record<string, string>> = {
  'multiplied-variables': 'Adding x-terms adds their coefficients; the power of x stays the same.',
  'dropped-term': 'Every term counts, including a lone y or x (its coefficient is 1).',
  'sign-error': 'Check the signs: a minus in front of a term belongs to that term.',
  'partial-distribution': 'The outside factor multiplies every term inside the brackets.',
  'first-and-last-only': 'Multiply each term by each term: four products, including the two middle ones.',
  'freshmans-dream': '(a + b)² is not a² + b²: there is also a middle term 2ab.',
  'partial-factoring': 'Divide every term by the common factor.',
  'wrong-pair': 'The two numbers must multiply to the constant term and add up to the middle coefficient.',
  'square-of-difference': 'A difference of squares factors as (a − b)(a + b), not (a − b)².',
  'added-instead-of-subtracted': 'To undo adding a number, subtract it from both sides — and the other way round.',
  'subtracted-instead-of-added': 'To undo subtracting a number, add it to both sides.',
  'divided-instead-of-multiplied': 'To undo dividing by a number, multiply both sides by it.',
  'run-over-rise': 'Slope is rise over run: the change in y divided by the change in x.',
  'used-intercept': 'In y = mx + b the slope is m, the number in front of x; b is where the line crosses the y-axis.',
  ...FORM_MISCONCEPTIONS,
}

const RULE = {
  simplify: 'Add the x-terms together and the plain numbers together.',
  expand: 'Multiply every term inside the brackets by what is outside — or each term by each term.',
  factor: 'Look for a common factor, or two numbers that multiply to the constant and add to the middle coefficient.',
  solve: 'Undo the operations in reverse order: first the added or subtracted number, then the multiplication or division.',
  slope: 'Slope = rise ÷ run: the change in y divided by the change in x.',
} as const

interface ExpressionSpec {
  readonly id: string
  readonly skill: string
  readonly modes: readonly ExerciseMode[]
  readonly prompt: string
  readonly formula: string
  readonly form: Form
  readonly answer: string
  readonly misconceptions?: ReadonlyArray<readonly [string, string]>
  readonly variables?: readonly string[]
  readonly rule: string
  readonly explanation: string
  readonly difficulty?: number
}

function expression(spec: ExpressionSpec): ExerciseItem {
  return {
    id: spec.id,
    kind: KIND.expression,
    skills: [{ skillId: spec.skill, weight: 1 }],
    difficulty: spec.difficulty ?? 0,
    modes: [...spec.modes],
    payload: { prompt: spec.prompt, formula: spec.formula, variables: [...(spec.variables ?? ['x'])], form: spec.form },
    key: { answer: spec.answer, ...(spec.misconceptions === undefined ? {} : { misconceptions: spec.misconceptions.map(([e, id]) => ({ expression: e, id })) }) },
    hints: [{ level: 1, text: spec.rule }, { level: 5, text: `One correct answer: ${spec.answer}.` }],
    explanation: spec.explanation,
    misconceptionFeedback: { ...FEEDBACK },
    provenance: { source: 'authored' },
  }
}

interface NumericSpec {
  readonly id: string
  readonly skill: string
  readonly modes: readonly ExerciseMode[]
  readonly prompt: string
  readonly formula?: string
  readonly graph?: JsonObject
  readonly value: number
  readonly tolerance?: number
  readonly misconceptions?: ReadonlyArray<readonly [number, string]>
  readonly rule: string
  readonly step?: string
  readonly explanation: string
  readonly difficulty?: number
}

function numeric(spec: NumericSpec): ExerciseItem {
  return {
    id: spec.id,
    kind: KIND.numeric,
    skills: [{ skillId: spec.skill, weight: 1 }],
    difficulty: spec.difficulty ?? 0,
    modes: [...spec.modes],
    payload: { prompt: spec.prompt, ...(spec.formula === undefined ? {} : { formula: spec.formula }), ...(spec.graph === undefined ? {} : { graph: spec.graph }) },
    key: {
      value: spec.value,
      ...(spec.tolerance === undefined ? {} : { tolerance: { abs: spec.tolerance } }),
      ...(spec.misconceptions === undefined ? {} : { misconceptions: spec.misconceptions.map(([value, id]) => ({ value, id })) }),
    },
    hints: [{ level: 1, text: spec.rule }, ...(spec.step === undefined ? [] : [{ level: 2 as const, text: spec.step }]), { level: 5, text: `The answer is ${spec.value}.` }],
    explanation: spec.explanation,
    misconceptionFeedback: { ...FEEDBACK },
    provenance: { source: 'authored' },
  }
}

const SIMPLIFY = 'Simplify.'
const EXPAND = 'Expand and simplify.'
const FACTOR = 'Factor completely.'
const SOLVE = 'Solve for x.'
const SLOPE_POINTS = 'What is the slope of the line through the two marked points?'
const SLOPE_EQUATION = 'What is the slope of this line?'

const line = (x1: number, y1: number, x2: number, y2: number, x: [number, number], y: [number, number]): JsonObject => ({ x, y, points: [[x1, y1], [x2, y2]], lines: [[x1, y1, x2, y2]] })

const EXPRESSION_ITEMS: readonly ExerciseItem[] = [
  expression({ id: 'simp-1', skill: SKILL.simplify, modes: P, prompt: SIMPLIFY, formula: '3x + 2x', form: 'simplified', answer: '5x', misconceptions: [['5x^2', 'multiplied-variables']], rule: RULE.simplify, explanation: '3x + 2x = (3 + 2)x = 5x.', difficulty: -1 }),
  expression({ id: 'simp-2', skill: SKILL.simplify, modes: P, prompt: SIMPLIFY, formula: '4y - y + 2', form: 'simplified', answer: '3y + 2', variables: ['y'], misconceptions: [['4y + 2', 'dropped-term']], rule: RULE.simplify, explanation: '4y − y = 3y, and the 2 stays: 3y + 2.', difficulty: -0.5 }),
  expression({ id: 'simp-3', skill: SKILL.simplify, modes: P, prompt: SIMPLIFY, formula: '2x + 3 + 5x - 1', form: 'simplified', answer: '7x + 2', misconceptions: [['7x + 4', 'sign-error']], rule: RULE.simplify, explanation: '2x + 5x = 7x and 3 − 1 = 2: 7x + 2.', difficulty: 0 }),
  expression({ id: 'simp-c1', skill: SKILL.simplify, modes: C, prompt: SIMPLIFY, formula: '6x - 2x + 4', form: 'simplified', answer: '4x + 4', misconceptions: [['8x + 4', 'sign-error']], rule: RULE.simplify, explanation: '6x − 2x = 4x: 4x + 4.', difficulty: 0 }),
  expression({ id: 'simp-c2', skill: SKILL.simplify, modes: C, prompt: SIMPLIFY, formula: 'x + x + x', form: 'simplified', answer: '3x', misconceptions: [['x^3', 'multiplied-variables']], rule: RULE.simplify, explanation: 'Three x-terms make 3x.', difficulty: -0.5 }),
  expression({ id: 'simp-c3', skill: SKILL.simplify, modes: C, prompt: SIMPLIFY, formula: '5y + 2 - 3y + 1', form: 'simplified', answer: '2y + 3', variables: ['y'], misconceptions: [['8y + 3', 'sign-error']], rule: RULE.simplify, explanation: '5y − 3y = 2y and 2 + 1 = 3: 2y + 3.', difficulty: 0.3 }),
  expression({ id: 'simp-d1', skill: SKILL.simplify, modes: D, prompt: SIMPLIFY, formula: '2x + 4x', form: 'simplified', answer: '6x', rule: RULE.simplify, explanation: '2x + 4x = 6x.', difficulty: -1 }),

  expression({ id: 'exp-1', skill: SKILL.expand, modes: P, prompt: EXPAND, formula: '2(x + 3)', form: 'expanded', answer: '2x + 6', misconceptions: [['2x + 3', 'partial-distribution']], rule: RULE.expand, explanation: '2 · x + 2 · 3 = 2x + 6.', difficulty: -0.5 }),
  expression({ id: 'exp-2', skill: SKILL.expand, modes: P, prompt: EXPAND, formula: 'x(x + 4)', form: 'expanded', answer: 'x^2 + 4x', misconceptions: [['x^2 + 4', 'partial-distribution']], rule: RULE.expand, explanation: 'x · x + x · 4 = x² + 4x.', difficulty: 0 }),
  expression({ id: 'exp-3', skill: SKILL.expand, modes: P, prompt: EXPAND, formula: '(x + 1)(x + 2)', form: 'expanded', answer: 'x^2 + 3x + 2', misconceptions: [['x^2 + 2', 'first-and-last-only']], rule: RULE.expand, explanation: 'x² + 2x + x + 2 = x² + 3x + 2.', difficulty: 0.5 }),
  expression({ id: 'exp-c1', skill: SKILL.expand, modes: C, prompt: EXPAND, formula: '3(x - 2)', form: 'expanded', answer: '3x - 6', misconceptions: [['3x - 2', 'partial-distribution']], rule: RULE.expand, explanation: '3 · x − 3 · 2 = 3x − 6.', difficulty: 0 }),
  expression({ id: 'exp-c2', skill: SKILL.expand, modes: C, prompt: EXPAND, formula: '(x + 1)^2', form: 'expanded', answer: 'x^2 + 2x + 1', misconceptions: [['x^2 + 1', 'freshmans-dream']], rule: RULE.expand, explanation: '(x + 1)(x + 1) = x² + x + x + 1 = x² + 2x + 1.', difficulty: 0.6 }),
  expression({ id: 'exp-c3', skill: SKILL.expand, modes: C, prompt: EXPAND, formula: '(x - 3)(x + 3)', form: 'expanded', answer: 'x^2 - 9', misconceptions: [['x^2 + 9', 'sign-error']], rule: RULE.expand, explanation: 'x² + 3x − 3x − 9 = x² − 9.', difficulty: 0.5 }),
  expression({ id: 'exp-d1', skill: SKILL.expand, modes: D, prompt: EXPAND, formula: '4(x + 1)', form: 'expanded', answer: '4x + 4', rule: RULE.expand, explanation: '4 · x + 4 · 1 = 4x + 4.', difficulty: -0.5 }),

  expression({ id: 'fac-1', skill: SKILL.factor, modes: P, prompt: FACTOR, formula: '2x + 6', form: 'factored', answer: '2(x + 3)', misconceptions: [['2(x + 6)', 'partial-factoring']], rule: RULE.factor, explanation: 'Both terms share the factor 2: 2(x + 3).', difficulty: -0.5 }),
  expression({ id: 'fac-2', skill: SKILL.factor, modes: P, prompt: FACTOR, formula: 'x^2 + 5x + 6', form: 'factored', answer: '(x + 2)(x + 3)', misconceptions: [['(x + 1)(x + 6)', 'wrong-pair']], rule: RULE.factor, explanation: '2 · 3 = 6 and 2 + 3 = 5: (x + 2)(x + 3).', difficulty: 0.3 }),
  expression({ id: 'fac-3', skill: SKILL.factor, modes: P, prompt: FACTOR, formula: 'x^2 - 4', form: 'factored', answer: '(x - 2)(x + 2)', misconceptions: [['(x - 2)^2', 'square-of-difference']], rule: RULE.factor, explanation: 'A difference of squares: x² − 2² = (x − 2)(x + 2).', difficulty: 0.3 }),
  expression({ id: 'fac-c1', skill: SKILL.factor, modes: C, prompt: FACTOR, formula: '3x - 12', form: 'factored', answer: '3(x - 4)', misconceptions: [['3(x - 12)', 'partial-factoring']], rule: RULE.factor, explanation: 'Both terms share the factor 3: 3(x − 4).', difficulty: 0 }),
  expression({ id: 'fac-c2', skill: SKILL.factor, modes: C, prompt: FACTOR, formula: 'x^2 + 7x + 12', form: 'factored', answer: '(x + 3)(x + 4)', misconceptions: [['(x + 2)(x + 6)', 'wrong-pair']], rule: RULE.factor, explanation: '3 · 4 = 12 and 3 + 4 = 7: (x + 3)(x + 4).', difficulty: 0.5 }),
  expression({ id: 'fac-c3', skill: SKILL.factor, modes: C, prompt: FACTOR, formula: 'x^2 - 9', form: 'factored', answer: '(x - 3)(x + 3)', misconceptions: [['(x - 3)^2', 'square-of-difference']], rule: RULE.factor, explanation: 'A difference of squares: x² − 3² = (x − 3)(x + 3).', difficulty: 0.5 }),
  expression({ id: 'fac-d1', skill: SKILL.factor, modes: D, prompt: FACTOR, formula: '5x + 10', form: 'factored', answer: '5(x + 2)', rule: RULE.factor, explanation: 'Both terms share the factor 5: 5(x + 2).', difficulty: -0.5 }),
]

const LINE_ITEMS: readonly ExerciseItem[] = [
  numeric({ id: 'sol-1', skill: SKILL.solve, modes: P, prompt: SOLVE, formula: '2x + 3 = 11', value: 4, misconceptions: [[7, 'added-instead-of-subtracted']], rule: RULE.solve, step: 'First subtract 3 from both sides.', explanation: '2x = 11 − 3 = 8, so x = 8 ÷ 2 = 4.', difficulty: -0.5 }),
  numeric({ id: 'sol-2', skill: SKILL.solve, modes: P, prompt: SOLVE, formula: '5x - 4 = 16', value: 4, misconceptions: [[2.4, 'subtracted-instead-of-added']], rule: RULE.solve, step: 'First add 4 to both sides.', explanation: '5x = 16 + 4 = 20, so x = 4.', difficulty: 0 }),
  numeric({ id: 'sol-3', skill: SKILL.solve, modes: P, prompt: SOLVE, formula: 'x/3 = 5', value: 15, tolerance: 0.01, misconceptions: [[5 / 3, 'divided-instead-of-multiplied']], rule: RULE.solve, step: 'Multiply both sides by 3.', explanation: 'x = 5 · 3 = 15.', difficulty: 0 }),
  numeric({ id: 'sol-c1', skill: SKILL.solve, modes: C, prompt: SOLVE, formula: '3x + 7 = 1', value: -2, tolerance: 0.01, misconceptions: [[8 / 3, 'added-instead-of-subtracted']], rule: RULE.solve, explanation: '3x = 1 − 7 = −6, so x = −2.', difficulty: 0.3 }),
  numeric({ id: 'sol-c2', skill: SKILL.solve, modes: C, prompt: SOLVE, formula: '4x - 5 = 3x + 2', value: 7, misconceptions: [[-3, 'sign-error']], rule: RULE.solve, explanation: 'Subtract 3x from both sides: x − 5 = 2, so x = 7.', difficulty: 0.6 }),
  numeric({ id: 'sol-c3', skill: SKILL.solve, modes: C, prompt: SOLVE, formula: '2(x - 1) = 10', value: 6, misconceptions: [[5.5, 'partial-distribution']], rule: RULE.solve, explanation: '2x − 2 = 10, so 2x = 12 and x = 6 (or: x − 1 = 5).', difficulty: 0.5 }),
  numeric({ id: 'sol-d1', skill: SKILL.solve, modes: D, prompt: SOLVE, formula: 'x + 5 = 9', value: 4, misconceptions: [[14, 'added-instead-of-subtracted']], rule: RULE.solve, explanation: 'x = 9 − 5 = 4.', difficulty: -1 }),

  numeric({ id: 'slo-1', skill: SKILL.slope, modes: P, prompt: SLOPE_POINTS, graph: line(0, 1, 2, 5, [-1, 5], [-1, 7]), value: 2, misconceptions: [[0.5, 'run-over-rise']], rule: RULE.slope, step: 'From the left point to the right point, how far does y change, and how far does x change?', explanation: 'Rise 5 − 1 = 4 over run 2 − 0 = 2: slope 2.', difficulty: -0.3 }),
  numeric({ id: 'slo-2', skill: SKILL.slope, modes: P, prompt: SLOPE_POINTS, graph: line(1, 4, 3, 0, [-1, 5], [-1, 6]), value: -2, misconceptions: [[2, 'sign-error'], [-0.5, 'run-over-rise']], rule: RULE.slope, explanation: 'Rise 0 − 4 = −4 over run 3 − 1 = 2: slope −2 (the line falls).', difficulty: 0.2 }),
  numeric({ id: 'slo-3', skill: SKILL.slope, modes: P, prompt: SLOPE_EQUATION, formula: 'y = 3x - 2', value: 3, misconceptions: [[-2, 'used-intercept']], rule: RULE.slope, explanation: 'In y = mx + b the slope is m = 3.', difficulty: -0.5 }),
  numeric({ id: 'slo-c1', skill: SKILL.slope, modes: C, prompt: SLOPE_POINTS, graph: line(-1, -1, 1, 3, [-3, 3], [-3, 5]), value: 2, misconceptions: [[0.5, 'run-over-rise']], rule: RULE.slope, explanation: 'Rise 3 − (−1) = 4 over run 1 − (−1) = 2: slope 2.', difficulty: 0.2 }),
  numeric({ id: 'slo-c2', skill: SKILL.slope, modes: C, prompt: SLOPE_POINTS, graph: line(0, 6, 3, 0, [-1, 5], [-1, 7]), value: -2, misconceptions: [[2, 'sign-error']], rule: RULE.slope, explanation: 'Rise 0 − 6 = −6 over run 3: slope −2.', difficulty: 0.3 }),
  numeric({ id: 'slo-c3', skill: SKILL.slope, modes: C, prompt: SLOPE_EQUATION, formula: 'y = -x/2 + 4', value: -0.5, tolerance: 0.001, misconceptions: [[4, 'used-intercept']], rule: RULE.slope, explanation: 'y = −x/2 + 4 = −0.5x + 4, so the slope is −0.5.', difficulty: 0.5 }),
  numeric({ id: 'slo-d1', skill: SKILL.slope, modes: D, prompt: SLOPE_POINTS, graph: line(0, 0, 1, 1, [-2, 3], [-2, 3]), value: 1, rule: RULE.slope, explanation: 'Rise 1 over run 1: slope 1.', difficulty: -0.5 }),
]

const check = (question: string, options: readonly string[], answer: number, explain: string): string =>
  `{% check question="${question}" options=[${options.map((o, i) => `{id: "${String.fromCharCode(97 + i)}", text: "${o}"}`).join(', ')}] answer="${String.fromCharCode(97 + answer)}" explain="${explain}" /%}`

const EXPRESSION_LESSONS: readonly LessonSpec[] = [
  {
    id: 'alg-simplify', skillId: SKILL.simplify, title: 'Combining like terms',
    source: `# Combining like terms

Terms with the same letter part are *like terms*; add their numbers and keep the letter.

{% math-formula expr="5x + 3x = 8x" variables=["x"] /%}

{% callout kind="key-idea" title="Same letter, same power" %}
Add the coefficients; the power of x does not change. Plain numbers combine with plain numbers.
{% /callout %}

${check('Which is 4x + 3x simplified?', ['7x', '7x^2', '12x'], 0, 'Add the coefficients: 4 + 3 = 7, so 7x.')}
`,
  },
  {
    id: 'alg-expand', skillId: SKILL.expand, title: 'Expanding brackets',
    source: `# Expanding brackets

The factor in front of a bracket multiplies **every** term inside it.

{% math-formula expr="2(x + 4) = 2x + 8" variables=["x"] /%}

{% worked-example title="Two brackets" %}
Multiply each term by each term, then combine like terms:

{% math-formula expr="(x + 1)(x + 3) = x^2 + 3x + x + 3 = x^2 + 4x + 3" variables=["x"] /%}
{% /worked-example %}

${check('Expand 3(x + 2).', ['3x + 6', '3x + 2'], 0, 'The 3 multiplies both terms: 3x + 6.')}
`,
  },
  {
    id: 'alg-factor', skillId: SKILL.factor, title: 'Factoring',
    source: `# Factoring

Factoring undoes expanding: write the expression as a product.

- A **common factor**: 4x + 8 = 4(x + 2).
- A **quadratic** x² + bx + c: find two numbers that multiply to c and add to b.

{% math-formula expr="x^2 + 6x + 8 = (x + 2)(x + 4)" variables=["x"] /%}

{% callout kind="tip" title="Difference of squares" %}
x² − a² = (x − a)(x + a), for example x² − 16 = (x − 4)(x + 4).
{% /callout %}

${check('Factor x^2 + 4x + 3.', ['(x + 1)(x + 3)', '(x + 2)(x + 2)'], 0, '1 · 3 = 3 and 1 + 3 = 4.')}
`,
  },
]

const LINE_LESSONS: readonly LessonSpec[] = [
  {
    id: 'alg-solve', skillId: SKILL.solve, title: 'Solving linear equations',
    source: `# Solving linear equations

Do the same thing to both sides, undoing the operations in reverse order.

{% worked-example title="3x + 4 = 19" %}
1. Subtract 4 from both sides: 3x = 15.
2. Divide both sides by 3: x = 5.
{% /worked-example %}

${check('Solve x - 2 = 5.', ['7', '3'], 0, 'Add 2 to both sides: x = 7.')}
`,
  },
  {
    id: 'alg-slope', skillId: SKILL.slope, title: 'Slope',
    source: `# Slope

The slope says how steep a line is: how much y changes when x increases by 1 — **rise over run**.

{% math-graph x=[-3, 4] y=[-4, 6] functions=[{expr: "2x - 1", label: "y = 2x - 1"}] points=[[0, -1], [1, 1]] caption="From (0, −1) to (1, 1): rise 2, run 1, slope 2." /%}

In an equation y = mx + b the slope is **m** and the line crosses the y-axis at **b**.

{% math-formula expr="y = 2x - 1" variables=["x", "y"] /%}

${check('What is the slope of y = 4x + 1?', ['4', '1'], 0, 'The slope is the number in front of x.')}
`,
  },
]

const EXPRESSION_SKILLS: readonly SkillSpec[] = [
  { id: SKILL.simplify, title: 'Combining like terms', kind: 'procedure', environment: ENVIRONMENT, description: 'Simplify sums by combining like terms.' },
  { id: SKILL.expand, title: 'Expanding brackets', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.simplify], description: 'Multiply out one or two brackets.' },
  { id: SKILL.factor, title: 'Factoring', kind: 'procedure', environment: ENVIRONMENT, requires: [SKILL.expand], description: 'Common factors, simple quadratics and differences of squares.' },
]

const LINE_SKILLS: readonly SkillSpec[] = [
  { id: SKILL.solve, title: 'Solving linear equations', kind: 'procedure', environment: ENVIRONMENT, description: 'Equations like 2x + 3 = 11.' },
  { id: SKILL.slope, title: 'Slope', kind: 'concept', environment: ENVIRONMENT, requires: [SKILL.solve], description: 'Rise over run, from a graph or an equation.' },
]

/** "Algebra: simplify, expand, factor". */
export function expressionsCourse(): CourseSpec {
  return {
    id: 'algebra-expressions', version: '1.0.0',
    title: 'Algebra: simplify, expand, factor',
    description: 'Combine like terms, multiply out brackets and factor simple quadratics.',
    keywords: ['algebra', 'math', 'maths', 'expressions', 'simplify', 'expand', 'brackets', 'factor', 'factoring', 'quadratic'],
    language: 'en', goal: SKILL.factor, environments: [ENVIRONMENT], preset: 'math-practice@1',
    skills: EXPRESSION_SKILLS, lessons: EXPRESSION_LESSONS, items: EXPRESSION_ITEMS,
  }
}

/** "Algebra: linear equations and slope". */
export function linesCourse(): CourseSpec {
  return {
    id: 'algebra-lines', version: '1.0.0',
    title: 'Algebra: linear equations and slope',
    description: 'Solve linear equations and read the slope of a line from a graph or an equation.',
    keywords: ['algebra', 'math', 'maths', 'equations', 'linear', 'solve', 'slope', 'graph', 'lines', 'gradient'],
    language: 'en', goal: SKILL.slope, environments: [ENVIRONMENT], preset: 'math-practice@1',
    skills: LINE_SKILLS, lessons: LINE_LESSONS, items: LINE_ITEMS,
  }
}

/** The content pack registered by the plugin. */
export function mathPack(): ContentPack {
  return { id: 'algebra-basics', version: '1.0.0', title: 'Algebra basics', courses: [expressionsCourse(), linesCourse()] }
}
