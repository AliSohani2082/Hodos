/**
 * A small deterministic environment plugin used by the core tests: choice,
 * free-text and stepwise exercise kinds, one lesson block, and a three-skill
 * arithmetic course. Options switch on misbehaviour for security tests.
 */
import {
  CORE_PLUGIN_API_VERSION,
  SDK_VERSION,
  type ContentPack,
  type CourseSpec,
  type ExerciseItem,
  type ExerciseMode,
  type GradeInput,
  type GradeResult,
  type GradingMethod,
  type HodosEnvironmentManifest,
  type HodosEnvironmentPlugin,
  type JsonObject,
  type JsonValue,
  type StepInput,
  type StepResult,
} from '@hodos/plugin-sdk'

/** Misbehaviour switches for security tests. */
export interface QuizOptions {
  /** Grader feedback quotes the answer key. */
  readonly leakFeedback?: boolean
  /** Grader throws an error whose message contains the key. */
  readonly throwWithKey?: boolean
  /** Grader returns a malformed result. */
  readonly malformed?: boolean
  /** Grader claims evidence for a skill the item is not tagged with. */
  readonly foreignSkill?: boolean
  /** Grading method reported by the grader. */
  readonly method?: GradingMethod
  /** Plugin id (to register several copies). */
  readonly id?: string
}

export const QUIZ_ENV = 'quiz.card'

function obj(value: JsonValue): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

function result(input: GradeInput, correct: boolean, score: number, misconceptions: string[], feedback?: string): GradeResult {
  return {
    score,
    correct,
    skillEvidence: input.skills.map(s => ({ skillId: s.skillId, score })),
    misconceptions,
    ...(feedback === undefined ? {} : { feedback }),
  }
}

function keyText(key: JsonObject): string {
  return typeof key.answer === 'string' ? key.answer : typeof key.correct === 'string' ? key.correct : JSON.stringify(key)
}

/**
 * Build the quiz plugin.
 * @param options - misbehaviour switches.
 * @returns the plugin.
 */
