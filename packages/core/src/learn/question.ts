/**
 * Questions in a learning session: what the prober and the teacher ask, in
 * one of three forms.
 *
 * - **choice**: options with the correct value(s) committed when the
 *   question is asked; graded deterministically.
 * - **explain**: the learner answers in their own words; the teacher commits
 *   the full correct answer before asking (so it cannot drift towards what
 *   the learner wrote), and judges the answer against it afterwards.
 * - **interface**: an exercise kind contributed by an environment plugin
 *   (a chess position, a program, an expression). The plugin validates the
 *   item before the learner sees it and grades the answer.
 *
 * Keys stay on the server: the learner's view of an open question carries no
 * correct value, committed answer or plugin key. Grading happens here, never
 * in the browser.
 * @module @hodos/core/learn/question
 */
import { isJsonValue, unreachable, type Diagnostic, type ExerciseItem, type JsonValue } from '@hodos/plugin-sdk'
import { hashSeed, seededRandom } from '../random.js'

/**
 * Why a question is asked. `probe` brackets what the learner understands
 * before planning; `predict` comes before a teaching step, `check` after it;
 * `review` revisits a node later.
 */
export type QuestionRole = 'probe' | 'predict' | 'check' | 'review'

/** All question roles. */
export const QUESTION_ROLES: readonly QuestionRole[] = ['probe', 'predict', 'check', 'review']

/** One option of a choice question. `value` is the stable answer token. */
export interface ChoiceOption {
  readonly value: string
  readonly label: string
}

/** A choice question with its committed correct value(s). */
export interface ChoiceBody {
  readonly type: 'choice'
  readonly options: readonly ChoiceOption[]
  readonly correct: readonly string[]
  readonly multi: boolean
  /** Shown after the answer. */
  readonly explanation?: string
}

/** A free-recall question with the teacher's committed answer. */
export interface ExplainBody {
  readonly type: 'explain'
  readonly answer: string
}

/** A question in a plugin's exercise kind. */
export interface InterfaceBody {
  readonly type: 'interface'
  readonly kind: string
  readonly payload: JsonValue
  readonly key: JsonValue
  /** Shown after the answer. */
  readonly explanation?: string
  /** Set when the item came from a plugin's question bank rather than the model. */
  readonly bankItem?: { readonly courseId: string; readonly itemId: string }
  /** A bank item's explanation per misconception id, released when the grader detects it. */
  readonly misconceptionFeedback?: Readonly<Record<string, string>>
}

/** The body of a question. */
export type QuestionBody = ChoiceBody | ExplainBody | InterfaceBody

/** A question as asked. */
export interface QuestionSpec {
  readonly role: QuestionRole
  /** The plan node the question is about (teaching and review questions). */
  readonly nodeId?: string
  readonly prompt: string
  /** Extra context shown under the prompt. */
  readonly details?: string
  readonly body: QuestionBody
}

/** Size limits on what a model may put in a question. */
export const QUESTION_LIMITS = {
  promptChars: 4000,
  detailsChars: 4000,
  optionChars: 500,
  valueChars: 80,
  minOptions: 2,
  maxOptions: 8,
  answerChars: 6000,
  responseChars: 6000,
  thinkingChars: 8000,
} as const

/** What the learner did with a question. */
export type QuestionOutcome = 'correct' | 'partial' | 'incorrect' | 'dont-know' | 'ungraded'

/** The result of grading one answer. */
export interface QuestionVerdict {
  readonly outcome: QuestionOutcome
  /** Score in [0, 1]; null when Hodos does not grade the form (explain). */
  readonly score: number | null
  /** Feedback safe to show the learner. */
  readonly feedback?: string
  readonly misconceptions?: readonly string[]
  /** Explanations of the detected misconceptions, from a bank item's course. */
  readonly misconceptionFeedback?: readonly string[]
  /** The grade can update mastery: deterministic, engine or oracle grading of an unassisted answer. */
  readonly countsAsEvidence: boolean
}

/** What is shown after an answer: the committed correct answer, never before. */
export interface QuestionReveal {
  readonly correct?: readonly string[]
  readonly committedAnswer?: string
  readonly explanation?: string
  /** A plugin's reveal (for example the solution line of a puzzle). */
  readonly solution?: JsonValue
}

