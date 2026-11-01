/**
 * Exercise kinds and the lesson block of the code environment. Programs are
 * shown read-only (highlighted, with line numbers) by the sandboxed
 * `code-view` renderer; the learner answers in the workspace's own form.
 * The server never runs code: `code.predict` compares typed output with an
 * authored key, `code.write` exists only when the host supplies an isolated
 * runner (see `runner.ts`), and `code.sandbox` runs the learner's program
 * in their own browser, in the sandboxed `code-sandbox` renderer, which
 * reports how many visible tests passed.
 * @module @hodos/code/kinds
 */
import type { Diagnostic, ExerciseKindSpec, JsonObject, JsonSchema, JsonValue, LessonBlockSpec, LessonNode } from '@hodos/plugin-sdk'
import { sameOutput } from './output.js'
import { calledNames, importedModules, tokenize } from './python.js'

export const ENVIRONMENT = 'code.listing'
export const RENDERER_ID = 'code-view'
/** Environment of programs the learner writes and runs in the browser. */
export const SANDBOX_ENVIRONMENT = 'code.sandbox'
/** Renderer with an editor that runs Python (Pyodide) in a worker. */
export const SANDBOX_RENDERER_ID = 'code-sandbox'
/** Grader of `code.sandbox` (self-reported: the tests ran in the learner's browser). */
export const SANDBOX_GRADER_ID = 'code.sandbox-grader'
/** Grader of `code.predict` (deterministic). */
export const GRADER_ID = 'code.grader'
/** Grader of `code.write` (oracle; needs a runner). */
export const RUNNER_GRADER_ID = 'code.runner-grader'

/** Kind ids. */
export const KIND = { predict: 'code.predict', write: 'code.write', sandbox: 'code.sandbox' } as const

/** Longest program shown in an exercise or lesson, in lines. */
export const MAX_LINES = 30

/** Modules a reading program may import: their output does not change from run to run. */
export const ALLOWED_IMPORTS: readonly string[] = ['math']

/** Calls a reading program may not make, with the reason. */
export const UNSUPPORTED_CALLS: Readonly<Record<string, string>> = {
  input: 'needs keyboard input',
  open: 'uses files',
  id: 'prints a memory address that changes from run to run',
  hash: 'changes from run to run for strings',
  eval: 'runs code built at run time',
  exec: 'runs code built at run time',
  compile: 'runs code built at run time',
  __import__: 'imports modules at run time',
  globals: 'prints interpreter internals',
  locals: 'prints interpreter internals',
  vars: 'prints interpreter internals',
  breakpoint: 'starts the debugger',
  help: 'starts the interactive help',
  exit: 'ends the interpreter',
  quit: 'ends the interpreter',
}

const TEXT = (max: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength: max })
const PYTHON: JsonSchema = { const: 'python' }
const MISCONCEPTION_ID: JsonSchema = { type: 'string', pattern: '^[a-z0-9-]{1,48}$' }
const HIGHLIGHT: JsonSchema = { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: MAX_LINES } }
const IO_PAIR: JsonSchema = { type: 'object', additionalProperties: false, required: ['input', 'output'], properties: { input: { type: 'string', maxLength: 2000 }, output: TEXT(2000) } }

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numbers(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : []
}

function error(code: string, message: string): Diagnostic {
  return { severity: 'error', code, message }
}

/**
 * What is wrong with a program shown to learners: it must tokenize, fit
 * {@link MAX_LINES}, and print the same output on every run.
 * @param source - the program.
 * @param where - what the program is, for messages ("the program", "the starter code").
 * @returns findings.
 */
export function programProblems(source: string, where = 'the program'): Diagnostic[] {
  const out: Diagnostic[] = []
  const { tokens, error: problem } = tokenize(source)
  if (problem !== undefined) out.push(error('code/syntax', `${where}: line ${problem.line}: ${problem.message}`))
  const lines = source.replace(/\n+$/u, '').split('\n').length
  if (lines > MAX_LINES) out.push(error('code/too-long', `${where} has ${lines} lines; at most ${MAX_LINES}`))
  for (const module of importedModules(tokens)) {
    if (!ALLOWED_IMPORTS.includes(module)) out.push(error('code/import', `${where} imports ${module}; only ${ALLOWED_IMPORTS.join(', ')} may be imported`))
  }
  const calls = new Set(calledNames(tokens))
  for (const name of calls) {
    const reason = UNSUPPORTED_CALLS[name]
    if (reason !== undefined) out.push(error('code/unsupported-call', `${where} calls ${name}(), which ${reason}`))
  }
  if (calls.has('set')) {
    out.push({ severity: 'warning', code: 'code/set-order', message: `${where} builds a set: do not print it, its order is not fixed` })
  }
  return out
}

