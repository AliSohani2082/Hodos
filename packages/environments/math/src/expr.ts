/**
 * A small, safe parser and evaluator for school algebra: numbers, declared
 * single-letter variables, + − × ÷ ^, parentheses, implicit multiplication
 * (2x, 3(x+1), xy), the constants pi and e, and a few functions. It never
 * evaluates text as code, and it bounds input length, nesting and size, so
 * a learner's answer cannot make it loop or allocate without limit.
 * Browser-safe: no Node imports.
 * @module @hodos/math/expr
 */

/** A parsed expression. */
export type Expr =
  | { readonly type: 'num'; readonly value: number }
  | { readonly type: 'var'; readonly name: string }
  | { readonly type: 'const'; readonly name: 'pi' | 'e' }
  | { readonly type: 'neg'; readonly arg: Expr }
  | { readonly type: 'bin'; readonly op: '+' | '-' | '*' | '/' | '^'; readonly left: Expr; readonly right: Expr }
  | { readonly type: 'call'; readonly fn: MathFunction; readonly arg: Expr }

/** Supported functions. */
export const FUNCTIONS = ['sqrt', 'abs', 'sin', 'cos', 'tan', 'ln', 'log', 'exp'] as const

/** One supported function. */
export type MathFunction = (typeof FUNCTIONS)[number]

/** Limits that keep parsing and evaluation bounded. */
export const LIMITS = { maxLength: 300, maxDepth: 40, maxNodes: 400 } as const

/** Parse outcome. */
export type ParseResult = { readonly ok: true; readonly expr: Expr } | { readonly ok: false; readonly error: string }

type Token =
  | { readonly t: 'num'; readonly v: number }
  | { readonly t: 'id'; readonly v: string }
  | { readonly t: 'op'; readonly v: '+' | '-' | '*' | '/' | '^' }
  | { readonly t: '(' }
  | { readonly t: ')' }

const isFunction = (name: string): name is MathFunction => (FUNCTIONS as readonly string[]).includes(name)

function tokenize(text: string, variables: ReadonlySet<string>): Token[] | string {
  const out: Token[] = []
  // Common typographic variants learners type.
  const src = text.replace(/[×·⋅]/gu, '*').replace(/÷/gu, '/').replace(/[−–]/gu, '-').replace(/π/gu, 'pi').replace(/²/gu, '^2').replace(/³/gu, '^3').replace(/\*\*/gu, '^')
  let i = 0
  while (i < src.length) {
    const c = src[i] ?? ''
    if (/\s/u.test(c)) { i += 1; continue }
    if (/[0-9.]/u.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/u.exec(src.slice(i))
      if (m === null) return `unexpected "${c}"`
      const value = Number(m[1])
      if (!Number.isFinite(value)) return 'number too large'
      out.push({ t: 'num', v: value })
      i += m[0].length
      continue
    }
    if (/[a-zA-Z]/u.test(c)) {
      const m = /^[a-zA-Z]+/u.exec(src.slice(i))
      const word = m?.[0] ?? c
      i += word.length
      if (isFunction(word) || word === 'pi') { out.push({ t: 'id', v: word }); continue }
      // Anything else is a run of single-letter variables (and e), multiplied: "xy" = x·y.
      for (const letter of word) {
        if (letter === 'e' && !variables.has('e')) { out.push({ t: 'id', v: 'e' }); continue }
        if (!variables.has(letter)) return `unknown symbol "${letter}"`
        out.push({ t: 'id', v: letter })
      }
      continue
    }
    if (c === '(' || c === '[') { out.push({ t: '(' }); i += 1; continue }
    if (c === ')' || c === ']') { out.push({ t: ')' }); i += 1; continue }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^') { out.push({ t: 'op', v: c }); i += 1; continue }
    return `unexpected "${c}"`
  }
  return out
}

