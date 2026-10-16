// Arm M front end: Markdoc.parse + Markdoc.validate against a config generated from the BlockSpecs,
// then conversion of the Markdoc AST into the neutral tree. Child tags of `exercise` are lifted into attrs.
import Markdoc from '@markdoc/markdoc'
import type { Config, Node } from '@markdoc/markdoc'
import YAML from 'yaml'
import { DOTTED, REGISTRY } from './blocks.ts'
import { inlineMd, isBlankNode } from './text.ts'
import type { Diagnostic, DiagId, Json, LNode, ParseResult } from './types.ts'

type Schema = Record<string, any>

function mdAttribute(schema: Schema, required: boolean): Record<string, unknown> {
  const a: Record<string, unknown> = { required }
  switch (schema.type) {
    case 'string': a.type = String; break
    case 'number': case 'integer': a.type = Number; break
    case 'boolean': a.type = Boolean; break
    case 'array': a.type = Array; break
    case 'object': a.type = Object; break
  }
  if (schema.enum) a.matches = schema.enum
  else if (schema.pattern) a.matches = new RegExp(schema.pattern)
  return a
}

/** The "adapter" lesson-ir.md §4 says we must write: BlockSpec JSON Schema -> Markdoc config.tags. */
export function markdocConfig(): Config {
  const tags: Record<string, any> = {}
  for (const spec of REGISTRY.values()) {
    const liftedFields = new Set(Object.keys(spec.parts ?? {}))
    const attributes: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(spec.attrs.properties as Schema)) {
      if (liftedFields.has(k)) continue
      attributes[k] = mdAttribute(v, (spec.attrs.required as string[]).includes(k))
    }
    // `step` is both a block (inside worked-example) and an exercise part: allow its part-only field `key` always.
    tags[spec.name] = {
      render: spec.name,
      attributes,
      ...(spec.kind === 'leaf' ? { selfClosing: true } : {}),
      ...(spec.kind === 'inline' ? { inline: true } : {}),
    }
  }
  tags.prompt = { render: 'prompt', attributes: {} }
  tags.feedback = { render: 'feedback', attributes: {} }
  tags.choice = {
    render: 'choice',
    attributes: {
      id: { type: String, required: true, matches: /^[a-e]$/ },
      correct: { type: Boolean },
      misconception: { type: String, matches: new RegExp(DOTTED) },
    },
  }
  tags.hint = { render: 'hint', attributes: { level: { type: Number, required: true } } }
  return { tags }
}
const CONFIG = markdocConfig()

const PART_TAGS = new Set(['prompt', 'choice', 'feedback', 'hint'])

const ID_MAP: Record<string, DiagId> = {
  'tag-undefined': 'unknown-block',
  'missing-closing': 'unclosed',
  'missing-opening': 'unclosed',
  'attribute-missing-required': 'missing-attr',
  'attribute-undefined': 'unknown-attr',
  'attribute-type-invalid': 'bad-value',
  'attribute-value-invalid': 'bad-value',
  'child-invalid': 'bad-nesting',
}

function firstQuoted(message: string): string | undefined {
  return /'([^']+)'/.exec(message)?.[1]
}

function mapMarkdocError(e: any, tagByLine: Map<number, string>): Diagnostic | null {
  const err = e.error
  if (err.level === 'debug' || err.level === 'info') return null
  const id = ID_MAP[err.id] ?? 'bad-syntax'
  const line = (e.lines?.[0] ?? 0) + 1
  const quoted = firstQuoted(err.message)
  const isAttr = err.id.startsWith('attribute-')
  return {
    id,
    line,
    block: id === 'unknown-block' || id === 'unclosed' ? quoted : tagByLine.get(line),
    attr: isAttr ? quoted : undefined,
    message: `${err.message.replace(/^Node '(\w+)' is missing closing$/, "'$1' is not closed: add the matching closing tag")}`,
  }
}

