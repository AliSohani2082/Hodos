/**
 * Runtime JSON Schema validation (Ajv, draft 2020-12) and the schema-driven
 * projection that removes `x-visibility: server` fields.
 * @module @hodos/plugin-sdk/schema
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import type { Diagnostic } from './errors.js'
import { HodosPluginError } from './errors.js'
import { isJsonValue, type JsonObject, type JsonSchema, type JsonValue } from './json.js'

/** Visibility keyword. `server` fields never leave the server. */
export const VISIBILITY_KEYWORD = 'x-visibility'

const ajv = new Ajv2020({ strict: true, allErrors: true, validateSchema: true })
ajv.addKeyword({ keyword: VISIBILITY_KEYWORD, schemaType: 'string' })

/** A compiled validator returning findings instead of booleans. */
export type SchemaValidator = (value: unknown) => readonly Diagnostic[]

function toDiagnostics(errors: readonly ErrorObject[] | null | undefined, code: string): Diagnostic[] {
  return (errors ?? []).map(e => ({
    severity: 'error' as const,
    code,
    message: `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`,
    path: e.instancePath || '/',
  }))
}

/**
 * Compile a schema once and return a validator.
 * @param schema - the JSON Schema to compile.
 * @param code - diagnostic code reported for violations, e.g. `chess/payload`.
 * @returns a validator; non-JSON input (functions, cycles, NaN) always fails.
 * @throws {HodosPluginError} `INVALID_SCHEMA` when the schema itself is invalid
 *   or asynchronous (`$async`).
 */
export function compileSchema(schema: JsonSchema, code: string): SchemaValidator {
  let validate: ValidateFunction
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    throw new HodosPluginError('INVALID_SCHEMA', `invalid JSON Schema for ${code}: ${error instanceof Error ? error.message : String(error)}`)
  }
  // An `$async` schema compiles to a validator that returns a promise, which would read as "valid"
  // here for any input (and its rejection would go unhandled). Validation is synchronous only.
  if ((validate as { $async?: unknown }).$async === true) {
    ajv.removeSchema(schema)
    throw new HodosPluginError('INVALID_SCHEMA', `invalid JSON Schema for ${code}: asynchronous schemas ($async) are not supported`)
  }
  return value => {
    if (!isJsonValue(value)) {
      return [{ severity: 'error', code, message: 'value is not plain JSON data', path: '/' }]
    }
    return validate(value) ? [] : toDiagnostics(validate.errors, code)
  }
}

