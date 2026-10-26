/**
 * A small Python tokenizer for reading code: enough to highlight snippets and
 * to check what a snippet uses (imports, calls). It never evaluates anything.
 * Browser-safe: no Node imports.
 * @module @hodos/code/python
 */

/** Token classes. `error` holds the rest of the source after a tokenizing error. */
export type TokenType = 'keyword' | 'builtin' | 'name' | 'number' | 'string' | 'comment' | 'operator' | 'punctuation' | 'space' | 'newline' | 'error'

/** One token; `line` is 1-based. */
export interface Token {
  readonly type: TokenType
  readonly text: string
  readonly line: number
}

/** Tokens, and the first problem when the source does not tokenize. */
export interface Tokenized {
  readonly tokens: readonly Token[]
  readonly error?: { readonly message: string; readonly line: number }
}

/** Hard keywords (soft keywords such as match and case are ordinary names). */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
])

/** Built-in functions and types highlighted as such. */
export const BUILTINS: ReadonlySet<string> = new Set([
  'abs', 'all', 'any', 'bool', 'chr', 'dict', 'divmod', 'enumerate', 'filter', 'float', 'format', 'input', 'int', 'isinstance', 'iter',
  'len', 'list', 'map', 'max', 'min', 'next', 'open', 'ord', 'pow', 'print', 'range', 'repr', 'reversed', 'round', 'set', 'sorted', 'str',
  'sum', 'tuple', 'type', 'zip',
])

const OPERATORS = ['**=', '//=', '>>=', '<<=', '->', ':=', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '<<', '>>', '+', '-', '*', '/', '%', '<', '>', '=', '&', '|', '^', '~', '@']
const PUNCTUATION = '()[]{},:.;'
const NAME = /[\p{L}_][\p{L}\p{N}_]*/uy
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y
const STRING_PREFIX = /(?:[rRbBuUfF]{1,2})?(?='|")/y

/**
 * Split Python source into tokens.
 * @param source - program text.
 * @returns the tokens; on an unterminated string or an unknown character, the
 * tokens so far, one `error` token with the rest, and the problem.
 */
export function tokenize(source: string): Tokenized {
  const tokens: Token[] = []
  const text = source.replace(/\r\n?/g, '\n')
  let i = 0
  let line = 1
  const push = (type: TokenType, value: string): void => {
    tokens.push({ type, text: value, line })
    for (const ch of value) if (ch === '\n') line += 1
  }
  const fail = (message: string): Tokenized => {
    const at = line
    push('error', text.slice(i))
    return { tokens, error: { message, line: at } }
  }
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '\n') {
      push('newline', ch)
      i += 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\f') {
      let j = i
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\f')) j += 1
      push('space', text.slice(i, j))
      i = j
      continue
    }
    if (ch === '#') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      push('comment', text.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '\\' && text[i + 1] === '\n') {
      push('punctuation', '\\\n')
      i += 2
      continue
    }
    STRING_PREFIX.lastIndex = i
    const prefix = STRING_PREFIX.exec(text)
    if (prefix !== null) {
      const start = i
      const quoteAt = i + prefix[0].length
      const quote = text[quoteAt] ?? '"'
      const triple = text.startsWith(quote.repeat(3), quoteAt)
      let j = quoteAt + (triple ? 3 : 1)
      let closed = false
      while (j < text.length) {
        const c = text[j]
        if (c === '\\') {
          j += 2
          continue
        }
        if (triple ? text.startsWith(quote.repeat(3), j) : c === quote) {
          j += triple ? 3 : 1
          closed = true
          break
        }
        if (!triple && c === '\n') break
        j += 1
      }
      if (!closed) return fail('a string is not closed')
      push('string', text.slice(start, j))
      i = j
      continue
    }
    NAME.lastIndex = i
    const name = NAME.exec(text)
    if (name !== null) {
      const word = name[0]
      push(KEYWORDS.has(word) ? 'keyword' : BUILTINS.has(word) ? 'builtin' : 'name', word)
      i += word.length
      continue
    }
    NUMBER.lastIndex = i
    const number = /[0-9.]/.test(ch) ? NUMBER.exec(text) : null
    if (number !== null && number[0] !== '.' && number[0] !== '') {
      push('number', number[0])
      i += number[0].length
      continue
    }
    const operator = OPERATORS.find(op => text.startsWith(op, i))
    if (operator !== undefined) {
      push('operator', operator)
      i += operator.length
      continue
    }
    if (PUNCTUATION.includes(ch)) {
      push('punctuation', ch)
      i += 1
      continue
    }
    return fail(`unexpected character ${JSON.stringify(ch)}`)
  }
  return { tokens }
}

const significant = (tokens: readonly Token[]): Token[] => tokens.filter(t => t.type !== 'space' && t.type !== 'comment')

/**
 * Modules a program imports (`import a.b, c` and `from a import b`).
 * @param tokens - tokens of the program.
 * @returns top-level module names, in order of appearance.
 */
export function importedModules(tokens: readonly Token[]): string[] {
  const list = significant(tokens)
  const out: string[] = []
  for (let k = 0; k < list.length; k += 1) {
    const token = list[k]
    if (token?.type !== 'keyword' || (token.text !== 'import' && token.text !== 'from')) continue
    // `from x import y`: only x is a module; skip the `import` that follows it.
    if (token.text === 'import' && list.slice(0, k).reverse().find(t => t.type === 'newline' || (t.type === 'keyword' && t.text === 'from'))?.text === 'from') continue
    let expectName = true
    for (let j = k + 1; j < list.length; j += 1) {
      const t = list[j]
      if (t === undefined || t.type === 'newline' || (t.type === 'keyword' && t.text !== 'as')) break
      if (expectName && (t.type === 'name' || t.type === 'builtin')) {
        out.push(t.text)
        expectName = false
        if (token.text === 'from') break
      } else if (t.type === 'punctuation' && t.text === ',') {
        expectName = true
      }
    }
  }
  return out
}

/**
 * Names a program calls directly, such as `print` in `print(x)`. Method calls
 * (`xs.append(1)`) and function definitions are not included.
 * @param tokens - tokens of the program.
 * @returns the called names (with repeats).
 */
export function calledNames(tokens: readonly Token[]): string[] {
  const list = significant(tokens)
  const out: string[] = []
  list.forEach((t, k) => {
    const next = list[k + 1]
    const previous = list[k - 1]
    if ((t.type === 'name' || t.type === 'builtin') && next?.type === 'punctuation' && next.text === '('
      && !(previous?.type === 'punctuation' && previous.text === '.') && !(previous?.type === 'keyword' && previous.text === 'def')) {
      out.push(t.text)
    }
  })
  return out
}