function highlightProblems(highlight: JsonValue | undefined, source: string): Diagnostic[] {
  const lines = source.split('\n').length
  return numbers(highlight).some(n => n > lines) ? [error('code/highlight', `highlighted lines must be between 1 and ${lines}`)] : []
}

/** The program as numbered lines, for the plain-text view. */
export function listing(source: string): string {
  const lines = source.replace(/\n+$/u, '').split('\n')
  const width = String(lines.length).length
  return lines.map((l, i) => `${String(i + 1).padStart(width)} | ${l}`).join('\n')
}

/** Predict what a program prints. */
export const predictKind: ExerciseKindSpec = {
  id: KIND.predict,
  title: 'Predict the output',
  environment: ENVIRONMENT,
  responseKind: 'lines',
  interaction: 'single',
  grader: GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['language', 'source'],
    properties: { prompt: TEXT(300), language: PYTHON, source: TEXT(2000), highlight: HIGHLIGHT },
  },
  keySchema: {
    type: 'object', additionalProperties: false, required: ['output'],
    properties: {
      output: TEXT(2000),
      misconceptions: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['output', 'id'], properties: { output: TEXT(2000), id: MISCONCEPTION_ID } } },
    },
  },
  responseSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 4000 } } },
  guidance: {
    when: 'The learner reads a short Python 3 program and types exactly what it prints. For tracing expressions, variables, branches, loops, lists and functions.',
    rules: [
      `\`source\` is a complete Python 3 program of at most ${MAX_LINES} lines that prints something; \`key.output\` is exactly what it prints, one line per printed line.`,
      'Get `key.output` by running the program with python3, not by working it out: a wrong key teaches the wrong thing.',
      `No input(), files, randomness, time, id() or hash(); import nothing but ${ALLOWED_IMPORTS.join(', ')}; never print a set (its order is not fixed).`,
      '`key.misconceptions` lists outputs that a typical misreading produces, each with a misconception id; put the feedback for each id in the item\'s misconceptionFeedback.',
      'Answers are compared line by line. Trailing spaces and trailing blank lines are ignored; quotes, spaces inside a line and line breaks count.',
      '`highlight` (line numbers) draws attention to lines; do not highlight the answer.',
    ],
    example: {
      payload: { language: 'python', source: 'for i in range(1, 4):\n    print(i * 10)' },
      key: { output: '10\n20\n30', misconceptions: [{ output: '10\n20\n30\n40', id: 'range-end-included' }] },
      hints: [{ level: 1, text: 'range(a, b) counts from a up to, but not including, b.' }],
    },
  },
  validateItem: item => {
    const payload = obj(item.payload)
    const key = obj(item.key)
    const source = str(payload.source)
    const out = [...programProblems(source), ...highlightProblems(payload.highlight, source)]
    if (!calledNames(tokenize(source).tokens).includes('print')) out.push(error('code/no-print', 'the program never calls print()'))
    const output = str(key.output)
    for (const m of Array.isArray(key.misconceptions) ? key.misconceptions : []) {
      if (sameOutput(str(obj(m).output), output)) out.push(error('code/misconception', `misconception ${str(obj(m).id)} has the same output as the answer`))
    }
    return out
  },
  fallbackText: payload => {
    const p = obj(payload)
    return `${str(p.prompt) === '' ? 'What does this Python program print?' : str(p.prompt)}\n\n${listing(str(p.source))}\n\n(Type the output exactly, one line per printed line.)`
  },
  reveal: item => ({ output: str(obj(item.key).output) }),
}

