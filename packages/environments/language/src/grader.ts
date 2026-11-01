/**
 * Deterministic grading for the language kinds. A response is right when it
 * matches an accepted answer up to case, spacing and punctuation; right except
 * for accents earns partial credit; wrong article gender and wrong word order
 * are reported as misconceptions. No language model is involved, and feedback
 * never contains an accepted answer.
 * @module @hodos/language/grader
 */
import { uniformGrade, type GradeInput, type GradeResult, type JsonObject, type JsonValue } from '@hodos/plugin-sdk'
import { KIND } from './kinds.js'
import { match, wrongArticleGender, wrongWordOrder } from './normalize.js'

/** Misconception ids this grader reports, with learner feedback. */
export const MISCONCEPTIONS: Readonly<Record<string, string>> = {
  'missing-accent': 'Check the accents: in Spanish they change the word (está/esta, sí/si).',
  'article-gender': 'Check the article: is the noun masculine (el, un) or feminine (la, una)?',
  'word-order': 'All the right words — check their order.',
}

/** Score for an answer that is right except for accents. */
export const ACCENT_CREDIT = 0.5

function obj(value: JsonValue | null | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function gradeChoice(input: GradeInput): GradeResult {
  const choice = obj(input.response).choice
  const key = obj(input.key)
  const correct = typeof choice === 'string' && choice === key.correct
  const mapped = typeof choice === 'string' ? obj(key.misconceptions)[choice] : undefined
  return uniformGrade(input.skills, correct ? 1 : 0, {
    misconceptions: !correct && typeof mapped === 'string' ? [mapped] : [],
    feedback: correct ? 'Right.' : 'Not quite.',
  })
}

function gradeText(input: GradeInput): GradeResult {
  const text = obj(input.response).text
  const accepted = strings(obj(input.key).accepted)
  const given = typeof text === 'string' ? text : ''
  const result = match(given, accepted)
  if (result === 'exact') return uniformGrade(input.skills, 1, { feedback: 'Correct.' })
  if (result === 'accents') {
    return uniformGrade(input.skills, ACCENT_CREDIT, { correct: false, misconceptions: ['missing-accent'], feedback: 'Almost: the letters are right, the accents are not.' })
  }
  const misconceptions: string[] = []
  if (wrongArticleGender(given, accepted)) misconceptions.push('article-gender')
  if (input.kind === KIND.order && wrongWordOrder(given, accepted)) misconceptions.push('word-order')
  return uniformGrade(input.skills, 0, { misconceptions, feedback: given.trim() === '' ? 'Type an answer.' : 'Not quite.' })
}

/**
 * Grade one response.
 * @param input - kind, key, response and skills.
 * @returns the grade.
 */
export function gradeLanguage(input: GradeInput): GradeResult {
  return input.kind === KIND.choice ? gradeChoice(input) : gradeText(input)
}
