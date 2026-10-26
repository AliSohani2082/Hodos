/**
 * Comparing program output. Line endings are unified, trailing spaces on a
 * line and trailing blank lines are ignored; everything else counts,
 * including blank lines inside the output and leading spaces.
 * @module @hodos/code/output
 */

/**
 * Normalize output into lines.
 * @param text - output as printed or typed.
 * @returns its lines without trailing spaces, trailing blank lines removed.
 */
export function outputLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/u, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Where an answer first departs from the expected output. */
export type OutputDifference =
  | { readonly kind: 'same' }
  /** 1-based number of the first line that differs. */
  | { readonly kind: 'line'; readonly line: number }
  /** The answer is the start of the output; lines are missing at the end. */
  | { readonly kind: 'missing-lines' }
  /** The output is the start of the answer; the answer has extra lines. */
  | { readonly kind: 'extra-lines' }

/**
 * Compare an answer with the expected output.
 * @param expected - what the program prints.
 * @param actual - the answer.
 * @returns the first difference, or `same`.
 */
export function compareOutput(expected: string, actual: string): OutputDifference {
  const want = outputLines(expected)
  const got = outputLines(actual)
  const shared = Math.min(want.length, got.length)
  for (let i = 0; i < shared; i += 1) if (want[i] !== got[i]) return { kind: 'line', line: i + 1 }
  if (got.length < want.length) return { kind: 'missing-lines' }
  if (got.length > want.length) return { kind: 'extra-lines' }
  return { kind: 'same' }
}

/** Whether two outputs are the same after normalization. */
export function sameOutput(a: string, b: string): boolean {
  return compareOutput(a, b).kind === 'same'
}

/** Whether two outputs differ only in quote characters. */
export function sameIgnoringQuotes(a: string, b: string): boolean {
  const strip = (s: string): string => s.replace(/['"]/g, '')
  return sameOutput(strip(a), strip(b))
}

/** Whether two outputs differ only in spaces and line breaks. */
export function sameIgnoringSpacing(a: string, b: string): boolean {
  const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim()
  return squash(a) === squash(b)
}