/** The learner's view of a question's form: no keys. */
export type QuestionForm =
  | { readonly type: 'choice'; readonly multi: boolean; readonly options: readonly ChoiceOption[] }
  | { readonly type: 'explain' }
  | {
    readonly type: 'interface'
    readonly kind: string
    readonly environment: string
    readonly responseKind: string
    readonly interaction: 'single' | 'stepwise'
    /** The one field a plain answer goes in, when the kind's responses are that simple (for forms without a renderer). */
    readonly answerField: AnswerField | null
    readonly payload: JsonValue
    readonly text: string
  }

/** The single field of a simple response: `{ [name]: value }`. */
export interface AnswerField {
  readonly name: string
  readonly type: 'string' | 'number' | 'integer'
}

/** What a plugin kind must provide for interface questions; the registry supplies it. */
export interface InterfaceKind {
  readonly environment: string
  readonly title: string
  /** How the learner answers (choice, text, moves, code…), for a generic answer form. */
  readonly responseKind: string
  readonly interaction: 'single' | 'stepwise'
  /** The one field a plain answer goes in, when responses are that simple. */
  readonly answerField: AnswerField | null
  /** The student-view projection of a payload (server-only fields removed). */
  project(payload: JsonValue): JsonValue
  /** The plain-text view of a payload. */
  text(payload: JsonValue): string
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown, field: string, limit: number, problems: string[], required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) problems.push(`${field} is required`)
    return undefined
  }
  if (typeof value !== 'string') {
    problems.push(`${field} must be a string`)
    return undefined
  }
  const t = value.trim()
  if (t === '' && required) problems.push(`${field} is required`)
  if (t.length > limit) problems.push(`${field} is longer than ${limit} characters`)
  return t === '' ? undefined : t
}

/** Turn an option label into a value token when the model gave none. */
function slugValue(label: string, index: number): string {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40)
  return slug === '' ? `option-${index + 1}` : slug
}

/**
 * The one field of a kind's response, when its response schema is an object
 * with a single required string or number property.
 * @param schema - the kind's response schema.
 * @returns the field, or null for richer responses.
 */
export function answerFieldOf(schema: JsonValue): AnswerField | null {
  const s = obj(schema)
  const required = Array.isArray(s?.required) ? s.required.filter((r): r is string => typeof r === 'string') : []
  const [name] = required
  if (s?.type !== 'object' || required.length !== 1 || name === undefined) return null
  const type = obj(obj(s.properties)?.[name])?.type
  return type === 'string' || type === 'number' || type === 'integer' ? { name, type } : null
}

/**
 * Read a choice body from untrusted tool input.
 * `options` may be strings or `{ value?, label }` objects; `correct` names
 * the correct option(s) by value or by exact label.
 * @param input - the model's arguments.
 * @param problems - collected problems.
 * @returns the body when it is well formed.
 */
