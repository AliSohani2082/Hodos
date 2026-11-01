/**
 * Lesson IR: Markdoc source parsed into a syntax-neutral tree of
 * {@link LessonNode}s, validated against core and plugin block schemas.
 * Lessons are data: Markdoc variables and functions are rejected, raw HTML
 * stays inert text, and only http(s)/mailto links survive. Block ids are
 * stamped into the source once so they stay stable across edits.
 * @module @hodos/core/content/lesson
 */
import { createHash } from 'node:crypto'
import Markdoc, { type Node as MarkdocNode, type Schema, type SchemaAttribute, type ValidateError, type ValidationType } from '@markdoc/markdoc'
import {
  compileSchema,
  stripServerFields,
  type Diagnostic,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type LessonNode,
  type SchemaValidator,
} from '@hodos/plugin-sdk'

/** A block definition as the lesson parser needs it. */
export interface BlockDefinition {
  readonly name: string
  readonly kind: 'leaf' | 'container'
  readonly attributes: JsonSchema
  readonly validateAttributes: SchemaValidator
  /** Semantic validation (trusted plugins and core blocks only). */
  readonly validate?: (node: LessonNode) => readonly Diagnostic[]
  readonly fallbackText: (node: LessonNode) => string
}

/** Source of plugin block definitions. */
export interface BlockLookup {
  block(name: string): BlockDefinition | undefined
}

const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' }

function core(name: string, kind: 'leaf' | 'container', properties: JsonObject, required: string[], fallbackText: (n: LessonNode) => string): BlockDefinition {
  const attributes: JsonSchema = { type: 'object', additionalProperties: false, required: ['id', ...required], properties: { id: ID, ...properties } }
  return { name, kind, attributes, validateAttributes: compileSchema(attributes, `lesson/${name}`), fallbackText }
}

const str = (v: JsonValue | undefined): string => (typeof v === 'string' ? v : '')

/** Core blocks owned by the platform. Plugins cannot redefine them. */
export const CORE_BLOCKS: ReadonlyMap<string, BlockDefinition> = new Map([
  core('step', 'container', { title: { type: 'string', maxLength: 120 } }, [], n => (str(n.attributes.title) ? `Step: ${str(n.attributes.title)}` : '')),
  core('callout', 'container', { kind: { enum: ['tip', 'warning', 'key-idea', 'note'] }, title: { type: 'string', maxLength: 120 } }, [], n => str(n.attributes.title)),
  core('worked-example', 'container', { title: { type: 'string', maxLength: 120 } }, [], n => `Worked example${str(n.attributes.title) ? `: ${str(n.attributes.title)}` : ''}`),
  core('check', 'leaf', {
    question: { type: 'string', minLength: 1, maxLength: 500 },
    options: {
      type: 'array', minItems: 2, maxItems: 6,
      items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: ID, text: { type: 'string', minLength: 1, maxLength: 300 } } },
    },
    answer: { type: 'string', 'x-visibility': 'server' },
    explain: { type: 'string', maxLength: 1000, 'x-visibility': 'server' },
  }, ['question', 'options', 'answer'], n => {
    const options = Array.isArray(n.attributes.options) ? n.attributes.options : []
    const lines = options.map(o => (typeof o === 'object' && o !== null && !Array.isArray(o) ? `  (${str(o.id)}) ${str(o.text)}` : ''))
    return `Check: ${str(n.attributes.question)}\n${lines.join('\n')}`
  }),
].map(b => [b.name, b] as const))

function markdocType(schema: JsonValue | undefined): ValidationType | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined
  switch (schema.type) {
    case 'string': return String
    case 'number':
    case 'integer': return Number
    case 'boolean': return Boolean
    case 'array': return Array
    case 'object': return Object
    default: return undefined
  }
}

function markdocConfig(names: Iterable<BlockDefinition>): { tags: Record<string, Schema> } {
  const tags: Record<string, Schema> = {}
  for (const def of names) {
    const props = def.attributes.properties
    const attributes: Record<string, SchemaAttribute> = {}
    if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
      for (const [key, value] of Object.entries(props)) {
        const type = markdocType(value)
        attributes[key] = type === undefined ? {} : { type }
      }
    }
    tags[def.name] = { selfClosing: def.kind === 'leaf', attributes }
  }
  return { tags }
}

