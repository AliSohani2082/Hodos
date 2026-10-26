/**
 * Exercise kinds and the lesson block of the language environment. All
 * kinds are answered as text or a choice in the workspace's own accessible
 * form, so the environment needs no renderer: the plain-text prompt is the
 * exercise.
 * @module @hodos/language/kinds
 */
import type { Diagnostic, ExerciseItem, ExerciseKindSpec, JsonObject, JsonSchema, JsonValue, LessonBlockSpec, LessonNode } from '@hodos/plugin-sdk'
import { canonical, words } from './normalize.js'

export const ENVIRONMENT = 'language.text'
export const GRADER_ID = 'language.grader'

/** Kind ids. */
export const KIND = {
  recall: 'language.recall',
  choice: 'language.choice',
  cloze: 'language.cloze',
  order: 'language.order',
  translate: 'language.translate',
  conjugate: 'language.conjugate',
} as const

/** The blank in a cloze sentence. */
export const BLANK = '___'

const TEXT = (max: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength: max })
const LANG = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$' } as const
const ACCEPTED: JsonSchema = { type: 'array', minItems: 1, maxItems: 12, items: TEXT(200) }
const TEXT_RESPONSE: JsonSchema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 300 } } }
const TEXT_KEY: JsonSchema = { type: 'object', additionalProperties: false, required: ['accepted'], properties: { accepted: ACCEPTED } }

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function error(code: string, message: string): Diagnostic {
  return { severity: 'error', code, message }
}

/** Accepted answers must be distinct and non-empty after normalization. */
function checkAccepted(item: ExerciseItem): Diagnostic[] {
  const accepted = strings(obj(item.key).accepted)
  const out: Diagnostic[] = []
  if (accepted.some(a => canonical(a) === '')) out.push(error('language/empty-answer', 'an accepted answer is empty once punctuation is removed'))
  if (new Set(accepted.map(canonical)).size !== accepted.length) out.push({ severity: 'warning', code: 'language/duplicate-answer', message: 'two accepted answers are the same once case and punctuation are ignored' })
  // A prompt that already contains an answer gives it away.
  const visible = canonical(JSON.stringify(item.payload))
  for (const a of accepted) {
    if (canonical(a).length >= 3 && new RegExp(`(^| )${canonical(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`, 'u').test(visible)) {
      out.push(error('language/answer-in-prompt', `the prompt contains the accepted answer "${a}"`))
    }
  }
  return out
}

const directions = (p: JsonObject): string => `${str(p.from) || 'en'} → ${str(p.to) || 'es'}`

/** Vocabulary recall: give the word or phrase in the target language. */
export const recallKind: ExerciseKindSpec = {
  id: KIND.recall,
  title: 'Vocabulary',
  environment: ENVIRONMENT,
  responseKind: 'text',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['prompt', 'from', 'to'],
    properties: { prompt: TEXT(200), from: LANG, to: LANG, note: TEXT(200) },
  },
  keySchema: TEXT_KEY,
  responseSchema: TEXT_RESPONSE,
  guidance: {
    when: 'The learner recalls a word or set phrase in the target language from its meaning.',
    rules: ['List every acceptable answer in `accepted` (with accents); answers are compared ignoring case and punctuation.', '`note` may give context such as "informal" but never the answer.'],
    example: { payload: { prompt: 'thank you', from: 'en', to: 'es' }, key: { accepted: ['gracias'] } },
  },
  validateItem: checkAccepted,
  fallbackText: payload => {
    const p = obj(payload)
    return `In Spanish (${directions(p)}): ${str(p.prompt)}${p.note === undefined ? '' : ` (${str(p.note)})`}`
  },
  reveal: item => ({ accepted: strings(obj(item.key).accepted) }),
}