export function readChoiceBody(input: Record<string, unknown>, problems: string[]): ChoiceBody | undefined {
  const raw = input.options
  if (!Array.isArray(raw)) {
    problems.push('options must be a list of 2 to 8 options')
    return undefined
  }
  if (raw.length < QUESTION_LIMITS.minOptions || raw.length > QUESTION_LIMITS.maxOptions) problems.push(`options must have ${QUESTION_LIMITS.minOptions} to ${QUESTION_LIMITS.maxOptions} entries`)
  const options: ChoiceOption[] = []
  const derived = new Set<number>()
  raw.forEach((entry, i) => {
    const o = obj(entry)
    const label = typeof entry === 'string' ? entry.trim() : typeof o?.label === 'string' ? o.label.trim() : ''
    if (label === '') {
      problems.push(`option ${i + 1} needs a label`)
      return
    }
    if (label.length > QUESTION_LIMITS.optionChars) problems.push(`option ${i + 1} is longer than ${QUESTION_LIMITS.optionChars} characters`)
    const explicit = typeof o?.value === 'string' && o.value.trim() !== ''
    const given = explicit ? (o.value as string).trim() : slugValue(label, i)
    if (given.length > QUESTION_LIMITS.valueChars) problems.push(`option ${i + 1}'s value is longer than ${QUESTION_LIMITS.valueChars} characters`)
    if (!explicit) derived.add(options.length)
    options.push({ value: given, label })
  })
  const values = new Set(options.filter((_, i) => !derived.has(i)).map(o => o.value))
  const seen = new Set<string>()
  options.forEach((o, i) => {
    if (!derived.has(i)) {
      if (seen.has(o.value)) problems.push(`two options share the value "${o.value}"; values must be unique`)
      seen.add(o.value)
      return
    }
    // A value derived from a label (math often slugs alike) gets a suffix instead of failing.
    let value = o.value
    for (let n = 2; values.has(value); n += 1) value = `${o.value}-${n}`
    values.add(value)
    options[i] = { value, label: o.label }
  })
  const labels = new Set<string>()
  for (const o of options) {
    if (labels.has(o.label)) problems.push(`two options read "${o.label}"; options must differ`)
    labels.add(o.label)
  }
  const multi = input.multi === true
  const rawCorrect = Array.isArray(input.correct) ? input.correct : input.correct === undefined ? [] : [input.correct]
  const correct: string[] = []
  for (const c of rawCorrect) {
    if (typeof c !== 'string') {
      problems.push('correct must name options by their value (or exact label)')
      continue
    }
    const match = options.find(o => o.value === c.trim()) ?? options.find(o => o.label === c.trim())
    if (match === undefined) problems.push(`correct names "${c}", which is not one of the options; use an option's value`)
    else if (!correct.includes(match.value)) correct.push(match.value)
  }
  if (correct.length === 0) problems.push('correct is required: commit to the right answer before asking')
  if (!multi && correct.length > 1) problems.push('a single-answer question has exactly one correct option; set multi to true for several')
  if (multi && correct.length === options.length) problems.push('every option is correct; a question needs at least one wrong option')
  const explanation = text(input.explanation, 'explanation', QUESTION_LIMITS.answerChars, problems, false)
  if (problems.length > 0) return undefined
  return { type: 'choice', options, correct, multi, ...(explanation === undefined ? {} : { explanation }) }
}

/**
 * Read an explain body from untrusted tool input.
 * @param input - the model's arguments (`answer`: the committed full answer).
 * @param problems - collected problems.
 * @returns the body when it is well formed.
 */
export function readExplainBody(input: Record<string, unknown>, problems: string[]): ExplainBody | undefined {
  const answer = text(input.answer, 'answer (your committed full answer, written before the learner sees the question)', QUESTION_LIMITS.answerChars, problems)
  return answer === undefined ? undefined : { type: 'explain', answer }
}

/**
 * Read an interface body: a plugin exercise kind with payload and key. The
 * plugin's own validation runs separately ({@link interfaceItem} + the registry).
 * @param input - the model's arguments (`kind`, `payload`, `key`, optional `explanation`).
 * @param kinds - the installed interface kinds.
 * @param problems - collected problems.
 * @returns the body when it is well formed.
 */
export function readInterfaceBody(input: Record<string, unknown>, kinds: ReadonlyMap<string, InterfaceKind>, problems: string[]): InterfaceBody | undefined {
  const kind = typeof input.kind === 'string' ? input.kind.trim() : ''
  if (kind === '') {
    problems.push('kind is required: one of the installed question interfaces')
    return undefined
  }
  if (!kinds.has(kind)) {
    problems.push(`no installed interface is called "${kind}"${kinds.size === 0 ? '; none are installed, so ask a choice or explain question' : `; installed: ${[...kinds.keys()].join(', ')}`}`)
    return undefined
  }
  if (!isJsonValue(input.payload) || input.payload === null) problems.push('payload is required and must be JSON')
  if (!isJsonValue(input.key) || input.key === null) problems.push('key is required and must be JSON')
  const explanation = text(input.explanation, 'explanation', QUESTION_LIMITS.answerChars, problems, false)
  if (problems.length > 0 || !isJsonValue(input.payload) || !isJsonValue(input.key)) return undefined
  return { type: 'interface', kind, payload: input.payload, key: input.key, ...(explanation === undefined ? {} : { explanation }) }
}

/**
 * The exercise item an interface question stands for, for the registry's
 * validation, grading and projection.
 * @param id - the question id.
 * @param body - the interface body.
 * @param nodeId - the plan node, used as the item's skill.
 * @returns a synthetic exercise item.
 */
