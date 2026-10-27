/**
 * Code grading. `code.predict` is deterministic: the typed output is compared
 * line by line with the authored key, listed misreadings are named, and an
 * answer with the right values but wrong quotes or spacing gets partial
 * credit. `code.write` runs the learner's program in the host's isolated
 * runner and compares outputs here, outside the sandbox. `code.sandbox`
 * takes the test results the learner's browser reported (self-reported, so
 * never mastery evidence). Feedback never states the key, a hidden test, or
 * anything the program printed.
 * @module @hodos/code/grader
 */
import { uniformGrade, unreachable, type GradeInput, type GradeResult, type JsonObject, type JsonValue } from '@hodos/plugin-sdk'
import { compareOutput, outputLines, sameIgnoringQuotes, sameIgnoringSpacing, sameOutput, type OutputDifference } from './output.js'
import { sandboxTests } from './kinds.js'
import { DEFAULT_LIMITS, runAll, type CodeRunner, type RunOutcome } from './runner.js'

/** Credit for the right values with the wrong quotes or spacing. */
export const FORMAT_CREDIT = 0.5

/** Misconceptions the grader detects in any output, with learner feedback. */
export const OUTPUT_MISCONCEPTIONS: Readonly<Record<string, string>> = {
  quotes: 'Check the quotes: print shows a string\'s characters without quotes, but a list shows the strings inside it with quotes.',
  spacing: 'The values are right but the spaces or line breaks are not: print puts one space between its arguments and ends the line, unless sep= or end= say otherwise.',
}

function obj(value: JsonValue | null | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function describe(difference: OutputDifference): string {
  switch (difference.kind) {
    case 'same': return 'Correct.'
    case 'line': return difference.line === 1
      ? 'The first line is not what the program prints.'
      : `${difference.line === 2 ? 'Line 1 is' : `Lines 1–${difference.line - 1} are`} right; line ${difference.line} is not what the program prints.`
    case 'missing-lines': return 'Right so far, but the program prints more lines.'
    case 'extra-lines': return 'The program prints fewer lines than that.'
    default: return unreachable(difference, 'output difference')
  }
}

/**
 * Grade a predicted output.
 * @param input - key and response.
 * @returns the grade.
 */
export function gradePredict(input: GradeInput): GradeResult {
  const key = obj(input.key)
  const expected = str(key.output)
  const answer = str(obj(input.response).text)
  if (outputLines(answer).length === 0) return uniformGrade(input.skills, 0, { feedback: 'Type what the program prints, one line per printed line.' })
  const difference = compareOutput(expected, answer)
  if (difference.kind === 'same') return uniformGrade(input.skills, 1, { feedback: 'Correct.' })
  const listed = (Array.isArray(key.misconceptions) ? key.misconceptions : []).map(obj).filter(m => sameOutput(str(m.output), answer)).map(m => str(m.id))
  if (listed.length > 0) return uniformGrade(input.skills, 0, { misconceptions: listed, feedback: describe(difference) })
  if (sameIgnoringQuotes(expected, answer)) return uniformGrade(input.skills, FORMAT_CREDIT, { correct: false, misconceptions: ['quotes'], feedback: 'The values are right; check the quotes.' })
  if (sameIgnoringSpacing(expected, answer)) return uniformGrade(input.skills, FORMAT_CREDIT, { correct: false, misconceptions: ['spacing'], feedback: 'The values are right; check the spaces and line breaks.' })
  return uniformGrade(input.skills, 0, { feedback: describe(difference) })
}

/** How one run went against its expected output. */
type Verdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'wrong'; readonly difference: OutputDifference }
  | { readonly kind: 'error'; readonly exception: string | null }
  | { readonly kind: 'timeout' | 'memory' | 'output-limit' }

/** The exception class named on the last line of a traceback, if it looks like one. */
function exceptionName(stderr: string): string | null {
  const last = stderr.trimEnd().split('\n').pop() ?? ''
  const match = /^([A-Z][A-Za-z]{1,40}(?:Error|Exception|Exit|Interrupt))(?::|$)/u.exec(last)
  return match?.[1] ?? null
}

function verdict(expected: string, outcome: RunOutcome): Verdict {
  switch (outcome.status) {
    case 'ok': {
      const difference = compareOutput(expected, outcome.stdout)
      return difference.kind === 'same' ? { kind: 'pass' } : { kind: 'wrong', difference }
    }
    case 'error': return { kind: 'error', exception: exceptionName(outcome.stderr) }
    default: return { kind: outcome.status }
  }
}