/** Result of parsing a lesson. */
export interface LessonParseResult {
  /** Syntax-neutral tree (root type `document`), or null when the source is invalid. */
  readonly tree: LessonNode | null
  readonly diagnostics: readonly Diagnostic[]
}

function isMdtypeObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '$$mdtype' in value
}

function containsMdtype(value: unknown, depth = 0): boolean {
  if (depth > 32) return true
  if (isMdtypeObject(value)) return true
  if (Array.isArray(value)) return value.some(v => containsMdtype(v, depth + 1))
  if (typeof value === 'object' && value !== null) return Object.values(value).some(v => containsMdtype(v, depth + 1))
  return false
}

const SAFE_LINK = /^(https?:\/\/|mailto:|#)/i

/**
 * Parse and validate lesson source.
 * @param source - Markdoc text.
 * @param blocks - plugin blocks available to this course.
 * @param lessonId - lesson id, used for diagnostics and positional ids.
 * @returns the tree and findings.
 */
export function parseLesson(source: string, blocks: BlockLookup, lessonId = 'lesson'): LessonParseResult {
  const diagnostics: Diagnostic[] = []
  if (source.length > 200_000) {
    return { tree: null, diagnostics: [{ severity: 'error', code: 'lesson/too-large', message: 'lesson source exceeds 200 000 characters', target: lessonId }] }
  }
  const ast = Markdoc.parse(source)
  const used = new Map<string, BlockDefinition>()
  const visit = (node: MarkdocNode): void => {
    if (node.type === 'tag' && typeof node.tag === 'string') {
      const def = CORE_BLOCKS.get(node.tag) ?? blocks.block(node.tag)
      if (def !== undefined) used.set(def.name, def)
    }
    for (const child of node.children) visit(child)
  }
  visit(ast)
  const config = markdocConfig(used.values())
  const errors: ValidateError[] = Markdoc.validate(ast, config)
  for (const e of errors) {
    diagnostics.push({
      severity: e.error.level === 'warning' || e.error.level === 'info' || e.error.level === 'debug' ? 'warning' : 'error',
      code: `lesson/markdoc-${e.error.id}`,
      message: `line ${(e.lines[0] ?? 0) + 1}: ${e.error.message}`,
      target: lessonId,
    })
  }
  const ids = new Set<string>()
  let counter = 0
  const convert = (node: MarkdocNode, path: string): LessonNode | null => {
    const line = (node.lines[0] ?? 0) + 1
    if (containsMdtype(node.attributes)) {
      diagnostics.push({ severity: 'error', code: 'lesson/no-variables', message: `line ${line}: variables and functions are not allowed in lessons`, target: lessonId })
      return null
    }
    const children = node.children.map((c, i) => convert(c, `${path}.${i}`)).filter((c): c is LessonNode => c !== null)
    const positional = `${lessonId}-${path}`
    switch (node.type) {
      case 'document': return { id: lessonId, type: 'document', attributes: {}, children }
      case 'heading': return { id: positional, type: 'heading', attributes: { level: Number(node.attributes.level ?? 1) }, children }
      case 'paragraph':
      case 'blockquote':
      case 'list':
      case 'item':
      case 'strong':
      case 'em':
      case 's':
        return { id: positional, type: node.type === 's' ? 'strike' : node.type, attributes: node.type === 'list' ? { ordered: node.attributes.ordered === true } : {}, children }
      case 'inline':
        // Inline wrappers carry no meaning in the neutral tree; keep their children.
        return children.length === 1 ? children[0] ?? null : { id: positional, type: 'span', attributes: {}, children }
      case 'text': {
        const content: unknown = node.attributes.content
        if (typeof content !== 'string') {
          diagnostics.push({ severity: 'error', code: 'lesson/no-variables', message: `line ${line}: variables and functions are not allowed in lessons`, target: lessonId })
          return null
        }
        return { id: positional, type: 'text', attributes: {}, text: content }
      }
      case 'code': return { id: positional, type: 'code', attributes: {}, text: String(node.attributes.content ?? '') }
      case 'fence': return { id: positional, type: 'fence', attributes: { language: String(node.attributes.language ?? '') }, text: String(node.attributes.content ?? '') }
      case 'softbreak': return { id: positional, type: 'text', attributes: {}, text: ' ' }
      case 'hardbreak': return { id: positional, type: 'break', attributes: {} }
      case 'hr': return { id: positional, type: 'rule', attributes: {} }
      case 'link': {
        const href = String(node.attributes.href ?? '')
        if (!SAFE_LINK.test(href)) {
          diagnostics.push({ severity: 'error', code: 'lesson/unsafe-link', message: `line ${line}: only http(s), mailto and in-page links are allowed`, target: lessonId })
          return { id: positional, type: 'span', attributes: {}, children }
        }
        return { id: positional, type: 'link', attributes: { href }, children }
      }
      case 'image':
        diagnostics.push({ severity: 'error', code: 'lesson/no-images', message: `line ${line}: images are not supported in lessons; use a block`, target: lessonId })
        return null
      case 'tag': {
        const name = String(node.tag)
        const def = CORE_BLOCKS.get(name) ?? blocks.block(name)
        if (def === undefined) {
          diagnostics.push({ severity: 'error', code: 'lesson/unknown-block', message: `line ${line}: block ${name} is not available in this course`, target: lessonId })
          return null
        }
        const attributes = JSON.parse(JSON.stringify(node.attributes)) as JsonObject // plain data: mdtype objects were rejected above
        if (typeof attributes.id !== 'string') attributes.id = `${name}-${++counter}`
        const id = attributes.id
        if (ids.has(id)) diagnostics.push({ severity: 'error', code: 'lesson/duplicate-id', message: `line ${line}: block id ${id} is used twice`, target: lessonId })
        ids.add(id)
        for (const d of def.validateAttributes(attributes)) diagnostics.push({ ...d, code: `lesson/${name}-attributes`, message: `line ${line}: ${name} ${d.message}`, target: id })
        const out: LessonNode = def.kind === 'container' ? { id, type: name, attributes, children } : { id, type: name, attributes }
        if (def.validate !== undefined) {
          try {
            diagnostics.push(...def.validate(out).map(d => ({ ...d, target: d.target ?? id })))
          } catch (error) {
            diagnostics.push({ severity: 'error', code: 'lesson/validator-failed', message: `block ${name} validator failed: ${error instanceof Error ? error.message : String(error)}`, target: id })
          }
        }
        return out
      }
      case 'error':
        diagnostics.push({ severity: 'error', code: 'lesson/syntax', message: `line ${line}: malformed tag`, target: lessonId })
        return null
      default:
        // Tables and other constructs are kept as their text content.
        return children.length === 0 ? null : { id: positional, type: 'span', attributes: {}, children }
    }
  }
  const tree = convert(ast, '0')
  const hasErrors = diagnostics.some(d => d.severity === 'error')
  return { tree: hasErrors ? null : tree, diagnostics }
}

/**
 * Stamp stable ids into block tags that lack one. Each id derives from the
 * lesson id, the tag name, its attributes and its occurrence, so stamping is
 * deterministic; once stamped, the id stays in the text across edits.
 * @param source - Markdoc text.
 * @param lessonId - lesson id used as the id prefix.
 * @returns the source with ids inserted.
 */
export function stampBlockIds(source: string, lessonId: string): string {
  const lines = source.split('\n')
  const ast = Markdoc.parse(source)
  const edits: Array<{ line: number; tag: string; id: string }> = []
  let occurrence = 0
  const walk = (node: MarkdocNode): void => {
    if (node.type === 'tag' && typeof node.tag === 'string' && node.attributes.id === undefined && node.lines.length > 0) {
      occurrence += 1
      const hash = createHash('sha256').update(`${lessonId}\u0000${node.tag}\u0000${JSON.stringify(node.attributes)}\u0000${occurrence}`).digest('hex').slice(0, 8)
      edits.push({ line: node.lines[0] ?? 0, tag: node.tag, id: `${node.tag}-${hash}` })
    }
    for (const child of node.children) walk(child)
  }
  walk(ast)
  for (const edit of edits.toReversed()) {
    const text = lines[edit.line]
    if (text === undefined) continue
    const marker = `{% ${edit.tag}`
    const at = text.indexOf(marker)
    if (at < 0) continue
    const end = at + marker.length
    lines[edit.line] = `${text.slice(0, end)} id="${edit.id}"${text.slice(end)}`
  }
  return lines.join('\n')
}

/**
 * Remove server-only attributes (answer keys, explanations) from every block.
 * @param tree - a parsed lesson tree.
 * @param blocks - plugin blocks.
 * @returns a copy safe to send to a learner.
 */
export function projectLessonForStudent(tree: LessonNode, blocks: BlockLookup): LessonNode {
  const project = (node: LessonNode): LessonNode => {
    const def = CORE_BLOCKS.get(node.type) ?? blocks.block(node.type)
    const attributes = def === undefined
      ? node.attributes
      : (stripServerFields(def.attributes, node.attributes) as JsonObject | undefined) ?? {}
    return {
      id: node.id,
      type: node.type,
      attributes,
      ...(node.children === undefined ? {} : { children: node.children.map(project) }),
      ...(node.text === undefined ? {} : { text: node.text }),
    }
  }
  return project(tree)
}

/** Inline content of a node as plain text; links keep their address. */
function inlineText(node: LessonNode): string {
  if (node.type === 'text' || node.type === 'code') return node.text ?? ''
  if (node.type === 'break') return '\n'
  if (node.type === 'link') return `${(node.children ?? []).map(inlineText).join('')} (${str(node.attributes.href)})`
  return (node.children ?? []).map(inlineText).join('')
}

/**
 * Plain-text rendering of a lesson: the fallback when no renderer is
 * available, and the agent's view. Blocks use their `fallbackText`.
 * @param tree - a (projected) lesson tree.
 * @param blocks - plugin blocks.
 * @returns readable text.
 */
export function lessonPlainText(tree: LessonNode, blocks: BlockLookup): string {
  const out: string[] = []
  const block = (node: LessonNode, depth: number): void => {
    switch (node.type) {
      case 'document': (node.children ?? []).forEach(c => block(c, depth)); return
      case 'heading': out.push(`${'#'.repeat(Number(node.attributes.level ?? 1))} ${inlineText(node)}`); return
      case 'paragraph': out.push(inlineText(node)); return
      case 'fence': out.push(node.text ?? ''); return
      case 'list': (node.children ?? []).forEach((c, i) => out.push(`${node.attributes.ordered === true ? `${i + 1}.` : '-'} ${(c.children ?? []).map(inlineText).join(' ')}`)); return
      case 'blockquote': (node.children ?? []).forEach(c => out.push(`> ${inlineText(c)}`)); return
      case 'rule': out.push('---'); return
      default: {
        const def = CORE_BLOCKS.get(node.type) ?? blocks.block(node.type)
        if (def !== undefined) {
          let text = ''
          try {
            text = def.fallbackText(node)
          } catch {
            // A failing projection degrades to the block name.
            text = `[${node.type}]`
          }
          if (text !== '') out.push(text)
          ;(node.children ?? []).forEach(c => block(c, depth + 1))
          return
        }
        const text = inlineText(node)
        if (text !== '') out.push(text)
      }
    }
  }
  block(tree, 0)
  return out.join('\n\n')
}

function leaves(value: JsonValue | undefined, out: string[], depth = 0): void {
  if (depth > 32 || value === undefined || value === null) return
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach(v => leaves(v, out, depth + 1))
  else if (typeof value === 'object') Object.values(value).forEach(v => leaves(v, out, depth + 1))
}

/**
 * Text that the student-view projection removes from a lesson (check answers,
 * explanations, server-only plugin attributes). Used as leak-guard secrets for
 * the lesson's own outbound views; a lesson may of course teach anything else.
 * @param tree - the full (server-side) lesson tree.
 * @param blocks - plugin blocks.
 * @returns withheld strings.
 */
export function lessonServerFragments(tree: LessonNode, blocks: BlockLookup): string[] {
  const out: string[] = []
  const walk = (node: LessonNode): void => {
    const def = CORE_BLOCKS.get(node.type) ?? blocks.block(node.type)
    if (def !== undefined) {
      const visible = JSON.stringify(stripServerFields(def.attributes, node.attributes) ?? {})
      const all: string[] = []
      leaves(node.attributes, all)
      for (const s of all) if (!visible.includes(JSON.stringify(s))) out.push(s)
    }
    node.children?.forEach(walk)
  }
  walk(tree)
  return [...new Set(out)]
}

/**
 * Collect the formative check blocks of a lesson (for grading and lesson completion).
 * @param tree - the full (server-side) lesson tree.
 * @returns check nodes in document order.
 */
export function lessonChecks(tree: LessonNode): LessonNode[] {
  const out: LessonNode[] = []
  const walk = (node: LessonNode): void => {
    if (node.type === 'check') out.push(node)
    node.children?.forEach(walk)
  }
  walk(tree)
  return out
}