export function interfaceItem(id: string, body: InterfaceBody, nodeId: string | undefined): ExerciseItem {
  return {
    id,
    kind: body.kind,
    skills: [{ skillId: nodeId ?? 'session', weight: 1 }],
    difficulty: 0,
    modes: ['practice'],
    payload: body.payload,
    key: body.key,
    ...(body.explanation === undefined ? {} : { explanation: body.explanation }),
    ...(body.misconceptionFeedback === undefined ? {} : { misconceptionFeedback: body.misconceptionFeedback }),
  }
}

/**
 * Format plugin diagnostics as problems for the model.
 * @param diagnostics - the registry's findings for an interface item.
 * @returns error findings as one-line problems.
 */
export function diagnosticProblems(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter(d => d.severity === 'error').map(d => `${d.code}: ${d.message}`)
}

/**
 * Options in a stable per-question order, so the correct option is not
 * always where the model put it and every render of one question agrees.
 * @param id - the question id (the seed).
 * @param options - options as authored.
 * @returns a shuffled copy.
 */
export function shuffledOptions(id: string, options: readonly ChoiceOption[]): ChoiceOption[] {
  const rng = seededRandom(hashSeed(id))
  const out = [...options]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1))
    const a = out[i]
    const b = out[j]
    if (a === undefined || b === undefined) continue
    out[i] = b
    out[j] = a
  }
  return out
}

/**
 * The learner's view of a question's form, without keys.
 * @param id - the question id.
 * @param body - the stored body.
 * @param kinds - installed interface kinds (an uninstalled kind shows its text only).
 * @returns the form to render.
 */
export function questionForm(id: string, body: QuestionBody, kinds: ReadonlyMap<string, InterfaceKind>): QuestionForm {
  switch (body.type) {
    case 'choice':
      return { type: 'choice', multi: body.multi, options: shuffledOptions(id, body.options) }
    case 'explain':
      return { type: 'explain' }
    case 'interface': {
      const kind = kinds.get(body.kind)
      return {
        type: 'interface',
        kind: body.kind,
        environment: kind?.environment ?? 'unavailable',
        responseKind: kind?.responseKind ?? 'text',
        interaction: kind?.interaction ?? 'single',
        answerField: kind?.answerField ?? null,
        payload: kind === undefined ? null : kind.project(body.payload),
        text: kind === undefined ? 'This question needs an environment that is no longer installed.' : kind.text(body.payload),
      }
    }
    default: return unreachable(body, 'question body')
  }
}

/**
 * What to show once a question is answered.
 * @param body - the stored body.
 * @param solution - a plugin's reveal, for interface questions.
 * @returns the reveal.
 */
export function questionReveal(body: QuestionBody, solution?: JsonValue): QuestionReveal {
  switch (body.type) {
    case 'choice':
      return { correct: body.correct, ...(body.explanation === undefined ? {} : { explanation: body.explanation }) }
    case 'explain':
      return { committedAnswer: body.answer }
    case 'interface':
      return { ...(body.explanation === undefined ? {} : { explanation: body.explanation }), ...(solution === undefined ? {} : { solution }) }
    default: return unreachable(body, 'question body')
  }
}

/** A learner's answer to a choice question. */
export interface ChoiceResponse {
  readonly selected: readonly string[]
}

/**
 * Read the selected values of a choice answer.
 * @param body - the question.
 * @param response - untrusted response.
 * @returns the selection, or an error message.
 */
export function readChoiceResponse(body: ChoiceBody, response: JsonValue): ChoiceResponse | string {
  const o = obj(response)
  const raw = o === null ? null : o.selected
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string')) return 'select at least one option'
  const selected = [...new Set(raw as string[])]
  if (selected.length === 0) return 'select at least one option'
  if (!body.multi && selected.length > 1) return 'select one option'
  const known = new Set(body.options.map(op => op.value))
  if (selected.some(v => !known.has(v))) return 'that is not one of the options'
  return { selected }
}

/**
 * Grade a choice answer: correct only when the selection equals the committed set.
 * @param body - the question.
 * @param response - the learner's selection.
 * @returns the verdict.
 */
export function gradeChoice(body: ChoiceBody, response: ChoiceResponse): QuestionVerdict {
  const want = new Set(body.correct)
  const exact = response.selected.length === want.size && response.selected.every(v => want.has(v))
  if (exact) return { outcome: 'correct', score: 1, countsAsEvidence: true }
  if (body.multi) {
    const hits = response.selected.filter(v => want.has(v)).length
    const wrong = response.selected.length - hits
    const score = Math.max(0, (hits - wrong) / want.size)
    if (score > 0) return { outcome: 'partial', score, countsAsEvidence: true }
  }
  return { outcome: 'incorrect', score: 0, countsAsEvidence: true }
}