function isObjectNode(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isServerOnly(schema: JsonValue | undefined): boolean {
  return isObjectNode(schema) && schema[VISIBILITY_KEYWORD] === 'server'
}

/** Deepest value or schema nesting the projection follows. */
const MAX_DEPTH = 64

/**
 * Return a copy of `value` containing only what the schema allows a client to
 * see. A value is removed when its schema, or any subschema that may apply to
 * it, is marked `x-visibility: server`: combinators (`allOf`, `anyOf`,
 * `oneOf`), conditionals (`if`, `then`, `else`), `dependentSchemas`, and the
 * targets of local references (`$ref` or `$dynamicRef` to `#` or `#/…`),
 * at every depth. A reference that cannot be followed (another document, an
 * anchor, or a schema with nested `$id`s) withholds the value.
 * Object properties are kept when a subschema declares them (`properties`,
 * `patternProperties`) or allows undeclared ones (`additionalProperties` or
 * `unevaluatedProperties` set to `true` or to a schema); others are dropped.
 * @param schema - the schema describing `value`.
 * @param value - the value to project.
 * @returns the client-visible copy; `undefined` when the root itself is server-only.
 */
export function stripServerFields(schema: JsonSchema, value: JsonValue): JsonValue | undefined {
  return project(schema, value, 0, { root: schema, refs: !hasNestedIds(schema) })
}

/** The document a projection resolves references in. */
interface SchemaDocument {
  readonly root: JsonValue
  /** Whether local references can be resolved against the root (no nested `$id` resources). */
  readonly refs: boolean
}

/**
 * Whether a schema embeds other schema resources (`$id` below the root), which rebase references.
 * Nesting deeper than the projection follows counts as yes.
 */
function hasNestedIds(node: JsonValue, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true
  if (Array.isArray(node)) return node.some(child => hasNestedIds(child, depth + 1))
  if (!isObjectNode(node)) return false
  if (depth > 0 && Object.hasOwn(node, '$id')) return true
  return Object.values(node).some(child => hasNestedIds(child, depth + 1))
}

/** Resolve a local JSON-pointer reference (`#`, `#/$defs/name`); anything else is not followed. */
function resolveLocal(doc: SchemaDocument, ref: string): JsonValue | undefined {
  if (!doc.refs) return undefined
  if (ref === '#') return doc.root
  if (!ref.startsWith('#/')) return undefined
  let node: JsonValue | undefined = doc.root
  for (const raw of ref.slice(2).split('/')) {
    let token: string
    try {
      token = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~')
    } catch {
      return undefined
    }
    if (Array.isArray(node)) node = /^(?:0|[1-9]\d*)$/u.test(token) ? node[Number(token)] : undefined
    else if (isObjectNode(node)) node = Object.hasOwn(node, token) ? node[token] : undefined
    else return undefined
    if (node === undefined) return undefined
  }
  return node
}

const SUBSCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf'] as const
const SUBSCHEMA_SINGLES = ['if', 'then', 'else'] as const

/**
 * Every subschema that applies, or may apply, to a value at this node: the
 * node, its combinators, conditionals and dependent schemas, and the targets
 * of its references, followed to any depth.
 * @returns the subschemas, or null when a reference cannot be followed.
 */
function applicable(schema: JsonObject, doc: SchemaDocument): JsonObject[] | null {
  const out: JsonObject[] = []
  const seen = new Set<JsonObject>()
  const visit = (node: JsonValue | undefined, depth: number): boolean => {
    if (node === undefined || typeof node === 'boolean') return true
    if (!isObjectNode(node) || depth > MAX_DEPTH) return false
    if (seen.has(node)) return true
    seen.add(node)
    out.push(node)
    for (const keyword of ['$ref', '$dynamicRef']) {
      const ref = node[keyword]
      if (ref === undefined) continue
      const target = typeof ref === 'string' ? resolveLocal(doc, ref) : undefined
      if (target === undefined || !visit(target, depth + 1)) return false
    }
    for (const keyword of SUBSCHEMA_LISTS) {
      const list = node[keyword]
      if (Array.isArray(list) && !list.every(branch => visit(branch, depth + 1))) return false
    }
    if (!SUBSCHEMA_SINGLES.every(keyword => visit(node[keyword], depth + 1))) return false
    const dependent = node.dependentSchemas
    return !isObjectNode(dependent) || Object.values(dependent).every(branch => visit(branch, depth + 1))
  }
  return visit(schema, 0) ? out : null
}

/** One schema standing for several that all apply to the same value. */
function together(schemas: readonly JsonValue[]): JsonValue {
  return schemas.length === 1 ? schemas[0] ?? true : { allOf: [...schemas] }
}

/** Whether a `patternProperties` pattern matches a key; a pattern that cannot be compiled counts as matching. */
function matchesPattern(pattern: string, key: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(key)
  } catch {
    return true
  }
}

/** The schemas that describe one property of an object, or none when no subschema declares or allows it. */
function propertySchemas(all: readonly JsonObject[], key: string): JsonValue[] {
  const declared: JsonValue[] = []
  for (const b of all) {
    const props = b.properties
    if (isObjectNode(props) && Object.hasOwn(props, key)) declared.push(props[key] ?? true)
    const patterns = b.patternProperties
    if (isObjectNode(patterns)) for (const [pattern, s] of Object.entries(patterns)) if (matchesPattern(pattern, key)) declared.push(s)
  }
  if (declared.length > 0) return declared
  const allowed: JsonValue[] = []
  for (const b of all) {
    for (const extra of [b.additionalProperties, b.unevaluatedProperties]) if (extra === true || isObjectNode(extra)) allowed.push(extra)
  }
  return allowed
}