/** Whether a token can begin a factor (for implicit multiplication). */
function startsPrimary(t: Token | undefined): boolean {
  return t !== undefined && (t.t === 'num' || t.t === 'id' || t.t === '(')
}

/**
 * Parse an expression.
 * @param text - what the learner or author wrote.
 * @param variables - the letters that are variables (others are errors; `e` is Euler's number unless declared).
 * @returns the expression, or an error message for the learner.
 */
export function parse(text: string, variables: readonly string[] = []): ParseResult {
  if (text.length > LIMITS.maxLength) return { ok: false, error: `the expression is longer than ${LIMITS.maxLength} characters` }
  const tokens = tokenize(text, new Set(variables))
  if (typeof tokens === 'string') return { ok: false, error: tokens }
  if (tokens.length === 0) return { ok: false, error: 'the expression is empty' }
  let pos = 0
  let nodes = 0
  const peek = (): Token | undefined => tokens[pos]
  const node = (expr: Expr): Expr => {
    nodes += 1
    if (nodes > LIMITS.maxNodes) throw new Error('the expression is too large')
    return expr
  }

  const expression = (depth: number): Expr => {
    if (depth > LIMITS.maxDepth) throw new Error('the expression is nested too deeply')
    let left = term(depth)
    for (let t = peek(); t?.t === 'op' && (t.v === '+' || t.v === '-'); t = peek()) {
      pos += 1
      left = node({ type: 'bin', op: t.v, left, right: term(depth) })
    }
    return left
  }
  const term = (depth: number): Expr => {
    let left = unary(depth)
    for (;;) {
      const t = peek()
      if (t?.t === 'op' && (t.v === '*' || t.v === '/')) {
        pos += 1
        left = node({ type: 'bin', op: t.v, left, right: unary(depth) })
      } else if (startsPrimary(t)) {
        // Implicit multiplication: 2x, 3(x + 1), x(x - 1).
        left = node({ type: 'bin', op: '*', left, right: power(depth) })
      } else {
        return left
      }
    }
  }
  const unary = (depth: number): Expr => {
    if (depth > LIMITS.maxDepth) throw new Error('the expression is nested too deeply')
    const t = peek()
    if (t?.t === 'op' && (t.v === '-' || t.v === '+')) {
      pos += 1
      const arg = unary(depth + 1)
      return t.v === '-' ? node({ type: 'neg', arg }) : arg
    }
    return power(depth)
  }
  const power = (depth: number): Expr => {
    const base = primary(depth)
    const t = peek()
    if (t?.t === 'op' && t.v === '^') {
      pos += 1
      // Right-associative, and the exponent may be negative: x^-1, 2^3^2 = 2^(3^2).
      return node({ type: 'bin', op: '^', left: base, right: unary(depth + 1) })
    }
    return base
  }
  const primary = (depth: number): Expr => {
    const t = peek()
    if (t === undefined) throw new Error('the expression ends too early')
    pos += 1
    if (t.t === 'num') return node({ type: 'num', value: t.v })
    if (t.t === '(') {
      const inner = expression(depth + 1)
      if (peek()?.t !== ')') throw new Error('a parenthesis is not closed')
      pos += 1
      return inner
    }
    if (t.t === 'id') {
      if (t.v === 'pi') return node({ type: 'const', name: 'pi' })
      if (t.v === 'e') return node({ type: 'const', name: 'e' })
      if (isFunction(t.v)) {
        if (peek()?.t !== '(') throw new Error(`${t.v} needs parentheses, e.g. ${t.v}(x)`)
        pos += 1
        const arg = expression(depth + 1)
        if (peek()?.t !== ')') throw new Error('a parenthesis is not closed')
        pos += 1
        return node({ type: 'call', fn: t.v, arg })
      }
      return node({ type: 'var', name: t.v })
    }
    throw new Error(t.t === ')' ? 'unexpected ")"' : `unexpected "${t.v}"`)
  }

  try {
    const expr = expression(0)
    if (pos < tokens.length) return { ok: false, error: tokens[pos]?.t === ')' ? 'unexpected ")"' : 'unexpected text after the expression' }
    return { ok: true, expr }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid expression' }
  }
}

