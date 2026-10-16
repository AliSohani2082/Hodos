// The eval loop (§8.4): for each task x arm x model x sample: generate once, validate, repair up to 3 rounds,
// record every round. Resumable (JSONL, one record per finished generation) and budget-capped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Budget, costOf, PRICES, worstCase } from './cost.ts'
import type { LlmClient, Turn } from './llm.ts'
import { examples, repairPrompt, syntaxSection, systemPrompt, taskPrompt } from './prompts.ts'
import { MAX_REPAIRS, type GenRecord, type RoundRecord } from './score.ts'
import { contextFor, loadPack } from './tasks.ts'
import { validateLesson } from './validate.ts'
import { ARMS, type Arm, type Model, type Task } from './types.ts'

export interface RunConfig {
  run: string
  dir: string // results/<run>
  tasks: Task[]
  models: Model[]
  arms: Arm[]
  samples: number
  capUSD: number
  initialSpentUSD?: number // spend in other run directories, including judging
  concurrency: number
  maxTokens: number
  client: LlmClient
  log?: (line: string) => void
}

export const keyOf = (model: Model, arm: Arm, taskId: string, sample: number) => `${model}|${arm}|${taskId}|${sample}`

export function readRecords(dir: string): GenRecord[] {
  const f = `${dir}/generations.jsonl`
  if (!existsSync(f)) return []
  const recs = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GenRecord)
  // Visible-token counts (from `count`) live beside the log, which stays append-only.
  const tf = `${dir}/tokens.json`
  if (existsSync(tf)) {
    const tokens = JSON.parse(readFileSync(tf, 'utf8')) as Record<string, number>
    for (const r of recs) if (tokens[r.key] !== undefined) r.visibleTokens = tokens[r.key]
  }
  return recs
}

/** If the whole answer is wrapped in one code fence around a file that starts with frontmatter, unwrap it. */
export function extractLesson(text: string): string {
  const t = text.trim()
  const m = /^`{3,}[\w-]*\n([\s\S]*?)\n`{3,}$/.exec(t)
  return m && m[1]!.trimStart().startsWith('---') ? m[1]! + '\n' : t + '\n'
}

const estimateInputTokens = (system: string, turns: Turn[]) =>
  Math.ceil((system.length + turns.reduce((n, t) => n + (typeof t.content === 'string' ? t.content.length : JSON.stringify(t.content).length), 0)) / 2.8)

async function runOne(cfg: RunConfig, budget: Budget, model: Model, arm: Arm, task: Task, sample: number): Promise<GenRecord> {
  const pack = loadPack(task.pack)
  const ctx = contextFor(task)
  const system = systemPrompt(arm, task.allowed)
  const turns: Turn[] = [{ role: 'user', content: taskPrompt(task, pack), cache: true }]
  const rec: GenRecord = { key: keyOf(model, arm, task.id, sample), run: cfg.run, model, arm, taskId: task.id, sample, status: 'ok', rounds: [], costUSD: 0 }

  for (let i = 0; i <= MAX_REPAIRS; i++) {
    const worst = worstCase(model, estimateInputTokens(system, turns), cfg.maxTokens)
    if (!budget.tryReserve(worst)) { rec.status = 'budget'; break }
    let res
    try {
      res = await cfg.client.complete({ model, system, turns, maxTokens: cfg.maxTokens })
    } catch (err) {
      budget.settle(worst, 0)
      rec.status = 'error'
      rec.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      break
    }
    const cost = costOf(model, res.usage)
    budget.settle(worst, cost)
    const text = extractLesson(res.text)
    const round: RoundRecord = { kind: i === 0 ? 'generate' : 'repair', text, stopReason: res.stopReason, usage: res.usage, costUSD: cost, ms: res.ms }
    rec.rounds.push(round)
    rec.costUSD += cost
    const v = validateLesson(arm, text, ctx)
    const stop = res.stopReason
    if (stop === 'refusal') break
    if (v.valid && stop !== 'max_tokens') break
    if (i === MAX_REPAIRS) break
    turns.push({ role: 'assistant', content: res.raw }, { role: 'user', content: repairPrompt(v.diagnostics) })
  }
  return rec
}

export function promptFingerprint(): Record<Arm, string> {
  const h = (arm: Arm) => createHash('sha256').update([syntaxSection(arm), ...examples(arm), systemPrompt(arm, ['cite'])].join('\u0000')).digest('hex').slice(0, 16)
  return { markdoc: h('markdoc'), directive: h('directive') }
}

export async function runEval(cfg: RunConfig) {
  const log = cfg.log ?? ((l: string) => console.log(l))
  mkdirSync(cfg.dir, { recursive: true })
  const file = `${cfg.dir}/generations.jsonl`
  const prior = readRecords(cfg.dir)
  const done = new Set(prior.filter((r) => r.status === 'ok').map((r) => r.key))
  const budget = new Budget(cfg.capUSD)
  budget.spent = (cfg.initialSpentUSD ?? 0) + prior.reduce((n, r) => n + r.costUSD, 0)
  if (!existsSync(`${cfg.dir}/run.json`))
    writeFileSync(`${cfg.dir}/run.json`, JSON.stringify({ run: cfg.run, startedAt: new Date().toISOString(), models: cfg.models, arms: cfg.arms, tasks: cfg.tasks.map((t) => t.id), samples: cfg.samples, capUSD: cfg.capUSD, maxTokens: cfg.maxTokens, effort: 'medium', thinking: 'adaptive', prices: PRICES, promptFingerprint: promptFingerprint() }, null, 2))

  // A group = (task, model, arm); its samples run in sequence so samples 2 and 3 hit the prompt cache.
  const groups: { task: Task; model: Model; arm: Arm }[] = []
  for (const task of cfg.tasks) for (const model of cfg.models) for (const arm of cfg.arms) groups.push({ task, model, arm })

  const stats = { ran: 0, skipped: 0, budgetStopped: 0, errors: 0 }
  let next = 0
  const worker = async () => {
    while (next < groups.length) {
      const g = groups[next++]!
      for (let s = 1; s <= cfg.samples; s++) {
        const key = keyOf(g.model, g.arm, g.task.id, s)
        if (done.has(key)) { stats.skipped++; continue }
        const rec = await runOne(cfg, budget, g.model, g.arm, g.task, s)
        if (rec.rounds.length) appendFileSync(file, JSON.stringify(rec) + '\n')
        if (rec.status === 'ok') stats.ran++
        else if (rec.status === 'budget') { stats.budgetStopped++; return }
        else { stats.errors++; log(`  ERROR ${key}: ${rec.error}`) }
        const last = rec.rounds[rec.rounds.length - 1]
        log(`${rec.status.padEnd(6)} ${key}  rounds=${rec.rounds.length} stop=${last?.stopReason} cost=$${rec.costUSD.toFixed(3)} total=$${budget.spent.toFixed(2)}/${cfg.capUSD}`)
      }
    }
  }
  await Promise.all(Array.from({ length: cfg.concurrency }, worker))
  return { ...stats, spent: budget.spent }
}

export { ARMS }
