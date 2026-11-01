/**
 * The math renderer: formulas as MathML and graphs as SVG, inside the
 * workspace's sandboxed iframe. It only displays; the learner answers in the
 * workspace's own form. Everything is built with DOM APIs from the safe
 * parser's tree — never from HTML strings.
 */
import { connectRenderer } from '@hodos/plugin-sdk/renderer'
import type { Exercise, JsonObject, JsonValue, LessonNode } from '@hodos/plugin-sdk/protocol'
import { parse } from '../../src/expr.js'
import { sampleFunction, toMathTree, type MathNode, type Viewport } from '../../src/present.js'

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'
const SVG_NS = 'http://www.w3.org/2000/svg'
const SIZE = 320

const root = document.getElementById('root')
if (root === null) throw new Error('renderer markup is missing #root')

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numbers(value: JsonValue | undefined): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : []
}

function buildMath(node: MathNode): Element {
  const el = document.createElementNS(MATHML_NS, node.tag)
  for (const [name, value] of Object.entries(node.attributes ?? {})) el.setAttribute(name, value)
  if (node.text !== undefined) el.textContent = node.text
  for (const child of node.children ?? []) el.append(buildMath(child))
  return el
}

/** A formula (possibly an equation) as MathML, or its plain text when it does not parse. */
function formula(text: string, variables: readonly string[], display: 'inline' | 'block'): Element {
  const sides = text.split('=').map(s => parse(s.trim(), variables))
  if (sides.some(s => !s.ok)) {
    const span = document.createElement('span')
    span.className = 'formula-text'
    span.textContent = text
    return span
  }
  const math = document.createElementNS(MATHML_NS, 'math')
  math.setAttribute('display', display)
  const row = document.createElementNS(MATHML_NS, 'mrow')
  sides.forEach((side, i) => {
    if (i > 0) {
      const eq = document.createElementNS(MATHML_NS, 'mo')
      eq.textContent = '='
      row.append(eq)
    }
    if (side.ok) row.append(buildMath(toMathTree(side.expr).children?.[0] ?? { tag: 'mrow' }))
  })
  math.append(row)
  return math
}

function svg(tag: string, attributes: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value))
  return el
}

/** A graph: grid, axes, functions of x, lines through two points, points. */
function graph(spec: JsonObject, label: string): SVGElement {
  const [x0 = -5, x1 = 5] = numbers(spec.x)
  const [y0 = -5, y1 = 5] = numbers(spec.y)
  const view: Viewport = { x: [x0, x1], y: [y0, y1] }
  const sx = (x: number): number => ((x - x0) / (x1 - x0)) * SIZE
  const sy = (y: number): number => SIZE - ((y - y0) / (y1 - y0)) * SIZE
  const out = svg('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE, role: 'img', 'aria-label': label, class: 'graph' })
  const clip = svg('clipPath', { id: 'plot' })
  clip.append(svg('rect', { x: 0, y: 0, width: SIZE, height: SIZE }))
  out.append(clip)
  if (x1 - x0 <= 24) for (let x = Math.ceil(x0); x <= x1; x++) out.append(svg('line', { x1: sx(x), y1: 0, x2: sx(x), y2: SIZE, class: 'grid' }))
  if (y1 - y0 <= 24) for (let y = Math.ceil(y0); y <= y1; y++) out.append(svg('line', { x1: 0, y1: sy(y), x2: SIZE, y2: sy(y), class: 'grid' }))
  if (x0 <= 0 && x1 >= 0) out.append(svg('line', { x1: sx(0), y1: 0, x2: sx(0), y2: SIZE, class: 'axis' }))
  if (y0 <= 0 && y1 >= 0) out.append(svg('line', { x1: 0, y1: sy(0), x2: SIZE, y2: sy(0), class: 'axis' }))
  const plot = svg('g', { 'clip-path': 'url(#plot)' })
  for (const f of Array.isArray(spec.functions) ? spec.functions : []) {
    const parsed = parse(str(obj(f).expr), ['x'])
    if (!parsed.ok) continue
    for (const piece of sampleFunction(parsed.expr, 'x', view)) {
      plot.append(svg('polyline', { points: piece.map(([x, y]) => `${sx(x).toFixed(2)},${sy(y).toFixed(2)}`).join(' '), class: 'curve' }))
    }
  }
  for (const l of Array.isArray(spec.lines) ? spec.lines : []) {
    const [ax = 0, ay = 0, bx = 1, by = 1] = numbers(l)
    if (ax === bx) {
      plot.append(svg('line', { x1: sx(ax), y1: 0, x2: sx(ax), y2: SIZE, class: 'curve' }))
      continue
    }
    const m = (by - ay) / (bx - ax)
    plot.append(svg('line', { x1: sx(x0), y1: sy(ay + m * (x0 - ax)), x2: sx(x1), y2: sy(ay + m * (x1 - ax)), class: 'curve' }))
  }
  out.append(plot)
  for (const p of Array.isArray(spec.points) ? spec.points : []) {
    const [px = 0, py = 0] = numbers(p)
    out.append(svg('circle', { cx: sx(px), cy: sy(py), r: 4.5, class: 'point' }))
  }
  return out
}

function describeGraph(spec: JsonObject): string {
  const parts: string[] = []
  for (const f of Array.isArray(spec.functions) ? spec.functions : []) parts.push(`y = ${str(obj(f).expr)}`)
  for (const p of Array.isArray(spec.points) ? spec.points : []) parts.push(`point (${numbers(p).join(', ')})`)
  return `Graph: ${parts.join('; ') || 'axes'}`
}

function show(...nodes: Node[]): void {
  root?.replaceChildren(...nodes)
}

function present(exercise: Exercise): void {
  const p = obj(exercise.payload)
  const nodes: Node[] = []
  const prompt = document.createElement('p')
  prompt.className = 'prompt'
  prompt.textContent = str(p.prompt)
  nodes.push(prompt)
  const variables = Array.isArray(p.variables) ? p.variables.filter((v): v is string => typeof v === 'string') : ['x', 'y']
  if (str(p.formula) !== '') {
    const box = document.createElement('div')
    box.className = 'formula'
    box.append(formula(str(p.formula), variables, 'block'))
    nodes.push(box)
  }
  if (p.graph !== undefined) nodes.push(graph(obj(p.graph), describeGraph(obj(p.graph))))
  show(...nodes)
}

function block(node: LessonNode): void {
  if (node.type === 'math-formula') {
    const variables = Array.isArray(node.attributes.variables) ? node.attributes.variables.filter((v): v is string => typeof v === 'string') : []
    const box = document.createElement('div')
    box.className = 'formula'
    box.append(formula(str(node.attributes.expr), variables, 'block'))
    show(box)
  } else if (node.type === 'math-graph') {
    show(graph(node.attributes, describeGraph(node.attributes)))
  }
}

/** Connect to the workspace, then report the page height whenever it changes. */
async function start(): Promise<void> {
  const conn = await connectRenderer(window, {
    onInit: init => { document.documentElement.dataset.theme = init.colorScheme },
    onPresent: present,
    onBlock: block,
    onClear: () => show(),
  })
  const report = (): void => conn.resize(Math.ceil(document.documentElement.scrollHeight))
  new ResizeObserver(report).observe(document.body)
  report()
}

void start()
