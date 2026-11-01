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
 * @throws {HodosPluginError} `INVALID_SCHEMA` when the schema itself is invalid.
 */
export function compileSchema(schema: JsonSchema, code: string): SchemaValidator {
  let validate: ValidateFunction
  try {
    validate = ajv.compile(schema)
  } catch (error) {
    throw new HodosPluginError('INVALID_SCHEMA', `invalid JSON Schema for ${code}: ${error instanceof Error ? error.message : String(error)}`)
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

/**
 * Return a copy of `value` containing only what the schema allows a client to
 * see. Properties marked `x-visibility: server` are removed at every depth.
 * Object properties the schema does not declare are dropped unless the
 * schema sets `additionalProperties` to `true` or to a schema. Union branches
 * (`oneOf`/`anyOf`) are projected with the first branch that declares the
 * property.
 * @param schema - the schema describing `value`.
 * @param value - the value to project.
 * @returns the client-visible copy; `undefined` when the root itself is server-only.
 */
export function stripServerFields(schema: JsonSchema, value: JsonValue): JsonValue | undefined {
  return project(schema, value, 0)
}

function branches(schema: JsonObject): JsonObject[] {
  const out: JsonObject[] = [schema]
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const list = schema[key]
    if (Array.isArray(list)) for (const branch of list) if (isObjectNode(branch)) out.push(branch)
  }
  return out
}

function project(schema: JsonValue | undefined, value: JsonValue, depth: number): JsonValue | undefined {
  if (depth > 64) throw new HodosPluginError('INVALID_CONTENT', 'value nesting exceeds 64 levels')
  if (schema === true || schema === undefined) return value
  if (!isObjectNode(schema)) return undefined
  if (isServerOnly(schema)) return undefined
  if (Array.isArray(value)) {
    let items: JsonValue | undefined
    let prefix: JsonValue[] | undefined
    for (const b of branches(schema)) {
      if (items === undefined && b.items !== undefined) items = b.items
      const p = b.prefixItems
      if (prefix === undefined && Array.isArray(p)) prefix = p
    }
    const out: JsonValue[] = []
    value.forEach((entry, index) => {
      const itemSchema = prefix !== undefined && index < prefix.length ? prefix[index] : items
      const projected = project(itemSchema ?? true, entry, depth + 1)
      if (projected !== undefined) out.push(projected)
    })
    return out
  }
  if (isObjectNode(value)) {
    const all = branches(schema)
    const out: JsonObject = {}
    for (const [key, entry] of Object.entries(value)) {
      const declared = all.map(b => b.properties).find(p => isObjectNode(p) && key in p)
      if (isObjectNode(declared)) {
        const projected = project(declared[key], entry, depth + 1)
        if (projected !== undefined) out[key] = projected
        continue
      }
      const extra = all.map(b => b.additionalProperties).find(a => a !== undefined)
      if (extra === true || isObjectNode(extra)) {
        const projected = project(extra, entry, depth + 1)
        if (projected !== undefined) out[key] = projected
      }
    }
    return out
  }
  return value
}

/**
 * Collect the JSON pointers of every property the schema marks server-only.
 * Used by hosts to audit projections and by tests.
 * @param schema - schema to inspect.
 * @returns pointer-like paths such as `/options/*\/rationale`.
 */
export function serverOnlyPaths(schema: JsonSchema): string[] {
  const out: string[] = []
  const walk = (node: JsonValue | undefined, path: string, depth: number): void => {
    if (!isObjectNode(node) || depth > 64) return
    if (isServerOnly(node)) {
      out.push(path || '/')
      return
    }
    for (const b of branches(node)) {
      if (isObjectNode(b.properties)) {
        for (const [key, child] of Object.entries(b.properties)) walk(child, `${path}/${key}`, depth + 1)
      }
      if (isObjectNode(b.items)) walk(b.items, `${path}/*`, depth + 1)
      if (isObjectNode(b.additionalProperties)) walk(b.additionalProperties, `${path}/*`, depth + 1)
    }
  }
  walk(schema, '', 0)
  return [...new Set(out)]
}
