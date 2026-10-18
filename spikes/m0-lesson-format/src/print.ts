// Printers: one neutral document spec -> Markdoc text or directive text. Used to build gold lessons and the offline
// stub model, and to test that both syntaxes can express exactly the same content (parity at scale).
import YAML from 'yaml'
import { REGISTRY, yamlFields } from './blocks.ts'
import type { Json } from './types.ts'

export interface Inline {
  inline: true
  name: string
  attrs: Record<string, Json>
  text: string
}
export type Para = (string | Inline)[]
export interface BlockItem {
  block: string
  attrs: Record<string, Json>
  children?: Item[]
}
export type Item =
  | string // a raw Markdown paragraph, heading or similar
  | { p: Para }
  | { fence: { lang: string; body: string } }
  | { list: { lead: string; children: Item[] }[] }
  | BlockItem

export interface DocSpec {
  lesson: string
  concept: string
  items: Item[]
}

export const inline = (name: string, attrs: Record<string, Json>, text: string): Inline => ({ inline: true, name, attrs, text })

const isBlock = (i: Item): i is BlockItem => typeof i === 'object' && 'block' in i

// ---------- Markdoc ----------

function mdocValue(v: Json): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(mdocValue).join(', ')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_]\w*$/.test(k) ? k : JSON.stringify(k)}: ${mdocValue(x)}`).join(', ')}}`
  return String(v)
}
const mdocAttrs = (a: Record<string, Json>) => Object.entries(a).map(([k, v]) => ` ${k}=${mdocValue(v)}`).join('')

function mdocPara(p: Para): string {
  return p.map((x) => (typeof x === 'string' ? x : `{% ${x.name}${mdocAttrs(x.attrs)} %}${x.text}{% /${x.name} %}`)).join('')
}

function mdocItems(items: Item[], indent = ''): string {
  return items.map((i) => mdocItem(i, indent)).join('\n\n')
}

function mdocItem(item: Item, indent: string): string {
  const pad = (s: string) => s.split('\n').map((l) => (l ? indent + l : l)).join('\n')
  if (typeof item === 'string') return pad(item)
  if ('p' in item) return pad(mdocPara(item.p))
  if ('fence' in item) {
    const { lang, body } = item.fence
    const info = body.includes('{%') ? `${lang} {% process=false %}` : lang
    return pad('```' + info + '\n' + body + '\n```')
  }
  if ('list' in item)
    return item.list
      .map((li) => `${indent}- ${li.lead}\n\n${mdocItems(li.children, indent + '  ')}`)
      .join('\n')
  const spec = REGISTRY.get(item.block)!
  const { block: name, attrs } = item
  if (name === 'exercise') return pad(mdocExercise(attrs))
  if (spec.kind === 'leaf') return pad(`{% ${name}${mdocAttrs(attrs)} /%}`)
  const body = mdocItems(item.children ?? [], '')
  return pad(`{% ${name}${mdocAttrs(attrs)} %}\n${body}\n{% /${name} %}`)
}

function mdocExercise(all: Record<string, Json>): string {
  const spec = REGISTRY.get('exercise')!
  const lifted = new Set(Object.keys(spec.parts!))
  const attrs = Object.fromEntries(Object.entries(all).filter(([k]) => !lifted.has(k)))
  const lines = [`{% exercise${mdocAttrs(attrs)} %}`]
  if (typeof all.prompt === 'string') lines.push(`{% prompt %}${all.prompt}{% /prompt %}`)
  for (const c of (all.choices as Record<string, Json>[] | undefined) ?? []) {
    const a: Record<string, Json> = { id: c.id! }
    if (c.correct !== undefined) a.correct = c.correct
    if (c.misconception !== undefined) a.misconception = c.misconception
    const fb = c.feedback !== undefined ? `{% feedback %}${c.feedback}{% /feedback %}` : ''
    lines.push(`{% choice${mdocAttrs(a)} %}${c.text}${fb}{% /choice %}`)
  }
  for (const h of (all.hints as Record<string, Json>[] | undefined) ?? []) lines.push(`{% hint level=${h.level} %}${h.text}{% /hint %}`)
  for (const s of (all.steps as Record<string, Json>[] | undefined) ?? []) {
    const a: Record<string, Json> = { id: s.id! }
    if (s.key !== undefined) a.key = s.key
    if (s.misconception !== undefined) a.misconception = s.misconception
    lines.push(`{% step${mdocAttrs(a)} %}${s.text}{% /step %}`)
  }
  lines.push('{% /exercise %}')
  return lines.join('\n')
}