export function createQuizPlugin(options: QuizOptions = {}): HodosEnvironmentPlugin {
  const id = options.id ?? 'hodos-quiz'
  const manifest: HodosEnvironmentManifest = {
    id,
    version: '1.0.0',
    displayName: 'Quiz (test fixture)',
    requiresCore: `^${CORE_PLUGIN_API_VERSION}`,
    sdkVersion: SDK_VERSION,
    license: 'MIT',
    capabilities: {
      environments: [QUIZ_ENV],
      exerciseKinds: ['quiz.choice', 'quiz.text', 'quiz.sequence'],
      graders: ['quiz.grader'],
      lessonBlocks: ['quiz-note'],
      contentPacks: ['quiz-pack'],
    },
  }
  const grade = (input: GradeInput): GradeResult => {
    const key = obj(input.key)
    const response = obj(input.response)
    if (options.throwWithKey === true) throw new Error(`cannot grade: expected ${keyText(key)}`)
    if (options.malformed === true) return { score: 2, correct: 'yes' } as unknown as GradeResult
    let correct: boolean
    let misconception: string | undefined
    if (input.kind === 'quiz.choice') {
      correct = response.choice === key.correct
      const map = obj(key.misconceptions ?? null)
      const m = typeof response.choice === 'string' ? map[response.choice] : undefined
      misconception = typeof m === 'string' ? m : undefined
    } else {
      const given = typeof response.text === 'string' ? normalize(response.text) : ''
      const accepted = [key.answer, ...(Array.isArray(key.accept) ? key.accept : [])].filter((a): a is string => typeof a === 'string').map(normalize)
      correct = accepted.includes(given)
    }
    const out = result(input, correct, correct ? 1 : 0, misconception === undefined ? [] : [misconception],
      options.leakFeedback === true ? `The answer is ${keyText(key)}.` : correct ? 'Correct!' : 'Not quite.')
    if (options.foreignSkill === true) return { ...out, skillEvidence: [...out.skillEvidence, { skillId: 'quiz.unrelated', score: 1 }] }
    return out
  }
  const step = (input: StepInput): StepResult => {
    const steps = Array.isArray(obj(input.key).steps) ? (obj(input.key).steps as JsonValue[]).filter((s): s is string => typeof s === 'string') : []
    const entered = Array.isArray(obj(input.progress ?? null).entered) ? (obj(input.progress ?? null).entered as JsonValue[]).filter((s): s is string => typeof s === 'string') : []
    const token = obj(input.response).token
    const expected = steps[entered.length]
    if (typeof token !== 'string' || expected === undefined || normalize(token) !== normalize(expected)) {
      const score = steps.length === 0 ? 0 : entered.length / steps.length
      return { status: 'complete', progress: { entered }, grade: result(input, false, score, [], 'That step does not work.') }
    }
    const next = [...entered, expected]
    if (next.length === steps.length) return { status: 'complete', progress: { entered: next }, grade: result(input, true, 1, [], 'Sequence complete.') }
    return { status: 'continue', progress: { entered: next }, message: 'Good. Next step?' }
  }
  return {
    manifest,
    register(ctx) {
      ctx.registerGrader({ id: 'quiz.grader', kinds: ['quiz.choice', 'quiz.text', 'quiz.sequence'], method: options.method ?? 'deterministic', grade, step })
      ctx.registerExerciseKind({
        id: 'quiz.choice',
        title: 'Multiple choice',
        environment: QUIZ_ENV,
        responseKind: 'choice',
        interaction: 'single',
        grader: 'quiz.grader',
        format: { guessable: true, options: 4 },
        payloadSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['prompt', 'options'],
          properties: {
            prompt: { type: 'string' },
            options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } },
            authorNote: { type: 'string', 'x-visibility': 'server' },
          },
        },
        keySchema: {
          type: 'object',
          additionalProperties: false,
          required: ['correct'],
          properties: { correct: { type: 'string' }, misconceptions: { type: 'object', additionalProperties: { type: 'string' } } },
        },
        responseSchema: { type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { type: 'string', maxLength: 64 } } },
        validateItem: item => {
          const payload = obj(item.payload)
          const options = Array.isArray(payload.options) ? payload.options.map(o => obj(o).id) : []
          return options.includes(obj(item.key).correct ?? null) ? [] : [{ severity: 'error', code: 'quiz/key', message: 'the correct option is not one of the options' }]
        },
        fallbackText: payload => {
          const p = obj(payload)
          const options = Array.isArray(p.options) ? p.options.map(o => `(${String(obj(o).id)}) ${String(obj(o).text)}`) : []
          return `${String(p.prompt)}\n${options.join('\n')}`
        },
        reveal: item => ({ correct: obj(item.key).correct ?? null }),
      })
      ctx.registerExerciseKind({
        id: 'quiz.text',
        title: 'Short answer',
        environment: QUIZ_ENV,
        responseKind: 'text',
        interaction: 'single',
        grader: 'quiz.grader',
        format: { guessable: false },
        payloadSchema: { type: 'object', additionalProperties: false, required: ['prompt'], properties: { prompt: { type: 'string' } } },
        keySchema: {
          type: 'object',
          additionalProperties: false,
          required: ['answer'],
          properties: { answer: { type: 'string', minLength: 1 }, accept: { type: 'array', items: { type: 'string' } } },
        },
        responseSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 200 } } },
        fallbackText: payload => String(obj(payload).prompt),
        reveal: item => ({ answer: obj(item.key).answer ?? null }),
      })
      ctx.registerExerciseKind({
        id: 'quiz.sequence',
        title: 'Sequence',
        environment: QUIZ_ENV,
        responseKind: 'text',
        interaction: 'stepwise',
        grader: 'quiz.grader',
        format: { guessable: false },
        payloadSchema: { type: 'object', additionalProperties: false, required: ['prompt', 'length'], properties: { prompt: { type: 'string' }, length: { type: 'integer' } } },
        keySchema: { type: 'object', additionalProperties: false, required: ['steps'], properties: { steps: { type: 'array', minItems: 1, items: { type: 'string' } } } },
        responseSchema: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', maxLength: 64 } } },
        fallbackText: payload => `${String(obj(payload).prompt)} (${String(obj(payload).length)} steps)`,
      })
      ctx.registerLessonBlock({
        name: 'quiz-note',
        version: 1,
        kind: 'leaf',
        attributes: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'text'],
          properties: { id: { type: 'string' }, text: { type: 'string', maxLength: 300 }, secret: { type: 'string', 'x-visibility': 'server' } },
        },
        guidance: { when: 'a short aside', syntax: '{% quiz-note text="..." /%}' },
        fallbackText: node => `Note: ${String(node.attributes.text)}`,
      })
      ctx.registerContentPack(quizPack())
    },
  }
}

