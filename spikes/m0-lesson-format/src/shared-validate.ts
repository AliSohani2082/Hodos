// Syntax-blind validation: JSON Schema on attrs, plugin `validate` hooks, nesting and id rules.
// Runs on the neutral tree, so both arms get exactly the same checks (§8.2 "same JSON Schema, same plugin validate").
import Ajv, { type ErrorObject } from 'ajv'
import { FRONTMATTER_SCHEMA, REGISTRY } from './blocks.ts'
import type { Diagnostic, LDoc, LNode, ValidationContext } from './types.ts'

const ajv = new Ajv({ allErrors: true, strict: false })
const compiled = new Map<string, ReturnType<typeof ajv.compile>>()
const validatorFor = (name: string) => {
  let v = compiled.get(name)
  if (!v) compiled.set(name, (v = ajv.compile(REGISTRY.get(name)!.attrs)))
  return v
}
const frontmatterValidator = ajv.compile(FRONTMATTER_SCHEMA)

const pathOf = (e: ErrorObject) => e.instancePath.replace(/^\//, '').replaceAll('/', '.')

export function ajvDiagnostics(errors: ErrorObject[], node: LNode | null, fm = false): Diagnostic[] {
  return errors.map((e): Diagnostic => {
    const base = { line: node?.line ?? 1, block: fm ? 'frontmatter' : node?.type, stage: 'schema' as const }
    const path = pathOf(e)
    switch (e.keyword) {
      case 'required': {
        const attr = [path, e.params.missingProperty].filter(Boolean).join('.')
        return { ...base, id: fm ? 'bad-frontmatter' : 'missing-attr', attr, message: `missing required attribute "${attr}"` }
      }
      case 'additionalProperties': {
        const attr = [path, e.params.additionalProperty].filter(Boolean).join('.')
        return { ...base, id: fm ? 'bad-frontmatter' : 'unknown-attr', attr, message: `unknown attribute "${attr}"` }
      }
      case 'enum':
        return { ...base, id: fm ? 'bad-frontmatter' : 'bad-value', attr: path, message: `"${path}" must be one of ${JSON.stringify(e.params.allowedValues)}` }
      default:
        return { ...base, id: fm ? 'bad-frontmatter' : 'bad-value', attr: path, message: `"${path || 'value'}" ${e.message}` }
    }
  })
}

export function validateTree(doc: LDoc, ctx: ValidationContext): Diagnostic[] {
  const out: Diagnostic[] = []
  const sem = (d: Diagnostic): Diagnostic => ({ ...d, stage: 'semantic' })

  if (!frontmatterValidator(doc.frontmatter)) out.push(...ajvDiagnostics(frontmatterValidator.errors ?? [], null, true))

  const ids = new Map<string, number>()

  const walk = (nodes: LNode[], parents: string[]) => {
    for (const n of nodes) {
      if (n.kind === 'block') {
        const spec = REGISTRY.get(n.type)
        if (spec) {
          if (!ctx.allowed.has(n.type)) {
            out.push(sem({ id: 'disallowed-block', message: `block "${n.type}" is not available in this course`, line: n.line, block: n.type }))
          } else if (!n.broken) {
            const v = validatorFor(n.type)
            if (!v(n.attrs)) out.push(...ajvDiagnostics(v.errors ?? [], n))
            if (spec.parents && !(parents.length && spec.parents.includes(parents[parents.length - 1]!)))
              out.push(sem({ id: 'bad-nesting', message: `"${n.type}" is only allowed directly inside ${spec.parents.join(' or ')}`, line: n.line, block: n.type }))
            if (n.type === 'perspective' && parents.includes('perspective'))
              out.push(sem({ id: 'bad-nesting', message: 'a perspective cannot contain another perspective', line: n.line, block: n.type }))
            out.push(...(spec.validate?.(n, ctx) ?? []).map(sem))
            const id = n.attrs.id
            if (typeof id === 'string') {
              if (ids.has(id)) out.push(sem({ id: 'bad-value', message: `id "${id}" is already used on line ${ids.get(id)}`, line: n.line, block: n.type, attr: 'id' }))
              else ids.set(id, n.line)
            }
          }
        }
        walk(n.children, [...parents, n.type])
      } else {
        walk(n.children, parents)
      }
    }
  }
  walk(doc.children, [])
  return out
}

/** All lesson blocks in document order. */
export function blocksOf(nodes: LNode[]): LNode[] {
  const out: LNode[] = []
  const walk = (ns: LNode[]) => {
    for (const n of ns) {
      if (n.kind === 'block') out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}