/**
 * Evaluate an expression.
 * @param expr - the expression.
 * @param env - variable values.
 * @returns the value; NaN outside the domain (a missing variable, √ of a negative, …).
 */
export function evaluate(expr: Expr, env: Readonly<Record<string, number>>): number {
  switch (expr.type) {
    case 'num': return expr.value
    case 'var': return env[expr.name] ?? Number.NaN
    case 'const': return expr.name === 'pi' ? Math.PI : Math.E
    case 'neg': return -evaluate(expr.arg, env)
    case 'bin': {
      const a = evaluate(expr.left, env)
      const b = evaluate(expr.right, env)
      switch (expr.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return b === 0 ? Number.NaN : a / b
        case '^': return a ** b
      }
      break
    }
    case 'call': {
      const x = evaluate(expr.arg, env)
      switch (expr.fn) {
        case 'sqrt': return x < 0 ? Number.NaN : Math.sqrt(x)
        case 'abs': return Math.abs(x)
        case 'sin': return Math.sin(x)
        case 'cos': return Math.cos(x)
        case 'tan': return Math.tan(x)
        case 'ln': return x <= 0 ? Number.NaN : Math.log(x)
        case 'log': return x <= 0 ? Number.NaN : Math.log10(x)
        case 'exp': return Math.exp(x)
      }
    }
  }
  return Number.NaN
}

/** The variables an expression uses. */
export function variablesOf(expr: Expr, out = new Set<string>()): Set<string> {
  if (expr.type === 'var') out.add(expr.name)
  else if (expr.type === 'neg' || expr.type === 'call') variablesOf(expr.arg, out)
  else if (expr.type === 'bin') { variablesOf(expr.left, out); variablesOf(expr.right, out) }
  return out
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function close(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) <= 1e-9 * scale
}

/** Equivalence verdict. */
export type Equivalence = 'equivalent' | 'different' | 'undetermined'

/**
 * Whether two expressions agree as functions of the given variables, by
 * evaluating both at seeded random points (polynomial identity testing).
 * Points where either side is undefined are skipped; too few usable points
 * give `undetermined`.
 * @param a - one expression.
 * @param b - the other.
 * @param variables - the variables to sample.
 * @param samples - how many usable points to require.
 */
export function equivalent(a: Expr, b: Expr, variables: readonly string[], samples = 24): Equivalence {
  const rng = random(0x9e3779b9 ^ variables.length)
  let usable = 0
  for (let attempt = 0; attempt < samples * 4 && usable < samples; attempt++) {
    const env: Record<string, number> = {}
    // Non-integer points in [-6, 6] avoid hitting special values by accident.
    for (const v of variables) env[v] = (rng() * 12 - 6) + 1e-3
    const x = evaluate(a, env)
    const y = evaluate(b, env)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    usable += 1
    if (!close(x, y)) return 'different'
  }
  return usable >= Math.min(samples, 8) ? 'equivalent' : 'undetermined'
}

/** Whether an expression contains a sum or difference under a product or a power ("not expanded"). */
export function hasUnexpandedProduct(expr: Expr): boolean {
  const isSum = (e: Expr): boolean => e.type === 'bin' && (e.op === '+' || e.op === '-')
  switch (expr.type) {
    case 'bin':
      if ((expr.op === '*' && (isSum(expr.left) || isSum(expr.right))) || (expr.op === '^' && isSum(expr.left))) return true
      return hasUnexpandedProduct(expr.left) || hasUnexpandedProduct(expr.right)
    case 'neg':
    case 'call':
      return hasUnexpandedProduct(expr.arg)
    default:
      return false
  }
}

