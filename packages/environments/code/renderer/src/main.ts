/**
 * The code renderer: Python programs shown read-only with line numbers and
 * highlighting, inside the workspace's sandboxed iframe. It only displays;
 * the learner answers in the workspace's own form. Everything is built with
 * DOM APIs and textContent from the tokenizer's output — never from HTML
 * strings — so program text can never become markup.
 */
import { connectRenderer } from '@hodos/plugin-sdk/renderer'
import type { Exercise, HostToRendererMessage, JsonObject, JsonValue, LessonNode } from '@hodos/plugin-sdk/protocol'
import { tokenize, type TokenType } from '../../src/python.js'

const root = document.getElementById('root')
if (root === null) throw new Error('renderer markup is missing #root')

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numbers(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v)) : []
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className !== '') el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

/** Token classes that get a colour; the rest stay plain text. */
const STYLED: ReadonlySet<TokenType> = new Set(['keyword', 'builtin', 'number', 'string', 'comment', 'operator', 'error'])

/** A program as a highlighted, line-numbered listing. */
function listing(source: string, highlight: readonly number[]): HTMLElement {
  const text = source.replace(/\n+$/u, '')
  const pre = element('pre', 'code')
  pre.tabIndex = 0
  pre.setAttribute('role', 'region')
  const count = text.split('\n').length
  pre.setAttribute('aria-label', `Python program, ${count} ${count === 1 ? 'line' : 'lines'}`)
  const code = element('code', '')
  const width = String(count).length
  const open = (n: number): HTMLElement => {
    const line = element('span', highlight.includes(n) ? 'line hl' : 'line')
    line.dataset.line = String(n)
    line.append(element('span', 'ln', String(n).padStart(width)))
    const src = element('span', 'src')
    line.append(src)
    code.append(line)
    return src
  }
  let lineNo = 1
  let current = open(lineNo)
  for (const token of tokenize(text).tokens) {
    // Strings and line continuations can span lines.
    const parts = token.text.split('\n')
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        lineNo += 1
        current = open(lineNo)
      }
      const part = parts[i] ?? ''
      if (part === '') continue
      if (STYLED.has(token.type)) current.append(element('span', `tok-${token.type}`, part))
      else current.append(document.createTextNode(part))
    }
  }
  pre.append(code)
  return pre
}

/** A labelled block of program output. */
function outputPanel(label: string, output: string): HTMLElement {
  const box = element('div', 'output')
  box.append(element('div', 'output-label', label))
  box.append(element('pre', 'output-text', output.replace(/\n+$/u, '')))
  return box
}

let reveal: HTMLElement | null = null

function show(...nodes: Node[]): void {
  reveal = null
  root?.replaceChildren(...nodes)
}

function present(exercise: Exercise): void {
  const p = obj(exercise.payload)
  const nodes: Node[] = []
  if (exercise.kind === 'code.write') {
    nodes.push(element('p', 'prompt', str(p.prompt)))
    const examples = (Array.isArray(p.examples) ? p.examples : []).map(obj)
    examples.forEach((e, i) => {
      const box = element('section', 'example')
      box.append(element('h3', '', `Example ${i + 1}`))
      box.append(outputPanel('Input', str(e.input)))
      box.append(outputPanel('Output', str(e.output)))
      nodes.push(box)
    })
    if (str(p.starter) !== '') {
      nodes.push(element('p', 'note', 'Starter code:'))
      nodes.push(listing(str(p.starter), []))
    }
  } else {
    nodes.push(element('p', 'prompt', str(p.prompt) === '' ? 'What does this program print?' : str(p.prompt)))
    nodes.push(listing(str(p.source), numbers(p.highlight)))
  }
  show(...nodes)
}

function result(message: Extract<HostToRendererMessage, { type: 'hodos:result' }>): void {
  const output = obj(message.reveal).output
  if (typeof output !== 'string') return
  reveal?.remove()
  reveal = outputPanel('The program prints', output)
  root?.append(reveal)
}

function block(node: LessonNode): void {
  if (node.type !== 'code-snippet') return
  const nodes: Node[] = [listing(str(node.attributes.source), numbers(node.attributes.highlight))]
  const output = str(node.attributes.output)
  if (output !== '') nodes.push(outputPanel('Output', output))
  show(...nodes)
}

void connectRenderer(window, {
  onInit: init => { document.documentElement.dataset.theme = init.colorScheme },
  onPresent: present,
  onResult: result,
  onBlock: block,
  onClear: () => show(),
}).then(conn => {
  const report = (): void => conn.resize(Math.ceil(document.documentElement.scrollHeight))
  new ResizeObserver(report).observe(document.body)
  report()
})