/** The three skills of the quiz course. */
export const QUIZ_SKILLS = ['quiz.add', 'quiz.mul', 'quiz.mixed'] as const

interface Sum { readonly a: number; readonly b: number; readonly op: '+' | '×' | 'mix' }

function value(s: Sum): number {
  return s.op === '+' ? s.a + s.b : s.op === '×' ? s.a * s.b : s.a + s.b * 2
}

function prompt(s: Sum): string {
  return s.op === 'mix' ? `What is ${s.a} + ${s.b} × 2?` : `What is ${s.a} ${s.op} ${s.b}?`
}

function choiceItem(id: string, skillId: string, s: Sum, modes: ExerciseMode[], difficulty: number): ExerciseItem {
  const right = value(s)
  const wrong = [right + 1, right - 1, s.op === 'mix' ? (s.a + s.b) * 2 : right + 10]
  const all = [right, ...wrong]
  const letters = ['a', 'b', 'c', 'd']
  // Deterministic order that varies by item.
  const shift = id.length % 4
  const ordered = all.map((_, i) => all[(i + shift) % 4] ?? right)
  const correct = letters[ordered.indexOf(right)] ?? 'a'
  const mix = s.op === 'mix' ? letters[ordered.indexOf((s.a + s.b) * 2)] : undefined
  return {
    id,
    kind: 'quiz.choice',
    isomorphGroup: `${skillId}-${s.op}-${Math.min(s.a, s.b)}`,
    skills: [{ skillId, weight: 1 }],
    difficulty,
    modes,
    payload: {
      prompt: prompt(s),
      options: ordered.map((v, i) => ({ id: letters[i] ?? 'a', text: String(v) })),
      authorNote: `internal-note-${id}`,
    },
    key: { correct, ...(mix === undefined ? {} : { misconceptions: { [mix]: 'left-to-right' } }) },
    hints: [
      { level: 1, text: `Hint one for ${id}: what does the operation mean?` },
      { level: 2, text: `Hint two for ${id}: work it out step by step.` },
      { level: 3, text: `Hint three for ${id}: try a smaller example first.` },
      { level: 4, text: `Hint four for ${id}: partial work shown here.` },
      { level: 5, text: `Hint five for ${id}: the result is option ${correct}.` },
    ],
    explanation: `Worked explanation for ${id}: the result is ${right}.`,
    misconceptionFeedback: { 'left-to-right': 'Multiplication comes before addition.' },
    provenance: { source: 'authored', verifiedBy: ['test'] },
  }
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** English words for 0..199, so text answers are long enough for the leak guard. */
export function spell(n: number): string {
  if (n >= 100) return `one hundred${n === 100 ? '' : ` ${spell(n - 100)}`}`
  if (n < 20) return ONES[n] ?? String(n)
  const tens = TENS[Math.floor(n / 10)] ?? ''
  return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10] ?? ''}`
}

function textItem(id: string, skillId: string, s: Sum, modes: ExerciseMode[], answer?: string): ExerciseItem {
  return {
    id,
    kind: 'quiz.text',
    skills: [{ skillId, weight: 1 }],
    difficulty: 0.3,
    modes,
    payload: { prompt: `${prompt(s)} Type the number in words.` },
    key: { answer: answer ?? spell(value(s)), accept: [String(value(s))] },
    hints: [{ level: 1, text: `Text hint for ${id}.` }],
    explanation: `Text explanation for ${id}.`,
  }
}

function itemsFor(skillId: string, op: Sum['op']): ExerciseItem[] {
  const short = skillId.split('.')[1] ?? skillId
  const sums: Sum[] = [2, 3, 4, 5, 6, 7, 8, 9, 11].map((a, i) => ({ a, b: i + 2, op }))
  const at = (i: number): Sum => sums[i] ?? { a: 1, b: 1, op }
  return [
    ...[0, 1, 2, 3, 4].map(i => choiceItem(`${short}-p${i + 1}`, skillId, at(i), ['practice', 'review'], -0.5 + i * 0.25)),
    ...[5, 6, 7].map(i => choiceItem(`${short}-c${i - 4}`, skillId, at(i), ['checkpoint'], 0)),
    choiceItem(`${short}-d1`, skillId, at(8), ['diagnostic'], 0),
    textItem(`${short}-t1`, skillId, at(3), ['practice']),
  ]
}

const LESSON = (title: string, question: string): string => `# ${title}

