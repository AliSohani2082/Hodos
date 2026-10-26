/**
 * JSON value types shared by every Hodos contract. Everything that crosses a
 * plugin, process, iframe or storage boundary is plain JSON data.
 * @module @hodos/plugin-sdk/json
 */

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null

/** Any JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

/** A JSON object. */
export interface JsonObject {
  [key: string]: JsonValue
}

/**
 * A JSON Schema document (draft 2020-12 subset accepted by Ajv). Schemas may
 * mark properties with `"x-visibility": "server"`; such properties never leave
 * the server (see the student-view projection in `@hodos/core`).
 */
export type JsonSchema = JsonObject

/**
 * Check that a value is plain JSON data: no functions, symbols, class
 * instances, `undefined`, non-finite numbers or cycles.
 * @param value - the value to check.
 * @returns true when the value can be serialized and parsed without change.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  const seen = new Set<object>()
  const visit = (current: unknown): boolean => {
    if (current === null) return true
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return true
      case 'number':
        return Number.isFinite(current)
      case 'object': {
        if (seen.has(current)) return false
        seen.add(current)
        let ok: boolean
        if (Array.isArray(current)) {
          ok = current.every(visit)
        } else {
          const proto: unknown = Object.getPrototypeOf(current)
          ok = (proto === Object.prototype || proto === null) && Object.values(current).every(visit)
        }
        seen.delete(current)
        return ok
      }
      default:
        return false
    }
  }
  return visit(value)
}

/**
 * Deep-clone a JSON value through serialization, detaching it from the caller.
 * @param value - a JSON value.
 * @returns an independent copy.
 */
export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