/** Write a program; graded by running it on hidden tests in the host's isolated runner. */
export const writeKind: ExerciseKindSpec = {
  id: KIND.write,
  title: 'Write a program',
  environment: ENVIRONMENT,
  responseKind: 'code',
  interaction: 'single',
  grader: RUNNER_GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['prompt', 'language'],
    properties: { prompt: TEXT(600), language: PYTHON, starter: TEXT(2000), examples: { type: 'array', maxItems: 3, items: IO_PAIR } },
  },
  keySchema: {
    type: 'object', additionalProperties: false, required: ['tests'],
    properties: { tests: { type: 'array', minItems: 1, maxItems: 10, items: IO_PAIR } },
  },
  responseSchema: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', maxLength: 10_000 } } },
  guidance: {
    when: 'The learner writes a short program that reads standard input and prints the result. Offered only because this host runs programs in an isolated code runner.',
    rules: [
      '`examples` (at most 3) are shown to the learner; `key.tests` are hidden and run only when the learner submits.',
      'Every expected output must be what a correct program prints: check them by running a reference solution.',
      'Outputs are compared like code.predict: line by line, ignoring trailing spaces and trailing blank lines.',
      'Say exactly what to print in the prompt, including the format of numbers.',
    ],
    example: {
      payload: { prompt: 'Read a whole number n and print 1 + 2 + … + n.', language: 'python', examples: [{ input: '3\n', output: '6\n' }] },
      key: { tests: [{ input: '1\n', output: '1\n' }, { input: '10\n', output: '55\n' }, { input: '100\n', output: '5050\n' }] },
    },
  },
  validateItem: item => {
    const payload = obj(item.payload)
    const problem = tokenize(str(payload.starter)).error
    return problem === undefined ? [] : [error('code/syntax', `the starter code: line ${problem.line}: ${problem.message}`)]
  },
  fallbackText: payload => {
    const p = obj(payload)
    const examples = (Array.isArray(p.examples) ? p.examples : []).map(obj)
      .map((e, i) => `Example ${i + 1}\nInput:\n${str(e.input).replace(/\n$/u, '')}\nOutput:\n${str(e.output).replace(/\n$/u, '')}`)
    const starter = str(p.starter)
    return [str(p.prompt), ...examples, ...(starter === '' ? [] : [`Starter code:\n${listing(starter)}`]), '(Write a Python 3 program. It reads standard input and prints its answer.)'].join('\n\n')
  },
}

/** Size limits of a sandbox exercise. */
export const SANDBOX_LIMITS = { tests: 20, testChars: 2000, starterChars: 8000, solutionChars: 8000, codeChars: 20_000 } as const

/** The tests of a sandbox payload. */
export function sandboxTests(payload: JsonValue): Array<{ name: string; code: string }> {
  const tests = obj(payload).tests
  return (Array.isArray(tests) ? tests : []).map(obj).map(t => ({ name: str(t.name), code: str(t.code) }))
}

