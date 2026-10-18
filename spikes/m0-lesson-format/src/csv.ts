import { writeFileSync } from 'node:fs'
import type { GenRecord } from './score.ts'
import { scoreAll } from './stats.ts'

const columns = ['run', 'model', 'arm', 'task', 'sample', 'status', 'm1', 'm2', 'm3', 'm4', 'm5first', 'm6first', 'm7', 'checklist', 'literals', 'nesting', 'rounds', 'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'cost_usd'] as const
const escape = (value: unknown) => {
  const s = String(value ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function resultsCsv(records: GenRecord[]): string {
  const scores = new Map(scoreAll(records).map((x) => [x.rec.key, x.s]))
  const rows = records.map((r) => {
    const s = scores.get(r.key)
    const sum = (field: 'input' | 'output' | 'cacheWrite' | 'cacheRead') => r.rounds.reduce((n, x) => n + x.usage[field], 0)
    return [r.run, r.model, r.arm, r.taskId, r.sample, r.status, s?.m1, s?.m2, s?.m3, s?.m4, s?.m5first, s?.m6first, s?.m7, s?.checklist, s?.literals, s?.nesting, Math.max(0, r.rounds.length - 1), sum('input'), sum('output'), sum('cacheWrite'), sum('cacheRead'), r.costUSD].map(escape).join(',')
  })
  return [columns.join(','), ...rows].join('\n') + '\n'
}

export function writeResultsCsv(dir: string, records: GenRecord[]) {
  writeFileSync(`${dir}/results.csv`, resultsCsv(records))
}