/** Multiple choice. */
export const choiceKind: ExerciseKindSpec = {
  id: KIND.choice,
  title: 'Multiple choice',
  environment: ENVIRONMENT,
  responseKind: 'choice',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: true, options: 4 },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['prompt', 'options'],
    properties: {
      prompt: TEXT(300),
      options: {
        type: 'array', minItems: 2, maxItems: 6,
        items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string', pattern: '^[a-z0-9-]{1,16}$' }, text: TEXT(200) } },
      },
    },
  },
  keySchema: {
    type: 'object', additionalProperties: false, required: ['correct'],
    properties: { correct: { type: 'string' }, misconceptions: { type: 'object', additionalProperties: { type: 'string', pattern: '^[a-z0-9-]{1,48}$' } } },
  },
  responseSchema: { type: 'object', additionalProperties: false, required: ['choice'], properties: { choice: { type: 'string', maxLength: 16 } } },
  guidance: {
    when: 'The learner recognizes the right form among a few (articles, ser or estar, meanings).',
    rules: ['`key.correct` is one option id; `key.misconceptions` maps a wrong option id to a misconception id the item explains in `misconceptionFeedback`.', 'Choice items are guessable: give the skill guess-resistant checkpoint items as well.'],
    example: {
      payload: { prompt: 'María ___ en la oficina. (María is at the office.)', options: [{ id: 'a', text: 'es' }, { id: 'b', text: 'está' }] },
      key: { correct: 'b', misconceptions: { a: 'ser-for-location' } },
    },
  },
  validateItem: item => {
    const options = obj(item.payload).options
    const ids = Array.isArray(options) ? options.map(o => str(obj(o).id)) : []
    const key = obj(item.key)
    const out: Diagnostic[] = []
    if (!ids.includes(str(key.correct))) out.push(error('language/choice-key', 'the correct option is not offered'))
    if (new Set(ids).size !== ids.length) out.push(error('language/choice-ids', 'option ids repeat'))
    for (const [option, misconception] of Object.entries(obj(key.misconceptions))) {
      if (!ids.includes(option) || option === str(key.correct)) out.push(error('language/choice-misconception', `misconception for option ${option} must name a wrong option`))
      if (item.misconceptionFeedback?.[str(misconception)] === undefined) out.push({ severity: 'warning', code: 'language/misconception-feedback', message: `misconception ${str(misconception)} has no feedback` })
    }
    return out
  },
  fallbackText: payload => {
    const p = obj(payload)
    const options = Array.isArray(p.options) ? p.options.map(o => `(${str(obj(o).id)}) ${str(obj(o).text)}`) : []
    return `${str(p.prompt)}\n${options.join('\n')}`
  },
  reveal: item => ({ correct: str(obj(item.key).correct) }),
}

/** Cloze: fill the blank in a sentence. */
export const clozeKind: ExerciseKindSpec = {
  id: KIND.cloze,
  title: 'Fill the blank',
  environment: ENVIRONMENT,
  responseKind: 'text',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['sentence'],
    properties: { sentence: TEXT(300), translation: TEXT(300), prompt: TEXT(200) },
  },
  keySchema: TEXT_KEY,
  responseSchema: TEXT_RESPONSE,
  guidance: {
    when: 'The learner supplies one missing word (a verb form, an article) in a sentence.',
    rules: [`The sentence contains the blank \`${BLANK}\` exactly once.`, '`translation` gives the meaning of the whole sentence; it must not contain the answer.'],
    example: { payload: { sentence: `Yo ${BLANK} estudiante.`, translation: 'I am a student.' }, key: { accepted: ['soy'] } },
  },
  validateItem: item => {
    const sentence = str(obj(item.payload).sentence)
    const blanks = sentence.split(BLANK).length - 1
    return [
      ...(blanks === 1 ? [] : [error('language/cloze-blank', `the sentence must contain ${BLANK} exactly once (found ${blanks})`)]),
      ...checkAccepted(item),
    ]
  },
  fallbackText: payload => {
    const p = obj(payload)
    return `${str(p.prompt) || 'Fill the blank'}: ${str(p.sentence)}${p.translation === undefined ? '' : `\n(${str(p.translation)})`}`
  },
  reveal: item => ({ accepted: strings(obj(item.key).accepted) }),
}