function toJson(v: unknown, diags: Diagnostic[], line: number): Json {
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return v as Json
  if (v === undefined) return null
  if (Array.isArray(v)) return v.map((x) => toJson(x, diags, line))
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('$$mdtype' in o) {
      diags.push({ id: 'bad-value', line, message: 'variables and functions are not available in lesson attributes' })
      return null
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, toJson(x, diags, line)]))
  }
  return String(v)
}

const lineOf = (n: Node) => (n.lines?.[0] ?? 0) + 1

function conv(node: Node, nearest: string | null, diags: Diagnostic[], inEx = false): LNode[] {
  const kids = (n: Node, near = nearest, ex = inEx) => n.children.flatMap((c) => conv(c, near, diags, ex))
  const prose = (type: string, extra: Partial<LNode> = {}): LNode => ({
    kind: 'prose', type, attrs: {}, children: [], line: lineOf(node), ...extra,
  })
  switch (node.type) {
    case 'document':
      return kids(node)
    case 'tag': {
      const name = node.tag!
      const attrs = toJson(node.attributes ?? {}, diags, lineOf(node)) as Record<string, Json>
      const isPart = PART_TAGS.has(name) || (name === 'step' && nearest === 'exercise')
      if (isPart) {
        if (!inEx) {
          diags.push({ id: 'bad-nesting', line: lineOf(node), block: name, message: `"${name}" is only allowed inside an exercise` })
          return kids(node)
        }
        return [{ kind: 'block', type: name, attrs, children: kids(node, name, true), line: lineOf(node) }]
      }
      const spec = REGISTRY.get(name)
      if (!spec) {
        diags.push({ id: 'unknown-block', line: lineOf(node), block: name, message: `unknown block "${name}"` })
        return kids(node)
      }
      const out: LNode = { kind: 'block', type: name, attrs, children: kids(node, name, name === 'exercise'), line: lineOf(node) }
      if (name === 'exercise') liftExercise(out, diags)
      return [out]
    }
    case 'inline':
      return kids(node)
    case 'text':
      return [prose('text', { text: String(node.attributes.content ?? '') })]
    case 'softbreak':
      return [prose('text', { text: ' ' })]
    case 'hardbreak':
      return [prose('br')]
    case 'code':
      return [prose('code', { text: String(node.attributes.content ?? '') })]
    case 'fence':
      return [prose('fence', { text: String(node.attributes.content ?? ''), attrs: { language: (node.attributes.language ?? '') as string } })]
    case 'heading':
      return [prose('heading', { attrs: { level: node.attributes.level as number }, children: kids(node) })]
    case 'paragraph':
      return [prose('paragraph', { children: kids(node) })]
    case 'strong': case 'em':
      return [prose(node.type, { children: kids(node) })]
    case 's':
      return [prose('del', { children: kids(node) })]
    case 'link':
      return [prose('link', { attrs: { href: String(node.attributes.href ?? '') }, children: kids(node) })]
    case 'image':
      return [prose('image', { attrs: { alt: String(node.attributes.alt ?? ''), src: String(node.attributes.src ?? '') } })]
    case 'blockquote':
      return [prose('quote', { children: kids(node) })]
    case 'list':
      return [prose('list', { attrs: { ordered: Boolean(node.attributes.ordered) }, children: kids(node) })]
    case 'item':
      return [prose('item', { children: kids(node) })]
    case 'hr':
      return [prose('hr')]
    case 'error': case 'comment':
      return []
    default:
      return [prose(node.type, { children: kids(node) })]
  }
}

/** Collect part tags (prompt, choice, hint, step) wherever Markdoc wrapped them in paragraphs. */
function collectParts(nodes: LNode[], diags: Diagnostic[], found: LNode[]) {
  for (const n of nodes) {
    if (n.kind === 'block') found.push(n)
    else if (isBlankNode(n)) continue
    else if (n.type === 'paragraph') collectParts(n.children, diags, found)
    else if (n.type === 'text') diags.push({ id: 'bad-body', line: n.line, block: 'exercise', message: 'text directly inside an exercise: put it in a prompt, choice, hint or step tag' })
    else collectParts(n.children, diags, found)
  }
}