/** Write and run a program in the learner's browser against visible tests. */
export const sandboxKind: ExerciseKindSpec = {
  id: KIND.sandbox,
  title: 'Code sandbox',
  environment: SANDBOX_ENVIRONMENT,
  responseKind: 'code',
  interaction: 'single',
  grader: SANDBOX_GRADER_ID,
  format: { guessable: false },
  payloadSchema: {
    type: 'object', additionalProperties: false, required: ['language', 'prompt', 'tests'],
    properties: {
      language: PYTHON,
      prompt: TEXT(2000),
      starter: { type: 'string', maxLength: SANDBOX_LIMITS.starterChars },
      stdin: { type: 'string', maxLength: 4000 },
      tests: {
        type: 'array', minItems: 1, maxItems: SANDBOX_LIMITS.tests,
        items: { type: 'object', additionalProperties: false, required: ['name', 'code'], properties: { name: TEXT(120), code: TEXT(SANDBOX_LIMITS.testChars) } },
      },
    },
  },
  keySchema: { type: 'object', additionalProperties: false, required: ['solution'], properties: { solution: TEXT(SANDBOX_LIMITS.solutionChars) } },
  responseSchema: {
    type: 'object', additionalProperties: false, required: ['code'],
    properties: {
      code: { type: 'string', maxLength: SANDBOX_LIMITS.codeChars },
      results: {
        type: 'object', additionalProperties: false, required: ['passed', 'total'],
        properties: { passed: { type: 'integer', minimum: 0, maximum: SANDBOX_LIMITS.tests }, total: { type: 'integer', minimum: 0, maximum: SANDBOX_LIMITS.tests } },
      },
    },
  },
  guidance: {
    when: 'The learner writes a short Python 3 program or function in an editor and runs it, with visible tests, in their own browser (Pyodide). For practising writing code; the result is self-reported, so it gives feedback but never counts as mastery evidence.',
    rules: [
      '`tests` are shown to the learner and run after their code, in the same namespace: each is a few lines of Python that raise (usually with assert) when the code is wrong, e.g. "assert add(2, 3) == 5".',
      'Give each test a short `name` that says what it checks.',
      '`starter` is code the editor starts with (a function signature, for example); `stdin` is what input() reads.',
      '`key.solution` is your reference solution, shown to the learner after they submit. Write it before asking and make sure it passes every test.',
      'Only the standard library is available, with no network; keep programs small and quick (a run stops after a few seconds).',
    ],
    example: {
      payload: {
        language: 'python', prompt: 'Write `average(xs)`: the mean of a non-empty list of numbers.',
        starter: 'def average(xs):\n    ...',
        tests: [{ name: 'three numbers', code: 'assert average([1, 2, 3]) == 2' }, { name: 'one number', code: 'assert average([5]) == 5' }],
      },
      key: { solution: 'def average(xs):\n    return sum(xs) / len(xs)' },
    },
  },
  validateItem: item => {
    const payload = obj(item.payload)
    const out: Diagnostic[] = []
    const syntax = (source: string, where: string): void => {
      const problem = tokenize(source).error
      if (problem !== undefined) out.push(error('code/syntax', `${where}: line ${problem.line}: ${problem.message}`))
    }
    syntax(str(payload.starter), 'the starter code')
    syntax(str(obj(item.key).solution), 'the solution')
    const names = new Set<string>()
    for (const t of sandboxTests(item.payload)) {
      syntax(t.code, `test "${t.name}"`)
      if (names.has(t.name)) out.push(error('code/test-name', `two tests are called "${t.name}"`))
      names.add(t.name)
    }
    return out
  },
  fallbackText: payload => {
    const p = obj(payload)
    const starter = str(p.starter)
    const tests = sandboxTests(payload).map(t => `- ${t.name}:\n${t.code}`).join('\n')
    return [str(p.prompt), ...(starter === '' ? [] : [`Starter code:\n${listing(starter)}`]), `Tests:\n${tests}`, '(Write Python 3; your code is run in your browser.)'].join('\n\n')
  },
  reveal: item => str(obj(item.key).solution),
}

/** The `code-snippet` lesson block: a program and, optionally, what it prints. */
export const snippetBlock: LessonBlockSpec = {
  name: 'code-snippet',
  version: 1,
  kind: 'leaf',
  attributes: {
    type: 'object', additionalProperties: false, required: ['id', 'source'],
    properties: { id: { type: 'string' }, source: TEXT(2000), output: TEXT(2000), highlight: HIGHLIGHT, caption: TEXT(200) },
  },
  guidance: {
    when: 'Show a short Python program in a lesson, with what it prints.',
    syntax: '{% code-snippet source="for i in range(3):\\n    print(i)" output="0\\n1\\n2" /%}',
    rules: [
      'Write `source` and `output` as one-line strings with \\n for line breaks and \\" for double quotes.',
      '`output` is exactly what python3 prints for the program: run it to get it. Leave `output` out when the program prints nothing.',
      'The program rules of code.predict apply (no input(), files or randomness); keep it under 15 lines.',
      'Lesson programs must not be exercise programs or show an exercise\'s output.',
    ],
  },
  validate: (node: LessonNode) => {
    const source = str(node.attributes.source)
    return [...programProblems(source), ...highlightProblems(node.attributes.highlight, source)]
  },
  fallbackText: (node: LessonNode) => {
    const output = str(node.attributes.output)
    const caption = str(node.attributes.caption)
    return `${listing(str(node.attributes.source))}${output === '' ? '' : `\n\nIt prints:\n${output}`}${caption === '' ? '' : `\n(${caption})`}`
  },
  renderer: RENDERER_ID,
}
