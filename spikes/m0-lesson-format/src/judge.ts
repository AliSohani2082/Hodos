// Q1: LLM-judge score (§8.5). The judge sees a format-normalised plain rendering of the lesson AST, so syntax
// cannot bias it, and it is blind to the arm. One judgment per output.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { Budget, costOf, worstCase } from './cost.ts'
import { CreditLimitError } from './credits.ts'
import type { LlmClient } from './llm.ts'
import { renderPlain } from './render.ts'
import type { GenRecord } from './score.ts'
import { contextFor, loadPack, taskById } from './tasks.ts'
import { validateLesson } from './validate.ts'
import type { Model } from './types.ts'

export const JUDGE_MODEL: Model = 'claude-opus-5-5'

const RUBRIC = ['claims_supported', 'perspective_fidelity', 'coherence', 'pedagogical_fit'] as const

const SCHEMA = {
  type: 'object',
  properties: {
    ...Object.fromEntries(RUBRIC.map((k) => [k, { type: 'integer', description: '1 (poor) to 5 (excellent)' }])),
    notes: { type: 'string', description: 'One or two sentences on the main weakness.' },
  },
  required: [...RUBRIC, 'notes'],
  additionalProperties: false,
}

const SYSTEM = `You grade lessons written for a course platform. You see the task, the source chunks the author was given, and the lesson in plain text. Source markers look like [source: src:x#c3]; "Perspective from src:x" blocks attribute a viewpoint to one outlet.

Score each item from 1 to 5:
- claims_supported: factual claims are supported by the chunks they cite, and nothing important is unsupported or invented.
- perspective_fidelity: each perspective block is faithful to what its outlet's chunks say, and the perspectives are distinct.
- coherence: the core explanation is correct, well ordered and self-consistent.
- pedagogical_fit: it suits the stated learner level and layout, and its exercises or examples teach the concept.

Judge content only. Ignore formatting, markup and block mechanics. 3 is adequate, 5 is excellent, 1 is poor.`

export interface Judgment {
  key: string
  scores: Record<(typeof RUBRIC)[number], number>
  q1: number
  notes: string
  costUSD: number
}

export function readJudgments(dir: string): Judgment[] {
  const f = `${dir}/judgments.jsonl`
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

export function judgePrompt(rec: GenRecord): string {
  const task = taskById(rec.taskId)
  const pack = loadPack(task.pack)
  const chunks = pack.chunks.filter((c) => task.chunkIds.includes(c.id))
  const final = rec.rounds[rec.rounds.length - 1]!
  const v = validateLesson(rec.arm, final.text, contextFor(task))
  return [
    `# Task\nConcept: ${task.concept}\nLearner level: ${task.level}\nCourse layout: ${task.layout}`,
    '# Source chunks given to the author',
    ...chunks.map((c) => `## ${c.id} (outlet ${c.outlet})\n${c.text}`),
    '# Lesson (plain text)',
    renderPlain(v.doc),
  ].join('\n\n')
}

export async function runJudge(opts: { dir: string; records: GenRecord[]; client: LlmClient; capUSD: number; initialSpentUSD?: number; concurrency: number; maxTokens?: number; log?: (l: string) => void }) {
  const log = opts.log ?? console.log
  const file = `${opts.dir}/judgments.jsonl`
  const prior = readJudgments(opts.dir)
  const done = new Set(prior.map((j) => j.key))
  const budget = new Budget(opts.capUSD)
  budget.spent = (opts.initialSpentUSD ?? 0) + prior.reduce((n, j) => n + j.costUSD, 0)
  const maxTokens = opts.maxTokens ?? 6000
  const queue = opts.records.filter((r) => r.status === 'ok' && r.rounds.length && !done.has(r.key))
  let next = 0
  let stopped = false
  const worker = async () => {
    while (next < queue.length && !stopped) {
      const rec = queue[next++]!
      const user = judgePrompt(rec)
      const worst = worstCase(JUDGE_MODEL, Math.ceil((SYSTEM.length + user.length) / 2.8), maxTokens)
      if (!budget.tryReserve(worst)) { stopped = true; return }
      let charged = 0
      try {
        const res = await opts.client.complete({ model: JUDGE_MODEL, system: SYSTEM, turns: [{ role: 'user', content: user }], maxTokens, schema: SCHEMA, reservationUSD: worst })
        const cost = costOf(JUDGE_MODEL, res.usage)
        budget.settle(worst, cost)
        charged = cost
        const parsed = JSON.parse(res.text) as Record<string, unknown>
        const scores = Object.fromEntries(RUBRIC.map((k) => [k, Number(parsed[k])])) as Judgment['scores']
        const q1 = RUBRIC.reduce((n, k) => n + scores[k], 0) / RUBRIC.length
        appendFileSync(file, JSON.stringify({ key: rec.key, scores, q1, notes: String(parsed.notes ?? ''), costUSD: cost } satisfies Judgment) + '\n')
        log(`judged ${rec.key} q1=${q1.toFixed(2)} total=$${budget.spent.toFixed(2)}/${opts.capUSD}`)
      } catch (err) {
        if (err instanceof CreditLimitError) {
          if (err.requestStarted) { budget.settle(worst, worst); charged = worst }
          else budget.release(worst)
          stopped = true
        } else if (!charged) {
          // A network failure might occur after the paid request began; retain the reservation.
          budget.settle(worst, worst)
          charged = worst
        }
        if (charged) appendFileSync(`${opts.dir}/judge-spend.jsonl`, JSON.stringify({ key: rec.key, costUSD: charged, error: err instanceof Error ? err.message : String(err) }) + '\n')
        log(`  judge ERROR ${rec.key}: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, worker))
  return { judged: readJudgments(opts.dir).length, spent: budget.spent, stoppedByBudget: stopped }
}
