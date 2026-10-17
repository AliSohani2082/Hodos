// CLI. New live calls use a $19 approval measured from the completed pilot and account-credit baselines.
//   bun run src/cli.ts check                          validate the gold lesson of every task in both arms (free)
//   bun run src/cli.ts quote [--tasks pilot|all]      estimate cost from measured prompt sizes (free)
//   bun run src/cli.ts run --tasks pilot --cap-usd 4.50  reduced pilot, cumulative with smoke
//   bun run src/cli.ts stub [--tasks all]             full pipeline against the offline stub (free)
//   bun run src/cli.ts smoke --cap-usd 0.05           one tiny Haiku call: checks credentials and the request shape
//   bun run src/cli.ts count|judge|report|q2 ...
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { OpenRouterLlm, type LlmClient } from './llm.ts'
import { costOf, RESERVE_PRICES, worstCase } from './cost.ts'
import { writeResultsCsv } from './csv.ts'
import { print } from './print.ts'
import { systemPrompt, taskPrompt } from './prompts.ts'
import { exportPairs, scorePairs } from './q2.ts'
import { buildReport } from './report.ts'
import { readRecords, runEval } from './runner.ts'
import { StubLlm } from './stub.ts'
import { approvedCap, newSpend, recordedSpend } from './spend.ts'
import { goldDoc } from './synth.ts'
import { estimateTokens } from './score.ts'
import { contextFor, loadPack, PILOT_TASK_IDS, TASKS, taskById } from './tasks.ts'
import { validateLesson } from './validate.ts'
import { blocksOf } from './shared-validate.ts'
import { ARMS, type Arm, type Model, type Task } from './types.ts'

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)
const ALL_MODELS: Model[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const REDUCED_PILOT_TASK_IDS = PILOT_TASK_IDS.slice(0, 6)
// One base task omitted per domain (all five shapes remain represented); all six adversarial tasks retained.
const REDUCED_FULL_OMIT = new Set(['math-s1', 'programming-s2', 'chess-s3', 'language-s4', 'history-s5', 'science-s1'])
const REDUCED_FULL_TASK_IDS = TASKS.filter((t) => !REDUCED_FULL_OMIT.has(t.id)).map((t) => t.id)
const RESULTS = new URL('../results/', import.meta.url).pathname

function pickTasks(): Task[] {
  const v = flag('tasks') ?? 'pilot'
  if (v === 'all') return TASKS
  if (v === 'pilot') return REDUCED_PILOT_TASK_IDS.map(taskById)
  if (v === 'reduced-full') return REDUCED_FULL_TASK_IDS.map(taskById)
  return v.split(',').map(taskById)
}
const pickModels = (): Model[] => (flag('models') ? (flag('models')!.split(',') as Model[]) : ALL_MODELS)
const pickArms = (): Arm[] => (flag('arms') ? (flag('arms')!.split(',') as Arm[]) : ARMS)

function die(msg: string): never {
  console.error(msg)
  process.exit(2)
}

function liveCap(): number {
  try { return approvedCap(flag('cap-usd')) }
  catch (err) { die(`${err instanceof Error ? err.message : err}. Nothing was sent.`) }
}

function requireCredentials() {
  if (!process.env.OPENROUTER_API_KEY)
    die('No OpenRouter credentials found. Set OPENROUTER_API_KEY in .env, then re-run. Nothing was sent.')
}

function runDir(def: string) {
  return `${RESULTS}${flag('run') ?? def}`
}

async function main() {
  switch (cmd) {
    case 'check': {
      let bad = 0
      for (const t of TASKS) {
        const pack = loadPack(t.pack)
        const doc = goldDoc(t, pack)
        const shapes: string[] = []
        for (const arm of ARMS) {
          const text = print(arm, doc)
          const v = validateLesson(arm, text, contextFor(t))
          shapes.push(JSON.stringify(blocksOf(v.doc.children).map((b) => [b.type, b.attrs])))
          if (!v.valid) { bad++; console.log(`INVALID ${t.id} ${arm}: ${v.diagnostics.map((d) => `L${d.line} ${d.id} ${d.message}`).join(' | ')}`) }
        }
        if (shapes[0] !== shapes[1]) { bad++; console.log(`PARITY MISMATCH ${t.id}`) }
      }
      console.log(bad ? `${bad} problems` : `all ${TASKS.length} gold lessons valid in both arms with identical trees`)
      process.exit(bad ? 1 : 0)
    }

    case 'quote': {
      const tasks = pickTasks()
      const samples = Number(flag('samples') ?? (flag('tasks') === 'all' ? 3 : 1))
      const models = pickModels()
      // Spec assumptions for output (§8.6) with measured prompt sizes. 3.3 chars per token is a rough guess.
      const OUT = 5500, REPAIR_RATE = 0.3, REPAIR_ROUNDS = 1.3, REPAIR_IN = 15000, REPAIR_OUT = 4000
      let total = 0
      console.log(`${tasks.length} tasks x ${pickArms().length} arms x ${models.length} models x ${samples} sample(s) = ${tasks.length * pickArms().length * models.length * samples} generations\n`)
      for (const model of models) {
        const p = RESERVE_PRICES[model]
        let cost = 0, n = 0
        for (const t of tasks)
          for (const arm of pickArms()) {
            const inTok = (systemPrompt(arm, t.allowed).length + taskPrompt(t, loadPack(t.pack)).length) / 3.3
            const per = (inTok * p.input + OUT * p.output) / 1e6 + REPAIR_RATE * REPAIR_ROUNDS * ((REPAIR_IN * p.input + REPAIR_OUT * p.output) / 1e6)
            cost += per * samples
            n += samples
          }
        total += cost
        console.log(`${model.padEnd(20)} ${String(n).padStart(4)} generations  ~$${cost.toFixed(2)}`)
      }
      console.log(`\nestimated generation cost ~$${total.toFixed(2)} (no prompt-cache discount, spec's output and repair assumptions)`)
      console.log('Quote uses published OpenRouter rates for planning; live cost comes from OpenRouter usage.cost.')
      return
    }

    case 'stub':
    case 'run': {
      const stub = cmd === 'stub'
      let client: LlmClient
      if (stub) client = new StubLlm()
      else {
        liveCap()
        const tasksFlag = flag('tasks') ?? 'pilot'
        const samples = Number(flag('samples') ?? (tasksFlag === 'all' ? 3 : 1))
        if ((tasksFlag === 'all' || samples > 1 || flag('run') === 'full') && !has('confirm-full'))
          die('This is the full-run shape (all tasks or >1 sample). It needs explicit budget approval: pass --confirm-full once the budget has been approved. Nothing was sent.')
        requireCredentials()
        client = new OpenRouterLlm()
      }
      const tasks = pickTasks()
      const samples = Number(flag('samples') ?? (flag('tasks') === 'all' ? 3 : 1))
      const dir = runDir(stub ? '_stub' : flag('tasks') === 'all' ? 'full' : 'pilot')
      const cap = stub ? 1e9 : liveCap()
      const spent = stub ? 0 : newSpend(RESULTS)
      const priorHere = stub ? 0 : readRecords(dir).reduce((n, r) => n + r.costUSD, 0)
      if (!stub && spent >= cap) die(`Recorded spend $${spent.toFixed(2)} has reached the approved cap $${cap.toFixed(2)}. Nothing was sent.`)
      console.log(`run dir: ${dir}  cap: $${cap}  tasks: ${tasks.length}  samples: ${samples}`)
      const res = await runEval({ run: dir.split('/').pop()!, dir, tasks, models: pickModels(), arms: pickArms(), samples, capUSD: cap, initialSpentUSD: spent - priorHere, concurrency: Number(flag('concurrency') ?? 1), maxTokens: Number(flag('max-tokens') ?? 6000), client })
      writeResultsCsv(dir, readRecords(dir))
      console.log(`\ndone: ${JSON.stringify(res)}`)
      return
    }

    case 'smoke': {
      const cap = liveCap()
      requireCredentials()
      const model: Model = 'claude-haiku-5-5'
      const system = 'You are a connectivity check. Reply with the single word OK.'
      const user = 'Reply with the single word OK.'
      const worst = worstCase(model, system.length + user.length, 1000)
      if (newSpend(RESULTS) + worst > cap) die('Smoke reservation exceeds the approved cumulative cap. Nothing was sent.')
      let res
      try {
        res = await new OpenRouterLlm().complete({
          model,
          system,
          turns: [{ role: 'user', content: user, cache: true }],
          maxTokens: 1000,
          reservationUSD: worst,
        })
      } catch {
        const smokeDir = `${RESULTS}smoke`
        mkdirSync(smokeDir, { recursive: true })
        appendFileSync(`${smokeDir}/smoke-spend.jsonl`, JSON.stringify({ costUSD: worst, estimated: true }) + '\n')
        die('OpenRouter smoke call failed or omitted usage; worst-case reservation recorded to preserve the cumulative cap.')
      }
      const cost = costOf(model, res.usage)
      const smokeDir = `${RESULTS}smoke`
      mkdirSync(smokeDir, { recursive: true })
      appendFileSync(`${smokeDir}/smoke-spend.jsonl`, JSON.stringify({ costUSD: cost }) + '\n')
      console.log(`reply: ${JSON.stringify(res.text.trim())}  stop: ${res.stopReason}  usage: ${JSON.stringify(res.usage)}  cost: $${cost.toFixed(5)}  ${res.ms}ms`)
      if (cost > cap) die(`cost $${cost} exceeded the cap`)
      console.log('OpenRouter request accepted (medium reasoning, streaming, and provider-reported usage cost).')
      return
    }

    case 'count': {
      const dir = runDir('pilot')
      const file = `${dir}/tokens.json`
      const have: Record<string, number> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      for (const r of readRecords(dir)) {
        if (r.status !== 'ok' || have[r.key] !== undefined) continue
        have[r.key] = estimateTokens(r.rounds[r.rounds.length - 1]!.text)
      }
      writeFileSync(file, JSON.stringify(have))
      console.log(`counted ${Object.keys(have).length} lessons`)
      return
    }

    case 'judge': {
      die('Judge requires a separately verified affordable quote; no judge calls were sent.')
    }

    case 'report': {
      const dir = runDir('pilot')
      const records = readRecords(dir)
      if (!records.length) die(`no records in ${dir}`)
      const q2 = existsSync(`${dir}/q2-score.json`) ? (JSON.parse(readFileSync(`${dir}/q2-score.json`, 'utf8')).prefM as number) : undefined
      const md = buildReport({ run: dir.split('/').pop()!, records, dir, q2prefM: q2, iterationUsed: has('iteration-used'), totalSpendUSD: recordedSpend(RESULTS) })
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/report.md`, md)
      writeResultsCsv(dir, records)
      console.log(md)
      return
    }

    case 'q2': {
      const dir = runDir('full')
      if (args[1] === 'export') exportPairs({ dir, records: readRecords(dir), n: Number(flag('pairs') ?? 30), seed: Number(flag('seed') ?? 1), model: (flag('model') as Model) ?? 'claude-opus-5-5' })
      else if (args[1] === 'score') console.log(JSON.stringify(scorePairs({ dir, records: readRecords(dir) }), null, 2))
      else die('usage: q2 export|score [--run name]')
      return
    }

    default:
      die('commands: check | quote | run | stub | smoke | count | judge | report | q2')
  }
}

await main()
