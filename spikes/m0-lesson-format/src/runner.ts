// The eval loop (§8.4): for each task x arm x model x sample: generate once, validate, repair up to 3 rounds,
// record every round. Resumable (JSONL, one record per finished generation) and budget-capped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { Budget, costOf, RESERVE_PRICES, worstCase } from './cost.ts'
import { CreditLimitError } from './credits.ts'
import { CREDIT_BASELINE_USD, CREDIT_LIMIT_USD, PRIOR_APPROVAL_SPEND_USD } from './spend.ts'
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

async function runOne(cfg: RunConfig, budget: Budget, model: Model, arm: Arm, task: Task, sample: number, firstReservation?: number): Promise<GenRecord> {
  const pack = loadPack(task.pack)
  const ctx = contextFor(task)
  const system = systemPrompt(arm, task.allowed)
  const turns: Turn[] = [{ role: 'user', content: taskPrompt(task, pack), cache: true }]
  const rec: GenRecord = { key: keyOf(model, arm, task.id, sample), run: cfg.run, model, arm, taskId: task.id, sample, status: 'ok', rounds: [], costUSD: 0 }

  for (let i = 0; i <= MAX_REPAIRS; i++) {
    const worst = i === 0 && firstReservation !== undefined ? firstReservation : worstCase(model, estimateInputTokens(system, turns), cfg.maxTokens)
    if (i === 0 && firstReservation !== undefined) {
      if (budget.remaining < 0) {
        budget.release(worst)
        rec.status = 'budget'
        break
      }
    } else if (!budget.tryReserve(worst)) { rec.status = 'budget'; break }
    let res
    try {
      res = await cfg.client.complete({ model, system, turns, maxTokens: cfg.maxTokens, reservationUSD: worst })
    } catch (err) {
      if (err instanceof CreditLimitError) {
        if (err.requestStarted) { budget.settle(worst, worst); rec.costUSD += worst }
        else budget.release(worst)
        rec.status = 'budget'
        rec.error = err.message
        break
      }
      // A connection can fail after OpenRouter accepted and billed the request. Charge the reservation
      // conservatively so resume cannot spend it a second time.
      budget.settle(worst, worst)
      rec.status = 'error'
      rec.costUSD += worst
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
    writeFileSync(`${cfg.dir}/run.json`, JSON.stringify({ run: cfg.run, startedAt: new Date().toISOString(), provider: 'OpenRouter', models: cfg.models, arms: cfg.arms, tasks: cfg.tasks.map((t) => t.id), samples: cfg.samples, capUSD: cfg.capUSD, maxTokens: cfg.maxTokens, effort: 'medium', pricing: 'actual usage.cost from OpenRouter; published rates are used only for pre-call reservation', reservePrices: RESERVE_PRICES, promptFingerprint: promptFingerprint(), newApproval: cfg.run === 'full' ? { priorLocalSpendUSD: PRIOR_APPROVAL_SPEND_USD, creditTotalUsageBaselineUSD: CREDIT_BASELINE_USD, creditTotalUsageStopUSD: CREDIT_LIMIT_USD } : undefined, reducedPilot: cfg.run === 'pilot' ? { tasks: cfg.tasks.length, originalPilotTasks: 12, omittedAdversarialTasks: ['adv1', 'adv2', 'adv3', 'adv4', 'adv5', 'adv6'] } : undefined }, null, 2))

  // Reserve both syntax arms' first call before either starts, so the cap cannot leave a task/model pair one-sided.
  const groups: { task: Task; model: Model }[] = []
  for (const task of cfg.tasks) for (const model of cfg.models) groups.push({ task, model })

  const stats = { ran: 0, skipped: 0, budgetStopped: 0, errors: 0 }
  let next = 0
  const worker = async () => {
    while (next < groups.length) {
      const g = groups[next++]!
      for (let s = 1; s <= cfg.samples; s++) {
        const arms = cfg.arms.filter((arm) => !done.has(keyOf(g.model, arm, g.task.id, s)))
        if (arms.length !== cfg.arms.length) stats.skipped += cfg.arms.length - arms.length
        if (!arms.length) continue
        const reservations = new Map<Arm, number>()
        const pack = loadPack(g.task.pack)
        for (const arm of arms) {
          const system = systemPrompt(arm, g.task.allowed)
          const turns: Turn[] = [{ role: 'user', content: taskPrompt(g.task, pack), cache: true }]
          const worst = worstCase(g.model, estimateInputTokens(system, turns), cfg.maxTokens)
          if (!budget.tryReserve(worst)) {
            for (const held of reservations.values()) budget.release(held)
            stats.budgetStopped += arms.length
            return
          }
          reservations.set(arm, worst)
        }
        for (const arm of arms) {
          const key = keyOf(g.model, arm, g.task.id, s)
          const rec = await runOne(cfg, budget, g.model, arm, g.task, s, reservations.get(arm))
          if (rec.rounds.length || rec.costUSD > 0) appendFileSync(file, JSON.stringify(rec) + '\n')
          if (rec.status === 'ok') stats.ran++
          else if (rec.status === 'budget') { stats.budgetStopped++; return }
          else { stats.errors++; log(`  ERROR ${key}: ${rec.error}`) }
          const last = rec.rounds[rec.rounds.length - 1]
          log(`${rec.status.padEnd(6)} ${key}  rounds=${rec.rounds.length} stop=${last?.stopReason} cost=$${rec.costUSD.toFixed(3)} total=$${budget.spent.toFixed(2)}/${cfg.capUSD}`)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: cfg.concurrency }, worker))
  return { ...stats, spent: budget.spent }
}

export { ARMS }