/**
 * Read a free-recall answer.
 * @param response - untrusted response.
 * @returns the text, or an error message.
 */
export function readExplainResponse(response: JsonValue): string {
  const o = obj(response)
  const t = typeof o?.text === 'string' ? o.text.trim() : ''
  return t.slice(0, QUESTION_LIMITS.responseChars)
}

/** Everything the teacher learns about one answered question. */
export interface AnsweredQuestion {
  readonly spec: QuestionSpec
  readonly verdict: QuestionVerdict
  /** The learner's answer in words (option labels, typed text, a move…). */
  readonly answerText: string
  readonly thinking?: string
}

function labelsOf(body: ChoiceBody, values: readonly string[]): string {
  return values.map(v => `"${body.options.find(o => o.value === v)?.label ?? v}"`).join(', ')
}

/**
 * Describe a choice answer in words.
 * @param body - the question.
 * @param selected - the learner's values.
 * @returns the chosen labels.
 */
export function choiceAnswerText(body: ChoiceBody, selected: readonly string[]): string {
  return labelsOf(body, selected)
}

/**
 * The tool result the teacher reads after an answer: the verdict, the
 * learner's words and their thinking. For explain questions it restates the
 * committed answer so the judgment is made against it.
 * @param answered - the answered question.
 * @returns plain text for the model.
 */
export function answerReport(answered: AnsweredQuestion): string {
  const { spec, verdict } = answered
  const lines: string[] = []
  if (verdict.outcome === 'dont-know') {
    lines.push('The learner said they do not know.')
  } else if (spec.body.type === 'explain') {
    lines.push(`The learner answered in their own words: «${answered.answerText}»`)
    lines.push(`Your committed answer: «${spec.body.answer}»`)
    lines.push('Judge the learner\'s answer against your committed answer; do not revise the commitment to fit their words.')
  } else {
    const result = verdict.outcome === 'correct' ? 'Correct.' : verdict.outcome === 'partial' ? `Partly correct (score ${Math.round((verdict.score ?? 0) * 100)}%).` : 'Incorrect.'
    lines.push(`The learner answered ${answered.answerText}. ${result}`)
    if (spec.body.type === 'choice' && verdict.outcome !== 'correct') lines.push(`The correct answer: ${labelsOf(spec.body, spec.body.correct)}.`)
    if (verdict.feedback !== undefined) lines.push(`Grader feedback shown to the learner: ${verdict.feedback}`)
    if (verdict.misconceptions !== undefined && verdict.misconceptions.length > 0) lines.push(`Misconceptions detected: ${verdict.misconceptions.join(', ')}.`)
    for (const explanation of verdict.misconceptionFeedback ?? []) lines.push(`Explanation shown to the learner: ${explanation}`)
  }
  if (answered.thinking !== undefined && answered.thinking.trim() !== '') lines.push(`Their thinking out loud: «${answered.thinking.trim()}»`)
  return lines.join('\n')
}

/**
 * The plain-text view of a question for the model's context, without keys.
 * @param spec - the question.
 * @param form - its learner view.
 * @returns a short description.
 */
export function questionSummary(spec: QuestionSpec, form: QuestionForm): string {
  const head = `${spec.role}${spec.nodeId === undefined ? '' : ` on ${spec.nodeId}`}: ${spec.prompt}`
  switch (form.type) {
    case 'choice':
      return `${head} [${form.options.map(o => o.label).join(' | ')}]`
    case 'explain':
      return `${head} (answered in their own words)`
    case 'interface':
      return `${head} (${form.kind}: ${form.text})`
    default: return unreachable(form, 'question form')
  }
}

/**
 * The key's string leaves for the leak scan of plugin feedback.
 * @param key - a plugin key.
 * @returns string leaves of at least four characters.
 */
export function keyFragments(key: JsonValue): string[] {
  const out: string[] = []
  const walk = (v: JsonValue): void => {
    if (typeof v === 'string') {
      if (v.trim().length >= 4) out.push(v.trim())
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x)
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x)
    }
  }
  walk(key)
  return out
}