/** Whether the top level of an expression is a product or power (a factored form). */
export function isProduct(expr: Expr): boolean {
  if (expr.type === 'neg') return isProduct(expr.arg)
  return expr.type === 'bin' && (expr.op === '*' || expr.op === '^')
}

/** Whether an expression contains no variable (a number, pi, e, or a function of those). */
export function isConstant(expr: Expr): boolean {
  switch (expr.type) {
    case 'var': return false
    case 'bin': return isConstant(expr.left) && isConstant(expr.right)
    case 'neg':
    case 'call': return isConstant(expr.arg)
    default: return true
  }
}

/**
 * A polynomial in normal form: each monomial (variables with exponents, such
 * as `x^2*y^1`, or `''` for the constant term) mapped to its coefficient.
 */
export type Polynomial = ReadonlyMap<string, number>

/** Bounds on normalizing a polynomial, so that `(x + y + z)^12` cannot blow up. */
const POLYNOMIAL_LIMITS = { maxTerms: 256, maxPower: 12 } as const

function monomial(key: string): Map<string, number> {
  const powers = new Map<string, number>()
  if (key === '') return powers
  for (const part of key.split('*')) {
    const [name = '', exponent = '0'] = part.split('^')
    powers.set(name, (powers.get(name) ?? 0) + Number(exponent))
  }
  return powers
}

function monomialKey(powers: ReadonlyMap<string, number>): string {
  return [...powers].filter(([, n]) => n > 0).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, n]) => `${name}^${n}`).join('*')
}

function constantPolynomial(value: number): Map<string, number> | null {
  if (!Number.isFinite(value)) return null
  return new Map(value === 0 ? [] : [['', value]])
}

function accumulate(out: Map<string, number>, key: string, value: number): void {
  const next = (out.get(key) ?? 0) + value
  if (Math.abs(next) < 1e-12) out.delete(key)
  else out.set(key, next)
}

function addPolynomials(a: Polynomial, b: Polynomial, sign: 1 | -1): Map<string, number> | null {
  const out = new Map(a)
  for (const [key, c] of b) accumulate(out, key, sign * c)
  return out.size > POLYNOMIAL_LIMITS.maxTerms ? null : out
}

function multiplyPolynomials(a: Polynomial, b: Polynomial): Map<string, number> | null {
  const out = new Map<string, number>()
  for (const [ka, ca] of a) {
    for (const [kb, cb] of b) {
      const powers = monomial(ka)
      for (const [name, n] of monomial(kb)) powers.set(name, (powers.get(name) ?? 0) + n)
      accumulate(out, monomialKey(powers), ca * cb)
      if (out.size > POLYNOMIAL_LIMITS.maxTerms) return null
    }
  }
  return out
}

/**
 * The normal form of an expression that is a polynomial in its variables:
 * sums, differences and products of numbers and variables, whole-number
 * exponents from 0 to 12, and division by non-zero constants only.
 * @param expr - the expression.
 * @returns the polynomial, or null when the expression is not one (a variable
 *   under a function or in a denominator, or a variable exponent) or is too large.
 */
export function toPolynomial(expr: Expr): Polynomial | null {
  if (isConstant(expr)) return constantPolynomial(evaluate(expr, {}))
  switch (expr.type) {
    case 'var': return new Map([[`${expr.name}^1`, 1]])
    case 'neg': {
      const arg = toPolynomial(expr.arg)
      return arg === null ? null : new Map([...arg].map(([key, c]) => [key, -c]))
    }
    case 'bin': {
      const left = toPolynomial(expr.left)
      if (left === null) return null
      if (expr.op === '/' || expr.op === '^') {
        if (!isConstant(expr.right)) return null
        const n = evaluate(expr.right, {})
        if (expr.op === '/') return Number.isFinite(n) && n !== 0 ? new Map([...left].map(([key, c]) => [key, c / n])) : null
        if (!Number.isInteger(n) || n < 0 || n > POLYNOMIAL_LIMITS.maxPower) return null
        let out: Polynomial | null = constantPolynomial(1)
        for (let i = 0; i < n && out !== null; i += 1) out = multiplyPolynomials(out, left)
        return out
      }
      const right = toPolynomial(expr.right)
      if (right === null) return null
      return expr.op === '*' ? multiplyPolynomials(left, right) : addPolynomials(left, right, expr.op === '+' ? 1 : -1)
    }
    default: return null
  }
}

