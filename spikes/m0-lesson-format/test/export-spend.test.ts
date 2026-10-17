import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resultsCsv } from '../src/csv.ts'
import { approvedCap, recordedSpend, newSpend } from '../src/spend.ts'
import { CreditGuard, CreditLimitError } from '../src/credits.ts'
import type { GenRecord } from '../src/score.ts'

const root = new URL('../.scratch/spend-test/', import.meta.url).pathname
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('CSV has generation metrics and usage, with empty scores for unfinished cells', () => {
  const record: GenRecord = {
    key: 'x', run: 'pilot', model: 'claude-opus-5-5', arm: 'markdoc', taskId: 'math-s3', sample: 1,
    status: 'error', costUSD: 0.25, rounds: [{ kind: 'generate', text: 'unfinished', stopReason: 'max_tokens',
      usage: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 }, costUSD: 0.25, ms: 1 }],
  }
  const csv = resultsCsv([record])
  expect(csv).toContain('m1,m2,m3,m4,m5first,m6first,m7')
  expect(csv).toContain('error,,,,,,,,,,,0,10,20,30,40,0.25')
})

test('new approval has a hard $19 cap', () => {
  expect(approvedCap('19')).toBe(19)
  for (const value of [undefined, '0', '-1', '19.01', 'Infinity', 'oops'])
    expect(() => approvedCap(value)).toThrow()
})

test('spend is summed across pilot, full, judge failures and smoke; stub is excluded', () => {
  for (const run of ['pilot', 'full', 'smoke', '_stub']) mkdirSync(`${root}/${run}`, { recursive: true })
  writeFileSync(`${root}/pilot/generations.jsonl`, '{"costUSD":1}\n')
  writeFileSync(`${root}/full/generations.jsonl`, '{"costUSD":2}\n')
  writeFileSync(`${root}/full/judgments.jsonl`, '{"costUSD":3}\n')
  writeFileSync(`${root}/full/judge-spend.jsonl`, '{"costUSD":4}\n')
  writeFileSync(`${root}/smoke/smoke-spend.jsonl`, '{"costUSD":0.01}\n')
  writeFileSync(`${root}/_stub/generations.jsonl`, '{"costUSD":999}\n')
  expect(recordedSpend(root)).toBeCloseTo(10.01)
  expect(newSpend(root)).toBeCloseTo(10.01 - 3.24134741)
})

test('credit guard refuses a request whose reservation would cross account baseline plus $19', async () => {
  const fakeFetch = async () => Response.json({ data: { total_usage: 26.35 } })
  const guard = new CreditGuard('dummy', fakeFetch as unknown as typeof fetch)
  expect(await guard.assertAvailable(0.04)).toBeCloseTo(26.35)
  await expect(guard.assertAvailable(0.05)).rejects.toBeInstanceOf(CreditLimitError)
})
