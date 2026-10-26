/**
 * Comparing a typed answer with the accepted answers. Case, spacing and
 * punctuation (including ¿ and ¡) never matter. Accents matter: an answer
 * that differs only in acute accents or the diaeresis (á é í ó ú ü) is
 * "almost" right, so the learner gets partial credit and a pointer to the
 * accents. The tilde of ñ is a different letter and is never folded.
 * @module @hodos/language/normalize
 */

const ACCENTS = /[́̈]/gu
const PUNCTUATION = /[\p{P}\p{S}]/gu

/**
 * Canonical form for comparison.
 * @param text - an answer or accepted answer.
 * @returns lowercased NFC text without punctuation, single-spaced.
 */
export function canonical(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('es').replace(PUNCTUATION, ' ').replace(/\s+/gu, ' ').trim()
}

/**
 * The canonical form without acute accents and diaeresis (ñ stays).
 * @param text - an answer or accepted answer.
 */
export function withoutAccents(text: string): string {
  return canonical(text).normalize('NFD').replace(ACCENTS, '').normalize('NFC')
}

/** How a response compares with the accepted answers. */
export type Match = 'exact' | 'accents' | 'none'

/**
 * Compare a response with the accepted answers.
 * @param response - the learner's text.
 * @param accepted - accepted answers (any punctuation and case).
 * @returns `exact`, `accents` (right except for accents) or `none`.
 */
export function match(response: string, accepted: readonly string[]): Match {
  const given = canonical(response)
  if (given === '') return 'none'
  if (accepted.some(a => canonical(a) === given)) return 'exact'
  const folded = withoutAccents(response)
  return accepted.some(a => withoutAccents(a) === folded) ? 'accents' : 'none'
}

/** Spanish articles and their opposite-gender counterparts. */
const ARTICLE_SWAP: Readonly<Record<string, string>> = {
  el: 'la', la: 'el', los: 'las', las: 'los', un: 'una', una: 'un', unos: 'unas', unas: 'unos',
}

/**
 * Whether the response is an accepted answer with articles of the wrong gender.
 * @param response - the learner's text.
 * @param accepted - accepted answers.
 */
export function wrongArticleGender(response: string, accepted: readonly string[]): boolean {
  const words = canonical(response).split(' ')
  const swapped = words.map(w => ARTICLE_SWAP[w] ?? w).join(' ')
  return words.some(w => ARTICLE_SWAP[w] !== undefined) && accepted.some(a => canonical(a) === swapped)
}

/**
 * Whether the response uses exactly the words of an accepted answer in another order.
 * @param response - the learner's text.
 * @param accepted - accepted answers.
 */
export function wrongWordOrder(response: string, accepted: readonly string[]): boolean {
  const sorted = (text: string): string => canonical(text).split(' ').sort().join(' ')
  const given = sorted(response)
  return accepted.some(a => sorted(a) === given && canonical(a) !== canonical(response))
}

/**
 * The words of a text, for checking that ordering items use exactly their tokens.
 * @param text - a sentence or token.
 */
export function words(text: string): string[] {
  const c = canonical(text)
  return c === '' ? [] : c.split(' ')
}
