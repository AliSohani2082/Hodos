import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExerciseItem, GradeInput, JsonObject, JsonValue, LessonNode } from '@hodos/plugin-sdk'
import {
  calledNames,
  compareOutput,
  cpythonVerifiedIds,
  createCodePlugin,
  createWriteGrader,
  FEEDBACK,
  FORMAT_CREDIT,
  gradePredict,
  importedModules,
  KIND,
  outputLines,
  predictKind,
  RUN_STATUSES,
  snippetBlock,
  snippets,
  tokenize,
  tracingCourse,
  writeKind,
  type CodeRunner,
  type RunOutcome,
  type RunRequest,
} from '../src/index.js'

// The live check runs when HODOS_PYTHON names a CPython interpreter.
const PYTHON = process.env.HODOS_PYTHON ?? ''

const course = tracingCourse()
const item = (id: string): ExerciseItem => {
  const found = course.items.find(i => i.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}
const str = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '')
const keyOf = (entry: ExerciseItem): JsonObject => (typeof entry.key === 'object' && entry.key !== null && !Array.isArray(entry.key) ? entry.key : {})
const payloadOf = (entry: ExerciseItem): JsonObject => (typeof entry.payload === 'object' && entry.payload !== null && !Array.isArray(entry.payload) ? entry.payload : {})
const input = (entry: ExerciseItem, response: JsonValue): GradeInput => ({ kind: entry.kind, payload: entry.payload, key: entry.key, response, mode: 'practice', skills: entry.skills, attempt: 1 })
const codes = (entry: ExerciseItem, severity: 'error' | 'warning' = 'error'): string[] => (predictKind.validateItem?.(entry) ?? []).filter(d => d.severity === severity).map(d => d.code)
const withSource = (entry: ExerciseItem, source: string): ExerciseItem => ({ ...entry, payload: { ...payloadOf(entry), source } })

const node = (attributes: JsonObject): LessonNode => ({ id: 'b', type: 'code-snippet', attributes: { id: 'b', ...attributes } })

describe('tokenizer', () => {
  it('classifies tokens and keeps every character', () => {
    const source = 'def f(xs):  # sum\n    return sum(xs) * 2.5 + len("a\\"b")\n'
    const { tokens, error } = tokenize(source)
    expect(error).toBeUndefined()
    expect(tokens.map(t => t.text).join('')).toBe(source)
    const of = (type: string): string[] => tokens.filter(t => t.type === type).map(t => t.text)
    expect(of('keyword')).toEqual(['def', 'return'])
    expect(of('builtin')).toEqual(['sum', 'len'])
    expect(of('number')).toEqual(['2.5'])
    expect(of('string')).toEqual(['"a\\"b"'])
    expect(of('comment')).toEqual(['# sum'])
    expect(tokens.find(t => t.text === 'return')?.line).toBe(2)
  })

  it('reads triple-quoted strings, prefixes and continuations across lines', () => {
    const { tokens, error } = tokenize('s = f"""a\n{b}"""\nt = r\'\\d\' \\\n  + "x"\nprint(s)')
    expect(error).toBeUndefined()
    expect(tokens.filter(t => t.type === 'string').map(t => t.text)).toEqual(['f"""a\n{b}"""', "r'\\d'", '"x"'])
    expect(tokens.find(t => t.text === 'print')?.line).toBe(5)
  })

  it('reports unterminated strings and unknown characters with their line', () => {
    expect(tokenize('x = 1\nprint("hi)\n').error).toEqual({ message: 'a string is not closed', line: 2 })
    expect(tokenize('a = 1 $ 2').error).toEqual({ message: 'unexpected character "$"', line: 1 })
    expect(tokenize('x = """open\n').error?.message).toBe('a string is not closed')
  })

  it('finds imports and direct calls', () => {
    expect(importedModules(tokenize('import math, os.path as p\nfrom random import randint\nimport sys').tokens)).toEqual(['math', 'os', 'random', 'sys'])
    expect(calledNames(tokenize('def f(x):\n    return len(x)\nxs.append(1)\nprint(f([1]))').tokens)).toEqual(['len', 'print', 'f'])
  })
})

