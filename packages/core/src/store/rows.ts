/**
 * Typed reads of SQLite rows, shared by the store and the repositories that
 * use its database.
 * @module @hodos/core/store/rows
 */
import type { SQLInputValue } from 'node:sqlite'
import { HodosError } from '../errors.js'

/** A result row. */
export type Row = Record<string, unknown>

/** Statements on the store's database, for repositories that share it. */
export interface SqlRunner {
  run(sql: string, ...params: SQLInputValue[]): void
  get(sql: string, ...params: SQLInputValue[]): Row | undefined
  all(sql: string, ...params: SQLInputValue[]): Row[]
}

/** A text column. */
export function str(row: Row, col: string): string {
  const v = row[col]
  if (typeof v !== 'string') throw new HodosError('INTERNAL', `stored column ${col} is not text`)
  return v
}
/** A nullable text column. */
export function optStr(row: Row, col: string): string | null {
  const v = row[col]
  return typeof v === 'string' ? v : null
}
/** A numeric column. */
export function num(row: Row, col: string): number {
  const v = row[col]
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  throw new HodosError('INTERNAL', `stored column ${col} is not numeric`)
}
/** A nullable numeric column. */
export function optNum(row: Row, col: string): number | null {
  const v = row[col]
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}
/**
 * A JSON column. Every `*_json` column is written from a typed
 * value by the store or a repository, so each read site asserts the type it wrote.
 */
export function json(row: Row, col: string): unknown {
  try {
    return JSON.parse(str(row, col))
  } catch (error) {
    throw new HodosError('INTERNAL', `stored column ${col} holds invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
/** A nullable JSON column. */
export function optJson(row: Row, col: string): unknown {
  return optStr(row, col) === null ? null : json(row, col)
}