/** Sentence ordering: type the sentence the given words make. */
export const orderKind: ExerciseKindSpec = {
  id: KIND.order,
  title: 'Word order',
  environment: ENVIRONMENT,
  responseKind: 'text',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['tokens'],
    properties: { tokens: { type: 'array', minItems: 2, maxItems: 12, items: TEXT(40) }, translation: TEXT(300), prompt: TEXT(200) },
  },
  keySchema: TEXT_KEY,
  responseSchema: TEXT_RESPONSE,
  guidance: {
    when: 'The learner puts given words into a correct sentence (word order).',
    rules: ['Every accepted sentence uses exactly the given words, each once.', 'List the tokens shuffled, not in the solution order.'],
    example: { payload: { tokens: ['estudiante', 'soy', 'yo'], translation: 'I am a student.' }, key: { accepted: ['Yo soy estudiante'] } },
  },
  validateItem: item => {
    const tokens = strings(obj(item.payload).tokens).flatMap(words).sort().join(' ')
    const accepted = strings(obj(item.key).accepted)
    const out: Diagnostic[] = []
    for (const a of accepted) if (words(a).sort().join(' ') !== tokens) out.push(error('language/order-tokens', `"${a}" does not use exactly the given words`))
    const solution = canonical(strings(obj(item.payload).tokens).join(' '))
    if (accepted.some(a => canonical(a) === solution)) out.push(error('language/order-shuffled', 'the tokens are listed in a solution order'))
    return out
  },
  fallbackText: payload => {
    const p = obj(payload)
    return `${str(p.prompt) || 'Write the sentence these words make'}: ${strings(p.tokens).map(t => `[${t}]`).join(' ')}${p.translation === undefined ? '' : `\n(${str(p.translation)})`}`
  },
  reveal: item => ({ accepted: strings(obj(item.key).accepted) }),
}

/** Translation of a sentence. */
export const translateKind: ExerciseKindSpec = {
  id: KIND.translate,
  title: 'Translation',
  environment: ENVIRONMENT,
  responseKind: 'text',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['text', 'from', 'to'],
    properties: { text: TEXT(300), from: LANG, to: LANG },
  },
  keySchema: TEXT_KEY,
  responseSchema: TEXT_RESPONSE,
  guidance: {
    when: 'The learner translates a short sentence.',
    rules: ['List every acceptable translation (with and without optional subject pronouns, both genders where the source is ambiguous).', 'Grading is exact up to case and punctuation, so keep sentences short and unambiguous.'],
    example: { payload: { text: 'We are friends.', from: 'en', to: 'es' }, key: { accepted: ['Somos amigos', 'Nosotros somos amigos', 'Somos amigas', 'Nosotras somos amigas'] } },
  },
  validateItem: checkAccepted,
  fallbackText: payload => {
    const p = obj(payload)
    return `Translate (${directions(p)}): ${str(p.text)}`
  },
  reveal: item => ({ accepted: strings(obj(item.key).accepted) }),
}

/** Verb conjugation. */
export const conjugateKind: ExerciseKindSpec = {
  id: KIND.conjugate,
  title: 'Conjugation',
  environment: ENVIRONMENT,
  responseKind: 'text',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['verb', 'person', 'tense'],
    properties: { verb: TEXT(40), person: TEXT(60), tense: TEXT(60), meaning: TEXT(100) },
  },
  keySchema: TEXT_KEY,
  responseSchema: TEXT_RESPONSE,
  guidance: {
    when: 'The learner gives one verb form.',
    rules: ['`person` and `tense` are written for the learner, e.g. "yo" and "present".'],
    example: { payload: { verb: 'ser', person: 'yo', tense: 'present', meaning: 'to be' }, key: { accepted: ['soy'] } },
  },
  validateItem: checkAccepted,
  fallbackText: payload => {
    const p = obj(payload)
    return `Conjugate ${str(p.verb)}${p.meaning === undefined ? '' : ` (${str(p.meaning)})`} — ${str(p.person)}, ${str(p.tense)}:`
  },
  reveal: item => ({ accepted: strings(obj(item.key).accepted) }),
}

/** All kinds of the environment. */
export const KINDS: readonly ExerciseKindSpec[] = [recallKind, choiceKind, clozeKind, orderKind, translateKind, conjugateKind]

/** The `language-phrase` lesson block: a phrase with its meaning. */
export const phraseBlock: LessonBlockSpec = {
  name: 'language-phrase',
  version: 1,
  kind: 'leaf',
  attributes: {
    type: 'object', additionalProperties: false, required: ['id', 'text', 'translation'],
    properties: { id: { type: 'string' }, text: TEXT(200), translation: TEXT(200), note: TEXT(200), lang: LANG },
  },
  guidance: {
    when: 'Show a word or phrase in the target language with its meaning.',
    syntax: '{% language-phrase text="buenos días" translation="good morning" note="until about noon" /%}',
    rules: ['Use it for vocabulary the lesson introduces; do not show answers to the learner\'s current exercises.'],
  },
  fallbackText: (node: LessonNode) => {
    const a = node.attributes
    return `${str(a.text)} — ${str(a.translation)}${a.note === undefined ? '' : ` (${str(a.note)})`}`
  },
}