function explain(v: Verdict): string {
  switch (v.kind) {
    case 'pass': return 'passed.'
    case 'wrong': return v.difference.kind === 'line'
      ? `line ${v.difference.line} of your output is not the expected output.`
      : v.difference.kind === 'missing-lines' ? 'your output stops too early.' : 'your output has extra lines.'
    case 'error': return `your program stopped with ${v.exception ?? 'an error'}.`
    case 'timeout': return `your program did not finish within ${DEFAULT_LIMITS.wallMs / 1000} s.`
    case 'memory': return 'your program used too much memory.'
    case 'output-limit': return 'your program printed too much.'
    default: return unreachable(v, 'run verdict')
  }
}

const SUMMARY: Readonly<Record<Exclude<Verdict['kind'], 'pass'>, string>> = {
  wrong: 'wrong output',
  error: 'stopped with an error',
  timeout: 'ran out of time',
  memory: 'ran out of memory',
  'output-limit': 'printed too much',
}

/**
 * Create the `code.write` grader around a host's runner.
 * @param runner - the isolated runner.
 * @param budgetMs - how long to wait for all runs; must stay below the host's grading timeout.
 * @returns the grade function.
 */
export function createWriteGrader(runner: CodeRunner, budgetMs: number): (input: GradeInput) => Promise<GradeResult> {
  return async input => {
    const pairs = (value: JsonValue | undefined): Array<{ input: string; output: string }> =>
      (Array.isArray(value) ? value : []).map(obj).map(p => ({ input: str(p.input), output: str(p.output) }))
    const examples = pairs(obj(input.payload).examples)
    const tests = pairs(obj(input.key).tests)
    const source = str(obj(input.response).code)
    if (source.trim() === '') return uniformGrade(input.skills, 0, { feedback: 'Write a program first.' })
    const runs = [...examples, ...tests]
    const outcomes = await runAll(runner, { language: 'python', source, inputs: runs.map(r => r.input), limits: DEFAULT_LIMITS }, budgetMs)
    const verdicts = runs.map((r, i) => {
      const outcome = outcomes[i]
      if (outcome === undefined) throw new Error('missing run outcome')
      return verdict(r.output, outcome)
    })
    const passed = verdicts.filter(v => v.kind === 'pass').length
    const details: JsonObject = { passed, total: runs.length, results: verdicts.map(v => v.kind) }
    if (passed === runs.length) return uniformGrade(input.skills, 1, { feedback: 'All tests passed.', details })
    const lines = verdicts.slice(0, examples.length).flatMap((v, i) => (v.kind === 'pass' ? [] : [`Example ${i + 1}: ${explain(v)}`]))
    const hidden = verdicts.slice(examples.length)
    const failures = Object.entries(SUMMARY).flatMap(([kind, label]) => {
      const count = hidden.filter(v => v.kind === kind).length
      return count === 0 ? [] : [`${count} ${label}`]
    })
    const hiddenPassed = hidden.filter(v => v.kind === 'pass').length
    lines.push(`Hidden tests: ${hiddenPassed} of ${hidden.length} passed${failures.length === 0 ? '' : ` (${failures.join(', ')})`}.`)
    return uniformGrade(input.skills, passed / runs.length, { correct: false, feedback: lines.join(' '), details })
  }
}

/**
 * Grade a sandbox answer from the results the learner's browser reported.
 * The server cannot check them, which is why the grader's method is
 * `self-report`.
 * @param input - payload (for the number of tests) and response.
 * @returns the grade.
 */
export function gradeSandbox(input: GradeInput): GradeResult {
  const response = obj(input.response)
  const results = obj(response.results)
  const total = sandboxTests(input.payload).length
  const passed = results.passed
  if (str(response.code).trim() === '') return uniformGrade(input.skills, 0, { feedback: 'Write some code first.' })
  if (typeof passed !== 'number' || results.total !== total || passed < 0 || passed > total) {
    return uniformGrade(input.skills, 0, { feedback: 'Not run: run the tests before you submit.' })
  }
  if (passed === total) return uniformGrade(input.skills, 1, { feedback: `All ${total} tests passed in your browser.` })
  return uniformGrade(input.skills, passed / total, { correct: false, feedback: `${passed} of ${total} tests passed in your browser.` })
}