/** The schemas that describe one entry of an array; empty when none constrains it. */
function itemSchemas(all: readonly JsonObject[], index: number): JsonValue[] {
  const schemas: JsonValue[] = []
  for (const b of all) {
    const prefix = b.prefixItems
    if (Array.isArray(prefix) && index < prefix.length) schemas.push(prefix[index] ?? true)
    else if (b.items !== undefined) schemas.push(b.items)
    else if (isObjectNode(b.unevaluatedItems)) schemas.push(b.unevaluatedItems)
    if (isObjectNode(b.contains)) schemas.push(b.contains)
  }
  return schemas
}

function project(schema: JsonValue | undefined, value: JsonValue, depth: number, doc: SchemaDocument): JsonValue | undefined {
  if (depth > MAX_DEPTH) throw new HodosPluginError('INVALID_CONTENT', `value nesting exceeds ${MAX_DEPTH} levels`)
  if (schema === true || schema === undefined) return value
  if (!isObjectNode(schema)) return undefined
  const all = applicable(schema, doc)
  // A reference that cannot be followed may hide a server-only marker: withhold the value.
  if (all === null || all.some(isServerOnly)) return undefined
  if (Array.isArray(value)) {
    const out: JsonValue[] = []
    value.forEach((entry, index) => {
      const schemas = itemSchemas(all, index)
      const projected = schemas.length === 0 ? entry : project(together(schemas), entry, depth + 1, doc)
      if (projected !== undefined) out.push(projected)
    })
    return out
  }
  if (isObjectNode(value)) {
    const out: JsonObject = {}
    for (const [key, entry] of Object.entries(value)) {
      const schemas = propertySchemas(all, key)
      if (schemas.length === 0) continue
      const projected = project(together(schemas), entry, depth + 1, doc)
      if (projected !== undefined) out[key] = projected
    }
    return out
  }
  return value
}

/**
 * Collect the JSON pointers of every property the schema marks server-only,
 * or withholds because a reference under it cannot be followed. Follows the
 * same subschemas as {@link stripServerFields}; a recursive reference is
 * reported once, at its first level. Used by hosts to audit projections and
 * by tests.
 * @param schema - schema to inspect.
 * @returns pointer-like paths such as `/options/*\/rationale`.
 */
export function serverOnlyPaths(schema: JsonSchema): string[] {
  const doc: SchemaDocument = { root: schema, refs: !hasNestedIds(schema) }
  const out: string[] = []
  // Each schema node is walked once, which keeps recursive references finite.
  const walked = new Set<JsonObject>()
  const walk = (node: JsonValue | undefined, path: string, depth: number): void => {
    if (!isObjectNode(node) || depth > MAX_DEPTH || walked.has(node)) return
    walked.add(node)
    const all = applicable(node, doc)
    if (all === null || all.some(isServerOnly)) {
      out.push(path || '/')
      return
    }
    for (const b of all) {
      if (isObjectNode(b.properties)) for (const [key, child] of Object.entries(b.properties)) walk(child, `${path}/${key}`, depth + 1)
      for (const child of [
        ...(isObjectNode(b.patternProperties) ? Object.values(b.patternProperties) : []),
        ...(Array.isArray(b.prefixItems) ? b.prefixItems : []),
        b.items, b.contains, b.unevaluatedItems, b.additionalProperties, b.unevaluatedProperties,
      ]) walk(child, `${path}/*`, depth + 1)
    }
  }
  walk(schema, '', 0)
  return [...new Set(out)]
}