export function printMarkdoc(doc: DocSpec): string {
  return `---\nlesson: ${doc.lesson}\nconcept: ${doc.concept}\n---\n\n${mdocItems(doc.items)}\n`
}

// ---------- Directive ----------

function dirScalar(v: Json): string {
  const s = String(v)
  if (typeof v !== 'string') return s
  if (/^[A-Za-z0-9_./+-]+$/.test(s)) return s
  if (!s.includes('"')) return `"${s}"`
  if (!s.includes("'")) return `'${s}'`
  return `"${s.replaceAll('"', '&quot;')}"`
}
function dirAttrs(a: Record<string, Json>): string {
  const parts = Object.entries(a).map(([k, v]) => (k === 'id' ? `#${v}` : `${k}=${dirScalar(v)}`))
  return parts.length ? `{${parts.join(' ')}}` : ''
}
const split = (name: string, attrs: Record<string, Json>) => {
  const spec = REGISTRY.get(name)!
  const y = new Set(yamlFields(spec))
  const scalar: Record<string, Json> = {}
  const yaml: Record<string, Json> = {}
  for (const [k, v] of Object.entries(attrs)) (y.has(k) ? yaml : scalar)[k] = v
  return { scalar, yaml }
}

/** Colons needed for a container: 3, plus one for every level of container nested inside it. */
function depth(items: Item[] | undefined): number {
  let d = 0
  for (const i of items ?? []) {
    if (isBlock(i)) {
      const spec = REGISTRY.get(i.block)!
      const { yaml } = split(i.block, i.attrs)
      const isContainer = spec.kind === 'container' || (spec.kind === 'leaf' && Object.keys(yaml).length > 0)
      if (isContainer) d = Math.max(d, 1 + depth(i.children))
    } else if (typeof i === 'object' && 'list' in i) {
      for (const li of i.list) d = Math.max(d, depth(li.children))
    }
  }
  return d
}

function dirPara(p: Para): string {
  return p
    .map((x) => (typeof x === 'string' ? x : `:${x.name}[${x.text}]${dirAttrs(x.attrs)}`))
    .join('')
}

function dirItems(items: Item[], indent = ''): string {
  return items.map((i) => dirItem(i, indent)).join('\n\n')
}

function yamlBlock(y: Record<string, Json>): string {
  return '```yaml\n' + YAML.stringify(y, { lineWidth: 0 }).trimEnd() + '\n```'
}

function dirItem(item: Item, indent: string): string {
  const pad = (s: string) => s.split('\n').map((l) => (l ? indent + l : l)).join('\n')
  if (typeof item === 'string') return pad(item)
  if ('p' in item) return pad(dirPara(item.p))
  if ('fence' in item) return pad('```' + item.fence.lang + '\n' + item.fence.body + '\n```')
  if ('list' in item)
    return item.list.map((li) => `${indent}- ${li.lead}\n\n${dirItems(li.children, indent + '  ')}`).join('\n')
  const spec = REGISTRY.get(item.block)!
  const { scalar, yaml } = split(item.block, item.attrs)
  const hasYaml = Object.keys(yaml).length > 0
  if (spec.kind === 'leaf' && !hasYaml) return pad(`::${item.block}${dirAttrs(scalar)}`)
  const colons = ':'.repeat(3 + depth(item.children))
  const inner = [hasYaml ? yamlBlock(yaml) : '', dirItems(item.children ?? [], '')].filter(Boolean).join('\n\n')
  return pad(`${colons}${item.block}${dirAttrs(scalar)}\n${inner}\n${colons}`)
}

export function printDirective(doc: DocSpec): string {
  return `---\nlesson: ${doc.lesson}\nconcept: ${doc.concept}\n---\n\n${dirItems(doc.items)}\n`
}

export const print = (arm: 'markdoc' | 'directive', doc: DocSpec) => (arm === 'markdoc' ? printMarkdoc(doc) : printDirective(doc))
