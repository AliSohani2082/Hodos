/**
 * Reading course items, payloads and answer keys in tests. Each helper throws
 * with a description when the value is not the expected shape, so a changed
 * course fails the test where it is read instead of as `"undefined"` later.
 */
import type { JsonObject, JsonValue } from '@hodos/plugin-sdk'

/**
 * `value` as a JSON object.
 * @param value - the value to read.
 * @param what - what it is, for the error.
 */
export function jsonObject(value: JsonValue | undefined, what: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`)
  return value
}

/**
 * `value` as a string.
 * @param value - the value to read.
 * @param what - what it is, for the error.
 */
export function jsonString(value: JsonValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`)
  return value
}

/**
 * `value` as an array of JSON objects.
 * @param value - the value to read.
 * @param what - what it is, for the error.
 */
export function jsonObjects(value: JsonValue | undefined, what: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`)
  return value.map((entry, i) => jsonObject(entry, `${what}[${i}]`))
}

/**
 * `value` as an array of strings.
 * @param value - the value to read.
 * @param what - what it is, for the error.
 */
export function jsonStrings(value: JsonValue | undefined, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`)
  return value.map((entry, i) => jsonString(entry, `${what}[${i}]`))
}
