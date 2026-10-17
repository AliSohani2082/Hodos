// The new full-run approval starts after the completed pilot; run names cannot reset its ceiling.
import { existsSync, readdirSync, readFileSync } from 'node:fs'

export const HARD_CAP_USD = 19
export const PRIOR_APPROVAL_SPEND_USD = 3.24134741
export const CREDIT_BASELINE_USD = 7.3976
export const CREDIT_LIMIT_USD = CREDIT_BASELINE_USD + HARD_CAP_USD

export function recordedSpend(resultsDir: string): number {
  if (!existsSync(resultsDir)) return 0
  let total = 0
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_stub') continue // offline stub
    for (const name of ['generations.jsonl', 'judgments.jsonl', 'judge-spend.jsonl', 'smoke-spend.jsonl']) {
      const path = `${resultsDir}/${entry.name}/${name}`
      if (!existsSync(path)) continue
      for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
        const value = Number((JSON.parse(line) as { costUSD?: number }).costUSD ?? 0)
        if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid cost in ${path}`)
        total += value
      }
    }
  }
  return total
}

export function approvedCap(value: string | undefined): number {
  const cap = Number(value)
  if (!value || !Number.isFinite(cap) || cap <= 0 || cap > HARD_CAP_USD)
    throw new Error(`An explicit --cap-usd between 0 and ${HARD_CAP_USD.toFixed(2)} is required`)
  return cap
}

export function newSpend(resultsDir: string): number {
  const amount = recordedSpend(resultsDir) - PRIOR_APPROVAL_SPEND_USD
  if (amount < -0.000001) throw new Error('Recorded spend is below the verified pre-full-run baseline')
  return Math.max(0, amount)
}