function dropFeedback(nodes: LNode[]): LNode[] {
  const out: LNode[] = []
  for (const n of nodes) {
    if (n.kind === 'block' && n.type === 'feedback') out.push(n)
    else out.push(...dropFeedback(n.children))
  }
  return out
}
function withoutFeedback(nodes: LNode[]): LNode[] {
  return nodes
    .filter((n) => !(n.kind === 'block' && n.type === 'feedback'))
    .map((n) => ({ ...n, children: withoutFeedback(n.children) }))
}

export function liftExercise(node: LNode, diags: Diagnostic[]) {
  const found: LNode[] = []
  collectParts(node.children, diags, found)
  const attrs = node.attrs as Record<string, Json>
  const choices: Json[] = []
  const hints: Json[] = []
  const steps: Json[] = []
  for (const p of found) {
    const text = (nodes: LNode[]) => inlineMd(nodes)
    switch (p.type) {
      case 'prompt':
        if (attrs.prompt !== undefined) diags.push({ id: 'bad-value', line: p.line, block: 'exercise', attr: 'prompt', message: 'exercise has more than one prompt' })
        attrs.prompt = text(p.children)
        break
      case 'choice': {
        const c: Record<string, Json> = { id: (p.attrs.id as Json) ?? null, text: text(withoutFeedback(p.children)) }
        if (p.attrs.correct !== undefined) c.correct = p.attrs.correct as Json
        if (p.attrs.misconception !== undefined) c.misconception = p.attrs.misconception as Json
        const fb = dropFeedback(p.children)[0]
        if (fb) c.feedback = text(fb.children)
        choices.push(c)
        break
      }
      case 'hint':
        hints.push({ level: (p.attrs.level as Json) ?? null, text: text(p.children) })
        break
      case 'step': {
        const s: Record<string, Json> = { id: (p.attrs.id as Json) ?? null, text: text(p.children) }
        if (p.attrs.key !== undefined) s.key = p.attrs.key as Json
        if (p.attrs.misconception !== undefined) s.misconception = p.attrs.misconception as Json
        steps.push(s)
        break
      }
      case 'feedback':
        diags.push({ id: 'bad-nesting', line: p.line, block: 'feedback', message: '"feedback" is only allowed inside a choice' })
        break
      default:
        diags.push({ id: 'bad-nesting', line: p.line, block: p.type, message: `"${p.type}" is not allowed directly inside an exercise` })
    }
  }
  if (choices.length) attrs.choices = choices
  if (hints.length) attrs.hints = hints
  if (steps.length) attrs.steps = steps
  node.children = []
}

export function parseMarkdoc(src: string): ParseResult {
  const diagnostics: Diagnostic[] = []
  let ast: Node
  try {
    ast = Markdoc.parse(src)
  } catch (err) {
    return {
      doc: { frontmatter: {}, children: [] },
      diagnostics: [{ id: 'bad-syntax', line: 1, message: `could not parse: ${(err as Error).message}` }],
    }
  }

  let frontmatter: Record<string, Json> = {}
  const fm = ast.attributes?.frontmatter as string | undefined
  if (fm !== undefined) {
    try {
      const parsed = YAML.parse(fm)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed as Record<string, Json>
      else diagnostics.push({ id: 'bad-frontmatter', line: 1, message: 'frontmatter must be a YAML mapping' })
    } catch (err) {
      diagnostics.push({ id: 'bad-frontmatter', line: 1, message: `frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` })
    }
  }

  const tagByLine = new Map<number, string>()
  const index = (n: Node) => {
    if (n.type === 'tag' && n.tag && !tagByLine.has(lineOf(n))) tagByLine.set(lineOf(n), n.tag)
    n.children.forEach(index)
  }
  index(ast)
  for (const e of Markdoc.validate(ast, CONFIG) as any[]) {
    const d = mapMarkdocError(e, tagByLine)
    if (d) diagnostics.push(d)
  }
  const children = conv(ast, null, diagnostics)
  return { doc: { frontmatter, children }, diagnostics }
}

