/**
 * The code sandbox renderer: an editor where the learner writes Python,
 * runs it with the exercise's visible tests, and submits. Python runs in the
 * learner's own browser with Pyodide (WebAssembly), in a Web Worker started
 * from this sandboxed frame:
 *
 * - the frame is sandboxed in an opaque origin by the host (no cookies, no
 *   access to the workspace or the Harness), and its policy only allows
 *   fetching files from the Hodos server, such as the Pyodide runtime;
 * - the worker is terminated when a run exceeds its time limit, so an
 *   infinite loop stops instead of freezing the page;
 * - the submission carries the code and the number of tests that passed;
 *   the server cannot check that number, so the grade is self-reported.
 *
 * Everything is built with DOM APIs and textContent, never HTML strings.
 */
import { connectRenderer, type RendererConnection } from '@hodos/plugin-sdk/renderer'
import type { Exercise, JsonObject, JsonValue } from '@hodos/plugin-sdk/protocol'

/** Longest a run may take, once Python is loaded. */
const RUN_LIMIT_MS = 8000
/** Longest loading Python may take on first use. */
const LOAD_LIMIT_MS = 60_000

const root = document.getElementById('root')
if (root === null) throw new Error('renderer markup is missing #root')

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className !== '') el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/**
 * The worker: loads Pyodide once, then runs `{ code, tests, stdin }` in a
 * fresh namespace per run and reports output and per-test results. Kept as
 * source text because the worker is started from a `blob:` URL (a sandboxed
 * frame cannot start a worker from the server's URL).
 */
const WORKER_SOURCE = `
let pyodide = null
const RUNNER = [
  'import json, sys, traceback',
  'def __hodos_run(code, tests):',
  '    ns = {"__name__": "__main__"}',
  '    results = []',
  '    try:',
  '        exec(compile(code, "<your code>", "exec"), ns)',
  '    except BaseException:',
  '        traceback.print_exc()',
  '        return json.dumps({"ok": False, "tests": [[n, False, "your code stopped with an error before the tests ran"] for n, _ in tests]})',
  '    for name, src in tests:',
  '        try:',
  '            exec(compile(src, "<test: " + name + ">", "exec"), ns)',
  '            results.append([name, True, ""])',
  '        except AssertionError as e:',
  '            results.append([name, False, str(e) or "the assertion failed"])',
  '        except BaseException as e:',
  '            results.append([name, False, type(e).__name__ + ": " + str(e)])',
  '    return json.dumps({"ok": True, "tests": results})',
].join('\\n')
self.onmessage = async event => {
  const { base, code, tests, stdin } = event.data
  const output = []
  try {
    if (pyodide === null) {
      importScripts(base + 'pyodide/pyodide.js')
      pyodide = await loadPyodide({ indexURL: base + 'pyodide/', stdout: () => {}, stderr: () => {} })
      pyodide.runPython(RUNNER)
      self.postMessage({ type: 'loaded' })
    }
    pyodide.setStdout({ batched: line => output.push(line) })
    pyodide.setStderr({ batched: line => output.push(line) })
    const lines = String(stdin || '').split('\\n')
    pyodide.setStdin({ stdin: () => (lines.length > 0 ? lines.shift() : undefined) })
    const run = pyodide.globals.get('__hodos_run')
    const result = JSON.parse(run(code, pyodide.toPy(tests.map(t => [t.name, t.code]))))
    run.destroy()
    self.postMessage({ type: 'done', output: output.join('\\n'), ok: result.ok, tests: result.tests })
  } catch (error) {
    self.postMessage({ type: 'failed', output: output.join('\\n'), message: String(error && error.message || error) })
  }
}
`

interface TestResult { readonly name: string; readonly passed: boolean; readonly message: string }
type RunReply =
  | { readonly type: 'done'; readonly output: string; readonly ok: boolean; readonly tests: ReadonlyArray<readonly [string, boolean, string]> }
  | { readonly type: 'failed'; readonly output: string; readonly message: string }
  | { readonly type: 'timeout' }

/** Runs Python in a worker that is replaced after a timeout. */
class PythonRunner {
  private worker: Worker | null = null
  private loaded = false
  private readonly base = new URL('.', window.location.href).href

  private start(): Worker {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
    const worker = new Worker(url)
    URL.revokeObjectURL(url)
    worker.addEventListener('message', event => {
      if ((event.data as { type?: string }).type === 'loaded') this.loaded = true
    })
    return worker
  }

  /** Whether Python is loaded (the next run is fast). */
  get ready(): boolean {
    return this.loaded
  }

  run(code: string, cases: ReadonlyArray<{ name: string; code: string }>, stdin: string): Promise<RunReply> {
    const worker = this.worker ?? this.start()
    this.worker = worker
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        worker.terminate()
        if (this.worker === worker) {
          this.worker = null
          this.loaded = false
        }
        resolve({ type: 'timeout' })
      }, this.loaded ? RUN_LIMIT_MS : LOAD_LIMIT_MS)
      const onMessage = (event: MessageEvent): void => {
        const data = event.data as { type?: string }
        if (data.type !== 'done' && data.type !== 'failed') return
        clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        resolve(event.data as RunReply)
      }
      worker.addEventListener('message', onMessage)
      worker.postMessage({ base: this.base, code, tests: cases.map(t => ({ name: t.name, code: t.code })), stdin }, [])
    })
  }
}

