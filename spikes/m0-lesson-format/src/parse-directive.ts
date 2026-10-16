// Arm D front end: remark-parse + remark-directive + remark-frontmatter, an mdast walk into the neutral tree,
// the YAML-body grammar for structured payloads, and the lints that turn silent failures into diagnostics (§8.2).
import YAML from 'yaml'
import remarkDirective from 'remark-directive'
import remarkFrontmatter from 'remark-frontmatter'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { REGISTRY, yamlFields } from './blocks.ts'
import type { Diagnostic, Json, LNode, ParseResult } from './types.ts'

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkDirective)

interface Ctx {
  lines: string[]
  diags: Diagnostic[]
}

const lineOf = (n: any) => n.position?.start?.line ?? 1

function coerce(v: unknown, schema: any): Json {
  const s = v === null || v === undefined ? '' : String(v)
  if ((schema?.type === 'number' || schema?.type === 'integer') && /^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (schema?.type === 'boolean' && (s === 'true' || s === 'false')) return s === 'true'
  return s
}

function plainOf(n: any): string {
  if (typeof n.value === 'string') return n.value
  return (n.children ?? []).map(plainOf).join('')
}

function prose(type: string, n: any, extra: Partial<LNode> = {}): LNode {
  return { kind: 'prose', type, attrs: {}, children: [], line: lineOf(n), ...extra }
}

/** Closing-fence check: remark-directive silently auto-closes a container at EOF or at the end of its parent. */
function checkClosed(n: any, ctx: Ctx): boolean {
  const open = /^[\s>]*(:{3,})/.exec(ctx.lines[n.position.start.line - 1] ?? '')
  const need = open?.[1]?.length ?? 3
  const last = ctx.lines[n.position.end.line - 1] ?? ''
  const close = /^[\s>]*(:{3,})\s*$/.exec(last)
  const ok = n.position.end.line > n.position.start.line && !!close && close[1]!.length >= need
  if (!ok)
    ctx.diags.push({
      id: 'unclosed',
      line: n.position.start.line,
      block: n.name,
      message: `container "${n.name}" is not closed: end it with a line of at least ${need} colons`,
    })
  return ok
}

function parseYamlFence(fence: any, spec: { name: string }, ctx: Ctx): Record<string, Json> | null {
  try {
    const v = YAML.parse(fence.value ?? '')
    if (v === null || v === undefined) return {}
    if (typeof v !== 'object' || Array.isArray(v)) {
      ctx.diags.push({ id: 'bad-body', line: lineOf(fence), block: spec.name, message: 'the yaml block must be a mapping of field: value' })
      return null
    }
    return v as Record<string, Json>
  } catch (err) {
    const e = err as { message: string; linePos?: { line: number }[] }
    const inner = e.linePos?.[0]?.line ?? 1
    ctx.diags.push({
      id: 'bad-body',
      line: lineOf(fence) + inner,
      block: spec.name,
      message: `the yaml block does not parse: ${e.message.split('\n')[0]}`,
    })
    return null
  }
}

function convDirective(n: any, parents: string[], ctx: Ctx): LNode[] {
  const name: string = n.name
  const line = lineOf(n)
  const rawAttrs: Record<string, unknown> = n.attributes ?? {}
  const spec = REGISTRY.get(name)
  const isText = n.type === 'textDirective'
  const label = () => (n.children as any[]).flatMap((c) => convNode(c, parents, ctx))

  if (!spec) {
    if (isText && n.children.length === 0 && Object.keys(rawAttrs).length === 0) {
      // A bare unknown text directive is almost always prose ("12:30", "x:y"). Restore it as text, like the
      // remark-directive docs recommend, instead of flagging innocent colons.
      return [prose('text', n, { text: `:${name}` })]
    }
    ctx.diags.push({ id: 'unknown-block', line, block: name, message: `unknown block "${name}"` })
    return n.type === 'leafDirective' || isText ? label() : (n.children as any[]).flatMap((c) => convNode(c, parents, ctx))
  }

  // Form checks: which of :name[], ::name{}, :::name{} is right for this block.
  const formHint = {
    inline: `write it as a text directive, :${name}[text]{...}`,
    leaf: `write it as a leaf directive, ::${name}{...}`,
    container: `write it as a container, :::${name}{...} ... :::`,
  }[spec.kind]
  const yf = yamlFields(spec)
  let formOk = true
  if (spec.kind === 'inline') formOk = isText
  else if (spec.kind === 'container') formOk = n.type === 'containerDirective'
  else formOk = n.type === 'leafDirective' || (n.type === 'containerDirective' && yf.length > 0)
  if (!formOk) {
    ctx.diags.push({ id: 'bad-syntax', line, block: name, message: `"${name}" is a ${spec.kind} block: ${formHint}` })
  }
  if (n.type === 'leafDirective' && n.children.length) {
    ctx.diags.push({ id: 'bad-syntax', line, block: name, message: `"${name}" takes no [label]; put values in {attributes}` })
  }
  if (n.type === 'containerDirective') checkClosed(n, ctx)

  const props = spec.attrs.properties as Record<string, any>
  const attrs: Record<string, Json> = {}
  for (const [k, v] of Object.entries(rawAttrs)) attrs[k] = coerce(v, props[k])

  let body: any[] = n.type === 'containerDirective' ? n.children : []
  let broken = !!n._broken
  if (n.type === 'containerDirective' && yf.length) {
    const first = body[0]
    if (first?.type === 'code' && (first.lang === 'yaml' || first.lang === 'yml')) {
      const y = parseYamlFence(first, spec, ctx)
      if (y === null) broken = true
      body = body.slice(1)
      for (const [k, v] of Object.entries(y ?? {})) {
        if (k in attrs) ctx.diags.push({ id: 'bad-value', line: lineOf(first), block: name, attr: k, message: `"${k}" is given both as an attribute and in the yaml block` })
        else attrs[k] = v
      }
    } else if (spec.kind === 'leaf' || spec.parts) {
      ctx.diags.push({ id: 'bad-body', line, block: name, message: `"${name}" in container form must start with a yaml block holding ${yf.join(', ')}` })
    }
  }
  if ((spec.kind === 'leaf' || spec.parts) && body.length) {
    ctx.diags.push({ id: 'bad-body', line, block: name, message: `"${name}" body must contain only the yaml block` })
    body = []
  }

  const children = isText ? label() : body.flatMap((c) => convNode(c, [...parents, name], ctx))
  return [{ kind: 'block', type: name, attrs, children, line, ...(broken ? { broken } : {}) }]
}

/** Lints for markup that looked like a directive but parsed as prose. */
function lintParagraph(p: any, ctx: Ctx) {
  const kids: any[] = p.children ?? []
  kids.forEach((c, i) => {
    const next = kids[i + 1]
    if (c.type === 'textDirective' && next?.type === 'text' && /^\{/.test(next.value)) {
      c._broken = true
      ctx.diags.push({
        id: 'bad-syntax',
        line: lineOf(c),
        block: c.name,
        message: `the attribute list after :${c.name}[...] was not read: check that every { has a closing } and that values are quoted correctly`,
      })
    }
  })
  const text = plainOf(p)
  const start = lineOf(p)
  const lines = text.split('\n')
  lines.forEach((ln, i) => {
    const line = start + i
    if (/^\s*:{2,}[A-Za-z]/.test(ln))
      ctx.diags.push({
        id: 'bad-syntax',
        line,
        message: `this line looks like a directive but was read as plain text: check braces, quotes (no backslash escapes; use 'single quotes' or &quot; for values containing ") and that values are on one line`,
      })
    else if (/^\s*:{3,}\s*$/.test(ln))
      ctx.diags.push({
        id: 'unclosed',
        line,
        message: 'stray closing fence: an outer container closed early. Nested containers need more colons on the outer fence than on the inner one',
      })
    else if (/(?<![\w:]):[A-Za-z][\w-]*(\[|\{)/.test(ln))
      ctx.diags.push({ id: 'bad-syntax', line, message: 'this text looks like an inline directive but was read as plain text: check the [label] and {attributes}' })
  })
}

function convNode(n: any, parents: string[], ctx: Ctx): LNode[] {
  const kids = () => (n.children ?? []).flatMap((c: any) => convNode(c, parents, ctx))
  switch (n.type) {
    case 'containerDirective':
    case 'leafDirective':
    case 'textDirective':
      return convDirective(n, parents, ctx)
    case 'paragraph':
      lintParagraph(n, ctx)
      return [prose('paragraph', n, { children: kids() })]
    case 'text':
      return [prose('text', n, { text: n.value })]
    case 'heading':
      return [prose('heading', n, { attrs: { level: n.depth }, children: kids() })]
    case 'emphasis':
      return [prose('em', n, { children: kids() })]
    case 'strong':
      return [prose('strong', n, { children: kids() })]
    case 'delete':
      return [prose('del', n, { children: kids() })]
    case 'inlineCode':
      return [prose('code', n, { text: n.value })]
    case 'code':
      return [prose('fence', n, { text: n.value, attrs: { language: n.lang ?? '' } })]
    case 'list':
      return [prose('list', n, { attrs: { ordered: !!n.ordered }, children: kids() })]
    case 'listItem':
      return [prose('item', n, { children: kids() })]
    case 'blockquote':
      return [prose('quote', n, { children: kids() })]
    case 'link':
      return [prose('link', n, { attrs: { href: n.url ?? '' }, children: kids() })]
    case 'image':
      return [prose('image', n, { attrs: { alt: n.alt ?? '', src: n.url ?? '' } })]
    case 'break':
      return [prose('br', n)]
    case 'thematicBreak':
      return [prose('hr', n)]
    case 'html':
      return [prose('html', n, { text: n.value })]
    case 'yaml':
      return []
    default:
      return [prose(n.type, n, { children: kids() })]
  }
}

export function parseDirective(src: string): ParseResult {
  const diagnostics: Diagnostic[] = []
  const ctx: Ctx = { lines: src.split('\n'), diags: diagnostics }
  let tree: any
  try {
    tree = processor.parse(src)
  } catch (err) {
    return { doc: { frontmatter: {}, children: [] }, diagnostics: [{ id: 'bad-syntax', line: 1, message: `could not parse: ${(err as Error).message}` }] }
  }

  let frontmatter: Record<string, Json> = {}
  const first = tree.children[0]
  if (first?.type === 'yaml') {
    try {
      const parsed = YAML.parse(first.value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) frontmatter = parsed as Record<string, Json>
      else diagnostics.push({ id: 'bad-frontmatter', line: 1, message: 'frontmatter must be a YAML mapping' })
    } catch (err) {
      diagnostics.push({ id: 'bad-frontmatter', line: 1, message: `frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` })
    }
  }
  const children = (tree.children as any[]).flatMap((c) => convNode(c, [], ctx))
  return { doc: { frontmatter, children }, diagnostics }
}