describe('output comparison', () => {
  it('ignores line endings, trailing spaces and trailing blank lines only', () => {
    expect(outputLines('a  \r\nb\n\n\n')).toEqual(['a', 'b'])
    expect(compareOutput('a\nb', 'a \r\nb\n')).toEqual({ kind: 'same' })
    expect(compareOutput('a\nb', ' a\nb')).toEqual({ kind: 'line', line: 1 })
    expect(compareOutput('a\n\nb', 'a\nb')).toEqual({ kind: 'line', line: 2 })
    expect(compareOutput('a\nb', 'a')).toEqual({ kind: 'missing-lines' })
    expect(compareOutput('a', 'a\nb')).toEqual({ kind: 'extra-lines' })
  })
})

describe('predict-the-output grading', () => {
  it('accepts the exact output however it was typed', () => {
    expect(gradePredict(input(item('loop-1'), { text: '1\r\n2\n3   \n\n' }))).toMatchObject({ correct: true, score: 1 })
  })

  it('names listed misreadings', () => {
    expect(gradePredict(input(item('var-1'), { text: '8 8' }))).toMatchObject({ correct: false, score: 0, misconceptions: ['assignment-links'] })
    expect(gradePredict(input(item('loop-1'), { text: '1\n2\n3\n4' })).misconceptions).toEqual(['range-end-included'])
    expect(gradePredict(input(item('fn-1'), { text: '8' })).misconceptions).toEqual(['return-vs-print'])
    expect(gradePredict(input(item('list-3'), { text: '[1, 2]' })).misconceptions).toEqual(['aliasing'])
  })

  it('gives partial credit for the right values with wrong quotes or spacing', () => {
    expect(gradePredict(input(item('list-c1'), { text: 'red\n[red, green, blue]' }))).toMatchObject({ correct: false, score: FORMAT_CREDIT, misconceptions: ['quotes'] })
    expect(gradePredict(input(item('list-c1'), { text: "'red'\n['red', 'green', 'blue']" })).misconceptions).toEqual(['quotes'])
    expect(gradePredict(input(item('var-1'), { text: '8\n5' }))).toMatchObject({ score: FORMAT_CREDIT, misconceptions: ['spacing'] })
  })

  it('says where the answer departs from the output, never what the output is', () => {
    expect(gradePredict(input(item('if-3'), { text: 'even\nbig' })).feedback).toBe('The first line is not what the program prints.')
    expect(gradePredict(input(item('loop-c3'), { text: '10\n6\n3' })).feedback).toBe('Lines 1–2 are right; line 3 is not what the program prints.')
    expect(gradePredict(input(item('loop-c3'), { text: '10\n6' })).feedback).toBe('Right so far, but the program prints more lines.')
    expect(gradePredict(input(item('ex-1'), { text: '' })).feedback).toContain('Type what the program prints')
    const templates = /^(Correct\.|The first line is not what the program prints\.|Line 1 is right; line \d+ is not what the program prints\.|Lines 1–\d+ are right; line \d+ is not what the program prints\.|Right so far, but the program prints more lines\.|The program prints fewer lines than that\.|The values are right; check the (quotes|spaces and line breaks)\.)$/u
    for (const entry of course.items) {
      for (const text of ['x', '0\n0\n0\n0\n0', str(keyOf(entry).output).toUpperCase(), `${str(keyOf(entry).output)}\nextra`]) {
        expect(gradePredict(input(entry, { text })).feedback ?? '', entry.id).toMatch(templates)
      }
    }
  })
})

