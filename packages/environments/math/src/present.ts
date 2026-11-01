/**
 * Presenting expressions and graphs: readable plain text, a MathML tree
 * (built into DOM nodes by the renderer, never as an HTML string), and the
 * sampled path of a function for an SVG plot. Browser-safe.
 * @module @hodos/math/present
 */
import { evaluate, type Expr } from './expr.js'

const PRECEDENCE: Readonly<Record<string, number>> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 }

function precedence(expr: Expr): number {
  if (expr.type === 'bin') return PRECEDENCE[expr.op] ?? 5
  if (expr.type === 'neg') return 3
  return 5
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)))
}

/**
 * Write an expression as plain text, with only the parentheses it needs.
 * @param expr - the expression.
 * @returns e.g. `2x^2 + 3x - 1`.
 */
export function toText(expr: Expr): string {
  const wrap = (e: Expr, min: number): string => (precedence(e) < min ? `(${toText(e)})` : toText(e))
  switch (expr.type) {
    case 'num': return formatNumber(expr.value)
    case 'var': return expr.name
    case 'const': return expr.name === 'pi' ? 'π' : 'e'
    case 'neg': return `-${wrap(expr.arg, 3)}`
    case 'call': return `${expr.fn}(${toText(expr.arg)})`
    case 'bin': {
      if (expr.op === '+' || expr.op === '-') return `${wrap(expr.left, 1)} ${expr.op} ${wrap(expr.right, 2)}`
      if (expr.op === '*') {
        const implicit = expr.left.type === 'num' && (expr.right.type === 'var' || (expr.right.type === 'bin' && expr.right.op === '^' && expr.right.left.type === 'var'))
        return implicit ? `${toText(expr.left)}${wrap(expr.right, 3)}` : `${wrap(expr.left, 2)} · ${wrap(expr.right, 3)}`
      }
      if (expr.op === '/') return `${wrap(expr.left, 2)}/${wrap(expr.right, 3)}`
      return `${wrap(expr.left, 5)}^${wrap(expr.right, 5)}`
    }
    default: return unknownNode(expr)
  }
}

/** Close an exhaustive switch over expression nodes (this module also runs in the renderer, so it has its own). */
function unknownNode(node: never): never {
  throw new Error(`unknown expression node ${JSON.stringify(node)}`)
}

/** A MathML element: a tag with children, or a token element with text. */
export interface MathNode {
  readonly tag: 'math' | 'mrow' | 'mn' | 'mi' | 'mo' | 'mfrac' | 'msup' | 'msqrt'
  readonly text?: string
  readonly children?: readonly MathNode[]
  readonly attributes?: Readonly<Record<string, string>>
}

const mo = (text: string): MathNode => ({ tag: 'mo', text })
const row = (...children: MathNode[]): MathNode => ({ tag: 'mrow', children })
const fenced = (inner: MathNode): MathNode => row(mo('('), inner, mo(')'))

function mathNode(expr: Expr): MathNode {
  const wrap = (e: Expr, min: number): MathNode => (precedence(e) < min ? fenced(mathNode(e)) : mathNode(e))
  switch (expr.type) {
    case 'num': return { tag: 'mn', text: formatNumber(expr.value) }
    case 'var': return { tag: 'mi', text: expr.name }
    case 'const': return { tag: 'mi', text: expr.name === 'pi' ? 'π' : 'e' }
    case 'neg': return row(mo('−'), wrap(expr.arg, 3))
    case 'call':
      if (expr.fn === 'sqrt') return { tag: 'msqrt', children: [mathNode(expr.arg)] }
      if (expr.fn === 'abs') return row(mo('|'), mathNode(expr.arg), mo('|'))
      return row({ tag: 'mi', text: expr.fn }, mo('⁡'), fenced(mathNode(expr.arg)))
    case 'bin':
      switch (expr.op) {
        case '+': return row(wrap(expr.left, 1), mo('+'), wrap(expr.right, 2))
        case '-': return row(wrap(expr.left, 1), mo('−'), wrap(expr.right, 2))
        case '*': {
          const implicit = expr.left.type === 'num' && expr.right.type !== 'num'
          return implicit ? row(mathNode(expr.left), mo('⁢'), wrap(expr.right, 3)) : row(wrap(expr.left, 2), mo('·'), wrap(expr.right, 3))
        }
        case '/': return { tag: 'mfrac', children: [mathNode(expr.left), mathNode(expr.right)] }
        case '^': return { tag: 'msup', children: [wrap(expr.left, 5), mathNode(expr.right)] }
        default: return unknownNode(expr.op)
      }
    default: return unknownNode(expr)
  }
}

/**
 * The MathML tree of an expression.
 * @param expr - the expression.
 * @param display - inline or block layout.
 * @returns a `<math>` node.
 */
export function toMathTree(expr: Expr, display: 'inline' | 'block' = 'inline'): MathNode {
  return { tag: 'math', attributes: { display }, children: [mathNode(expr)] }
}

function escape(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

/** Serialize a MathML tree (for tests and server-side checks; the renderer builds DOM nodes). */
export function serializeMath(node: MathNode): string {
  const attrs = Object.entries(node.attributes ?? {}).map(([k, v]) => ` ${k}="${escape(v)}"`).join('')
  const inner = node.text === undefined ? (node.children ?? []).map(serializeMath).join('') : escape(node.text)
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`
}

/** A viewport: x and y ranges. */
export interface Viewport {
  readonly x: readonly [number, number]
  readonly y: readonly [number, number]
}

/**
 * Sample a function of one variable into polyline segments within the viewport.
 * Segments break where the function is undefined or jumps off the viewport.
 * @param expr - the function.
 * @param variable - its variable.
 * @param view - the viewport.
 * @param samples - points across the x range.
 * @returns lists of [x, y] points, one list per continuous piece.
 */
export function sampleFunction(expr: Expr, variable: string, view: Viewport, samples = 400): Array<Array<readonly [number, number]>> {
  const [x0, x1] = view.x
  const [y0, y1] = view.y
  const span = y1 - y0
  const pieces: Array<Array<readonly [number, number]>> = []
  let current: Array<readonly [number, number]> = []
  for (let i = 0; i <= samples; i++) {
    const x = x0 + ((x1 - x0) * i) / samples
    const y = evaluate(expr, { [variable]: x })
    const inside = Number.isFinite(y) && y >= y0 - span && y <= y1 + span
    if (!inside) {
      if (current.length > 1) pieces.push(current)
      current = []
      continue
    }
    current.push([x, y])
  }
  if (current.length > 1) pieces.push(current)
  return pieces
}