const python = new PythonRunner()
let connection: RendererConnection | null = null
let current: Exercise | null = null
let locked = false
let lastRun: { code: string; passed: number; total: number } | null = null

const prompt = element('div', 'prompt')
const editor = element('textarea', 'editor')
editor.spellcheck = false
editor.setAttribute('aria-label', 'Your Python code')
editor.rows = 12
const runButton = element('button', 'run', 'Run tests')
const submitButton = element('button', 'submit', 'Submit')
const status = element('p', 'status')
status.setAttribute('role', 'status')
const testList = element('ul', 'tests')
const output = element('pre', 'output')
output.setAttribute('aria-label', 'Output')
const controls = element('div', 'controls')
controls.append(runButton, submitButton)
root.append(prompt, editor, controls, status, testList, output)

function resize(): void {
  // The root's own height: the document is at least as tall as the frame, so it could never shrink.
  connection?.resize(Math.ceil(root?.getBoundingClientRect().height ?? 0) + 8)
}

function tests(): Array<{ name: string; code: string }> {
  const list = obj(current?.payload).tests
  return (Array.isArray(list) ? list : []).map(obj).map(t => ({ name: str(t.name), code: str(t.code) }))
}

function showTests(results: readonly TestResult[] | null): void {
  testList.replaceChildren()
  for (const t of tests()) {
    const r = results?.find(x => x.name === t.name)
    const item = element('li', r === undefined ? 'test' : r.passed ? 'test passed' : 'test failed')
    item.append(element('span', 'mark', r === undefined ? '○' : r.passed ? '✓' : '✗'), element('span', 'name', t.name))
    const detail = element('details', '')
    detail.append(element('summary', '', 'test code'), element('pre', '', t.code))
    item.append(detail)
    if (r !== undefined && !r.passed) item.append(element('div', 'message', r.message))
    testList.append(item)
  }
  resize()
}

function setBusy(busy: boolean): void {
  runButton.disabled = busy || locked
  submitButton.disabled = busy || locked
  editor.readOnly = locked
}

async function run(): Promise<void> {
  if (current === null) return
  const code = editor.value
  setBusy(true)
  status.textContent = python.ready ? 'Running…' : 'Loading Python (first run only)…'
  const reply = await python.run(code, tests(), str(obj(current.payload).stdin))
  setBusy(false)
  if (reply.type === 'timeout') {
    status.textContent = `Stopped after ${RUN_LIMIT_MS / 1000} s: is there an endless loop?`
    output.textContent = ''
    lastRun = null
    showTests(null)
    return
  }
  output.textContent = reply.output === '' ? '(no output)' : reply.output
  if (reply.type === 'failed') {
    status.textContent = `Python could not run: ${reply.message}`
    lastRun = null
    showTests(null)
    return
  }
  const results = reply.tests.map(([name, passed, message]) => ({ name, passed, message }))
  const passed = results.filter(r => r.passed).length
  lastRun = { code, passed, total: results.length }
  status.textContent = !reply.ok ? 'Your code stopped with an error; see the output.' : `${passed} of ${results.length} tests passed.`
  showTests(results)
}

function submit(): void {
  if (current === null || connection === null || locked) return
  if (lastRun === null || lastRun.code !== editor.value) {
    status.textContent = 'Run the tests on this code before you submit.'
    return
  }
  connection.respond(current.id, { code: editor.value, results: { passed: lastRun.passed, total: lastRun.total } })
}

runButton.addEventListener('click', () => { void run() })
submitButton.addEventListener('click', submit)
editor.addEventListener('keydown', event => {
  // Tab indents instead of leaving the editor; Escape then Tab leaves it.
  if (event.key !== 'Tab' || event.shiftKey || editor.dataset.escaped === 'yes') return
  event.preventDefault()
  const { selectionStart: start, selectionEnd: end } = editor
  editor.setRangeText('    ', start, end, 'end')
})
editor.addEventListener('keyup', event => { editor.dataset.escaped = event.key === 'Escape' ? 'yes' : 'no' })
editor.addEventListener('input', () => { editor.dataset.escaped = 'no' })

async function connect(): Promise<void> {
  connection = await connectRenderer(window, handlers)
  resize()
}

const handlers: Parameters<typeof connectRenderer>[1] = {
  onInit: init => { document.documentElement.dataset.scheme = init.colorScheme },
  onPresent: exercise => {
    current = exercise
    lastRun = null
    const payload = obj(exercise.payload)
    prompt.textContent = str(payload.prompt)
    editor.value = str(payload.starter)
    status.textContent = 'Write your code, run the tests, then submit.'
    output.textContent = ''
    showTests(null)
  },
  onLock: value => {
    locked = value
    setBusy(false)
  },
  onResult: result => {
    locked = true
    setBusy(false)
    status.textContent = result.correct ? 'Submitted: every test passed.' : 'Submitted.'
    if (typeof result.reveal === 'string') {
      const solution = element('details', 'solution')
      solution.append(element('summary', '', 'Reference solution'), element('pre', '', result.reveal))
      root.append(solution)
      resize()
    }
  },
}

void connect()