describe('items, lessons and validation', () => {
  it('has only valid items and full coverage of every skill', () => {
    for (const entry of course.items) {
      expect(codes(entry), entry.id).toEqual([])
      expect(codes(entry, 'warning'), entry.id).toEqual([])
    }
    for (const skill of course.skills) {
      const of = (mode: string): number => course.items.filter(i => i.skills.some(s => s.skillId === skill.id) && i.modes.some(m => m === mode)).length
      expect(of('practice'), skill.id).toBeGreaterThanOrEqual(3)
      expect(of('checkpoint'), skill.id).toBeGreaterThanOrEqual(3)
      expect(of('diagnostic'), skill.id).toBeGreaterThanOrEqual(1)
    }
  })

  it('gives feedback for every misconception an item can detect', () => {
    for (const entry of course.items) {
      const listed = keyOf(entry).misconceptions
      const ids = Array.isArray(listed) ? listed.flatMap(m => (typeof m === 'object' && m !== null && !Array.isArray(m) && typeof m.id === 'string' ? [m.id] : [])) : []
      expect(ids.length, entry.id).toBeGreaterThan(0)
      for (const id of ids) {
        expect(FEEDBACK[id], `${entry.id}: ${id}`).toBeDefined()
        expect(entry.misconceptionFeedback?.[id], `${entry.id}: ${id}`).toBe(FEEDBACK[id])
      }
      expect(Object.keys(entry.misconceptionFeedback ?? {})).toEqual(expect.arrayContaining(['quotes', 'spacing']))
    }
  })

  it('keeps lesson programs apart from exercise programs', () => {
    const exercisePrograms = new Set(course.items.map(i => str(payloadOf(i).source)))
    const lessonPrograms = snippets().filter(s => s.id.includes('/'))
    expect(lessonPrograms.length).toBeGreaterThanOrEqual(course.lessons.length)
    for (const s of lessonPrograms) expect(exercisePrograms.has(s.source), s.id).toBe(false)
  })

  it('catches programs whose output is not fixed or that cannot be read', () => {
    const base = item('var-1')
    expect(codes(withSource(base, 'print("hi)'))).toContain('code/syntax')
    expect(codes(withSource(base, 'import os\nprint(os.getcwd())'))).toContain('code/import')
    expect(codes(withSource(base, 'import math\nprint(math.pi)'))).toEqual([])
    expect(codes(withSource(base, 'name = input()\nprint(name)'))).toContain('code/unsupported-call')
    expect(codes(withSource(base, 'print(id(1))'))).toContain('code/unsupported-call')
    expect(codes(withSource(base, 'x = 1  # print(x)'))).toContain('code/no-print')
    expect(codes(withSource(base, Array.from({ length: 31 }, (_, i) => `print(${i})`).join('\n')))).toContain('code/too-long')
    expect(codes(withSource(base, 'print(set("ab"))'), 'warning')).toContain('code/set-order')
    expect(codes({ ...base, payload: { ...payloadOf(base), highlight: [9] } })).toContain('code/highlight')
    expect(codes({ ...base, key: { output: '8 5', misconceptions: [{ output: '8 5  \n', id: 'same' }] } })).toContain('code/misconception')
  })

  it('validates lesson snippets with the same rules', () => {
    expect(snippetBlock.validate?.(node({ source: 'print(1)', output: '1' }))).toEqual([])
    expect(snippetBlock.validate?.(node({ source: 'import socket\nprint(1)' })).map(d => d.code)).toContain('code/import')
    expect(snippetBlock.fallbackText(node({ source: 'x = 2\nprint(x)', output: '2' }))).toBe('1 | x = 2\n2 | print(x)\n\nIt prints:\n2')
  })

  it('shows every exercise as numbered plain text without its output', () => {
    for (const entry of course.items) expect(predictKind.fallbackText(entry.payload), entry.id).toContain('1 | ')
    // Multi-line outputs are specific enough to search for in the prompt text.
    const multiLine = course.items.filter(entry => str(keyOf(entry).output).includes('\n'))
    expect(multiLine.length).toBeGreaterThan(0)
    for (const entry of multiLine) expect(predictKind.fallbackText(entry.payload), entry.id).not.toContain(str(keyOf(entry).output))
    expect(predictKind.reveal?.(item('ex-2'))).toEqual({ output: '34\n7\nababab' })
  })
})