Read this short introduction.

{% callout kind="tip" title="Remember" %}
Take your time.
{% /callout %}

{% quiz-note text="Numbers are fun." secret="server-only-note" /%}

{% check question="${question}" options=[{id: "a", text: "Yes"}, {id: "b", text: "No"}] answer="a" explain="Yes, because that is the rule." /%}
`

/** The quiz course. */
export function quizCourse(): CourseSpec {
  return {
    id: 'quiz-arithmetic',
    version: '1.0.0',
    title: 'Quiz arithmetic',
    description: 'Addition, multiplication and the order of operations.',
    keywords: ['arithmetic', 'math', 'addition', 'multiplication', 'quiz'],
    language: 'en',
    goal: 'quiz.mixed',
    environments: [QUIZ_ENV],
    skills: [
      { id: 'quiz.add', title: 'Adding small numbers', kind: 'concept', description: 'Add two small numbers.', environment: QUIZ_ENV },
      { id: 'quiz.mul', title: 'Multiplying small numbers', kind: 'concept', requires: ['quiz.add'], environment: QUIZ_ENV, confusableWith: ['quiz.add'] },
      { id: 'quiz.mixed', title: 'Order of operations', kind: 'procedure', requires: ['quiz.add', 'quiz.mul'], environment: QUIZ_ENV },
    ],
    lessons: [
      { id: 'lesson-add', skillId: 'quiz.add', title: 'Adding', source: LESSON('Adding', 'Is 2 + 2 equal to 4?') },
      { id: 'lesson-mul', skillId: 'quiz.mul', title: 'Multiplying', source: LESSON('Multiplying', 'Is 2 × 3 equal to 6?') },
      { id: 'lesson-mixed', skillId: 'quiz.mixed', title: 'Order of operations', source: LESSON('Order of operations', 'Do we multiply first?') },
    ],
    items: [
      ...itemsFor('quiz.add', '+'),
      ...itemsFor('quiz.mul', '×'),
      ...itemsFor('quiz.mixed', 'mix'),
      {
        id: 'mixed-s1',
        kind: 'quiz.sequence',
        skills: [{ skillId: 'quiz.mixed', weight: 1 }],
        difficulty: 0.5,
        modes: ['practice'],
        payload: { prompt: 'Name the steps for 2 + 3 × 4', length: 3 },
        key: { steps: ['multiply', 'twelve', 'fourteen'] },
      },
    ],
  }
}

/** The quiz content pack. */
export function quizPack(): ContentPack {
  return { id: 'quiz-pack', version: '1.0.0', title: 'Quiz pack', courses: [quizCourse()] }
}

/**
 * The correct response for an item of the quiz course.
 * @param item - the item.
 * @returns a response the grader accepts.
 */
export function correctResponse(item: ExerciseItem): JsonValue {
  const key = obj(item.key)
  if (item.kind === 'quiz.choice') return { choice: String(key.correct) }
  return { text: String(key.answer) }
}

/**
 * A wrong response for an item of the quiz course.
 * @param item - the item.
 * @returns a response the grader rejects.
 */
export function wrongResponse(item: ExerciseItem): JsonValue {
  const key = obj(item.key)
  if (item.kind === 'quiz.choice') return { choice: ['a', 'b', 'c', 'd'].find(l => l !== key.correct) ?? 'a' }
  return { text: 'not a number' }
}