/** Total degree of a polynomial; 0 for a constant (including zero). */
export function degree(polynomial: Polynomial): number {
  let out = 0
  for (const key of polynomial.keys()) out = Math.max(out, [...monomial(key).values()].reduce((sum, n) => sum + n, 0))
  return out
}

const nearInteger = (value: number): boolean => Math.abs(value - Math.round(value)) < 1e-9

/** The factors of a product: `−a` adds a factor −1, and `a^n` with a whole n from 1 to 12 adds `a` n times. */
function collectFactors(expr: Expr, out: Expr[]): void {
  if (expr.type === 'neg') {
    out.push({ type: 'num', value: -1 })
    collectFactors(expr.arg, out)
    return
  }
  if (expr.type === 'bin' && expr.op === '*') {
    collectFactors(expr.left, out)
    collectFactors(expr.right, out)
    return
  }
  if (expr.type === 'bin' && expr.op === '^' && isConstant(expr.right)) {
    const n = evaluate(expr.right, {})
    if (Number.isInteger(n) && n >= 1 && n <= POLYNOMIAL_LIMITS.maxPower) {
      for (let i = 0; i < n; i += 1) collectFactors(expr.left, out)
      return
    }
  }
  out.push(expr)
}

/**
 * Whether an expression is factored: a product of at least two polynomial
 * factors of degree one or more, as in `(x + 2)(x + 3)` or `(x + 1)^2`, or a
 * whole number other than 0 and ±1 taken out of one polynomial factor with
 * whole-number coefficients, as in `2(x + 3)`. Factors that are constant as
 * polynomials (`1`, `x − x + 1`) do not count, and every factor must be a
 * polynomial, so `1(x^2 + 5x + 6)`, `(x^2 + 5x + 6)^1` and
 * `sqrt(x^2 + 5x + 6)^2` are not factored.
 * @param expr - the expression.
 * @returns whether it is in factored form.
 */
export function isFactored(expr: Expr): boolean {
  const factors: Expr[] = []
  collectFactors(expr, factors)
  let constant = 1
  const terms: Polynomial[] = []
  for (const factor of factors) {
    const polynomial = toPolynomial(factor)
    if (polynomial === null) return false
    if (degree(polynomial) === 0) constant *= polynomial.get('') ?? 0
    else terms.push(polynomial)
  }
  if (terms.length >= 2) return true
  const [only] = terms
  return terms.length === 1 && only !== undefined && nearInteger(constant) && Math.abs(constant) >= 2 && [...only.values()].every(nearInteger)
}

/**
 * Whether an expression is expanded: no sum or difference (negated or not)
 * inside a product, under a power, or divided by something, as in `x^2 + 3x + 2`
 * and not `(x + 1)(x + 2)` or `(x + 1)/(1/(x + 2))`.
 * @param expr - the expression.
 * @returns whether it is in expanded form.
 */
export function isExpanded(expr: Expr): boolean {
  const isSum = (e: Expr): boolean => (e.type === 'neg' ? isSum(e.arg) : e.type === 'bin' && (e.op === '+' || e.op === '-'))
  switch (expr.type) {
    case 'bin':
      if (expr.op === '*' && (isSum(expr.left) || isSum(expr.right))) return false
      if ((expr.op === '/' || expr.op === '^') && isSum(expr.left)) return false
      return isExpanded(expr.left) && isExpanded(expr.right)
    case 'neg':
    case 'call':
      return isExpanded(expr.arg)
    default:
      return true
  }
}