describe('CPython verification', () => {
  it('carries a CPython record for exactly the current programs', () => {
    // Changing any program or output voids the record; re-run `pnpm verify:snippets --write`.
    expect([...cpythonVerifiedIds()].toSorted()).toEqual(snippets().map(s => s.id).toSorted())
    const verifiedItems = tracingCourse(cpythonVerifiedIds()).items.filter(i => i.provenance?.verifiedBy?.includes('cpython'))
    expect(verifiedItems).toHaveLength(course.items.length)
  })

  it.skipIf(PYTHON === '' || !existsSync(PYTHON))('prints exactly the expected output under CPython (and the check catches a wrong key)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hodos-code-test-'))
    try {
      const run = (source: string): string => {
        const result = spawnSync(PYTHON, ['-I', '-X', 'utf8', '-c', source], { cwd: scratch, env: { PATH: '/usr/bin:/bin' }, input: '', encoding: 'utf8', timeout: 5000 })
        expect(result.status, source).toBe(0)
        return result.stdout
      }
      for (const s of snippets()) expect(outputLines(run(s.source)), s.id).toEqual(outputLines(s.output))
      // Negative control: a key that is off by one is noticed.
      expect(outputLines(run('for i in range(1, 4):\n    print(i)'))).not.toEqual(outputLines('1\n2\n3\n4'))
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

/** A stand-in runner: it looks answers up in a table and executes nothing. */
function tableRunner(table: (request: RunRequest, input: string) => RunOutcome, seen: RunRequest[] = []): CodeRunner {
  return {
    isolation: 'test table (executes nothing)',
    languages: ['python'],
    run: request => {
      seen.push(request)
      return Promise.resolve(request.inputs.map(i => table(request, i)))
    },
  }
}

const writeItem: ExerciseItem = {
  id: 'w-1', kind: KIND.write, skills: [{ skillId: 'py.functions', weight: 1 }], difficulty: 0, modes: ['practice'],
  payload: { prompt: 'Read n and print 1 + 2 + … + n.', language: 'python', examples: [{ input: '3\n', output: '6\n' }] },
  key: { tests: [{ input: '1\n', output: '1\n' }, { input: '10\n', output: '55\n' }, { input: '100\n', output: '5050\n' }] },
}
const sum = (stdin: string): string => {
  const n = Number(stdin.trim())
  return `${(n * (n + 1)) / 2}\n`
}
const ok = (stdout: string): RunOutcome => ({ status: 'ok', stdout, stderr: '' })

/** Grade a submission with a short budget. */
const grader = (runner: CodeRunner): Promise<unknown> => createWriteGrader(runner, 200)(input(writeItem, { code: 'print(1)' }))
/** A runner that answers every input with the same (possibly malformed) outcome. */
const malformed = (outcome: unknown): CodeRunner => ({ isolation: 'x', languages: ['python'], run: r => Promise.resolve(r.inputs.map(() => outcome as RunOutcome)) })

describe('code-writing exercises (runner contract; no runner ships)', () => {
  it('is not offered without a runner', () => {
    const plugin = createCodePlugin()
    expect(plugin.manifest.capabilities.exerciseKinds).toEqual([KIND.predict])
    expect(plugin.manifest.capabilities.graders).toEqual(['code.grader'])
    expect(createCodePlugin({ runner: tableRunner(() => ok('')) }).manifest.capabilities.exerciseKinds).toEqual([KIND.predict, KIND.write])
    expect(() => createCodePlugin({ runner: { isolation: 'x', languages: ['ruby'], run: () => Promise.resolve([]) } })).toThrow(/python/)
    expect(() => createCodePlugin({ runner: { isolation: ' ', languages: ['python'], run: () => Promise.resolve([]) } })).toThrow(/isolation/)
  })

  it('sends the runner only the source and the inputs', async () => {
    const seen: RunRequest[] = []
    const grade = await createWriteGrader(tableRunner((_r, i) => ok(sum(i)), seen), 1000)(input(writeItem, { code: 'n = int(input())\nprint(n * (n + 1) // 2)' }))
    expect(grade).toMatchObject({ correct: true, score: 1, feedback: 'All tests passed.' })
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0] ?? {}).toSorted()).toEqual(['inputs', 'language', 'limits', 'signal', 'source'])
    expect(seen[0]?.inputs).toEqual(['3\n', '1\n', '10\n', '100\n'])
    expect(JSON.stringify(seen[0])).not.toContain('5050')
  })

  it('reports hidden tests as counts only, never their data or the program\'s output', async () => {
    // A program that echoes its input and raises with it: the hidden inputs must not come back.
    const grade = await createWriteGrader(tableRunner((_r, i) => (i === '10\n'
      ? { status: 'error', stdout: 'echo 10', stderr: 'Traceback (most recent call last):\n  File "<string>", line 1\nValueError: hidden input was 10 and 55' }
      : i === '100\n' ? { status: 'timeout', stdout: '', stderr: '' } : ok(sum(i)))), 1000)(input(writeItem, { code: 'print(...)' }))
    expect(grade).toMatchObject({ correct: false, score: 0.5 })
    expect(grade.feedback).toBe('Hidden tests: 1 of 3 passed (1 stopped with an error, 1 ran out of time).')
    expect(grade.details).toEqual({ passed: 2, total: 4, results: ['pass', 'pass', 'error', 'timeout'] })
  })

  it('explains failed examples without echoing the program\'s output', async () => {
    const grade = await createWriteGrader(tableRunner((_r, i) => (i === '3\n'
      ? { status: 'error', stdout: '', stderr: 'Traceback (most recent call last):\nZeroDivisionError: division by zero' }
      : ok('wrong\n'))), 1000)(input(writeItem, { code: 'print(1/0)' }))
    expect(grade.feedback).toBe('Example 1: your program stopped with ZeroDivisionError. Hidden tests: 0 of 3 passed (3 wrong output).')
    const odd = await createWriteGrader(tableRunner(() => ({ status: 'error', stdout: '', stderr: 'secret text 1\n55' })), 1000)(input(writeItem, { code: 'x' }))
    expect(odd.feedback).toContain('stopped with an error.')
    expect(odd.feedback).not.toContain('55')
  })

  it('fails closed on a malformed, short or slow runner', async () => {
    await expect(grader(malformed({ status: 'passed', stdout: '', stderr: '' }))).rejects.toThrow(/malformed/)
    await expect(grader(malformed({ status: 'ok', stdout: 1, stderr: '' }))).rejects.toThrow(/malformed/)
    await expect(grader({ isolation: 'x', languages: ['python'], run: () => Promise.resolve([ok('6\n')]) })).rejects.toThrow(/1 outcomes for 4 inputs/)
    let aborted = false
    const slow: CodeRunner = { isolation: 'x', languages: ['python'], run: r => new Promise(() => { r.signal.addEventListener('abort', () => { aborted = true }) }) }
    await expect(grader(slow)).rejects.toThrow(/did not answer within 200 ms/)
    expect(aborted).toBe(true)
    expect(RUN_STATUSES).toEqual(['ok', 'error', 'timeout', 'memory', 'output-limit'])
  })

  it('treats output beyond the limit as a failed run', async () => {
    const grade = await createWriteGrader(tableRunner(() => ok('6\n'.repeat(20_000))), 1000)(input(writeItem, { code: 'while True: print(6)' }))
    expect(grade.details).toMatchObject({ passed: 0, results: ['output-limit', 'output-limit', 'output-limit', 'output-limit'] })
  })

  it('validates and shows code-writing items', () => {
    expect(writeKind.validateItem?.({ ...writeItem, payload: { ...payloadOf(writeItem), starter: 'def f(:\n    "x' } }).map(d => d.code)).toEqual(['code/syntax'])
    const text = writeKind.fallbackText(writeItem.payload)
    expect(text).toContain('Example 1\nInput:\n3\nOutput:\n6')
    expect(text).not.toContain('5050')
    expect(writeKind.reveal).toBeUndefined()
  })
})

describe('security: this package never runs code', () => {
  it('imports no process, VM or worker APIs and evaluates nothing', () => {
    const dir = new URL('../src/', import.meta.url)
    for (const file of readdirSync(dir)) {
      const text = readFileSync(new URL(file, dir), 'utf8')
      expect(text, file).not.toMatch(/child_process|node:vm|worker_threads|new Function|\beval\s*\(|\bexecSync\b|\bspawn\b/u)
    }
  })
})
