// CLI. Nothing here spends money unless `run` or `judge` is given an explicit --cap-usd.
//   bun run src/cli.ts check                          validate the gold lesson of every task in both arms (free)
//   bun run src/cli.ts quote [--tasks pilot|all]      estimate cost from measured prompt sizes (free)
//   bun run src/cli.ts run --tasks pilot --cap-usd 7  generate + repair (spends money)
//   bun run src/cli.ts stub [--tasks all]             full pipeline against the offline stub (free)
//   bun run src/cli.ts smoke --cap-usd 0.05           one tiny Haiku call: checks credentials and the request shape
//   bun run src/cli.ts count|judge|report|q2 ...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { AnthropicLlm, type LlmClient } from './llm.ts'
import { costOf, PRICES } from './cost.ts'
import { runJudge } from './judge.ts'
import { print } from './print.ts'
import { systemPrompt, taskPrompt } from './prompts.ts'
import { exportPairs, scorePairs } from './q2.ts'
import { buildReport } from './report.ts'
import { readRecords, runEval } from './runner.ts'
import { StubLlm } from './stub.ts'
import { goldDoc } from './synth.ts'
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
const RESULTS = new URL('../results/', import.meta.url).pathname

function pickTasks(): Task[] {
  const v = flag('tasks') ?? 'pilot'
  if (v === 'all') return TASKS
  if (v === 'pilot') return PILOT_TASK_IDS.map(taskById)
  return v.split(',').map(taskById)
}
const pickModels = (): Model[] => (flag('models') ? (flag('models')!.split(',') as Model[]) : ALL_MODELS)
const pickArms = (): Arm[] => (flag('arms') ? (flag('arms')!.split(',') as Arm[]) : ARMS)

function die(msg: string): never {
  console.error(msg)
  process.exit(2)
}

function requireCredentials() {
  const hasEnv = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const hasProfile = existsSync(`${homedir()}/.config/anthropic`)
  if (!hasEnv && !hasProfile)
    die('No Anthropic credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`), then re-run. Nothing was sent.')
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
        const p = PRICES[model]
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
      console.log('Pilot first: replace these assumptions with measured tokens, then re-quote. The judge is extra (about 648 x ~$0.05).')
      return
    }

    case 'stub':
    case 'run': {
      const stub = cmd === 'stub'
      let client: LlmClient
      if (stub) client = new StubLlm()
      else {
        const cap = flag('cap-usd')
        if (!cap || !(Number(cap) > 0)) die('run needs an explicit --cap-usd <dollars>. Nothing was sent.')
        const tasksFlag = flag('tasks') ?? 'pilot'
        const samples = Number(flag('samples') ?? (tasksFlag === 'all' ? 3 : 1))
        if ((tasksFlag === 'all' || samples > 1) && !has('confirm-full'))
          die('This is the full-run shape (all tasks or >1 sample). It needs explicit budget approval: pass --confirm-full once the budget has been approved. Nothing was sent.')
        requireCredentials()
        client = new AnthropicLlm()
      }
      const tasks = pickTasks()
      const samples = Number(flag('samples') ?? (flag('tasks') === 'all' ? 3 : 1))
      const dir = runDir(stub ? '_stub' : flag('tasks') === 'all' ? 'full' : 'pilot')
      const cap = stub ? 1e9 : Number(flag('cap-usd'))
      console.log(`run dir: ${dir}  cap: $${cap}  tasks: ${tasks.length}  samples: ${samples}`)
      const res = await runEval({ run: dir.split('/').pop()!, dir, tasks, models: pickModels(), arms: pickArms(), samples, capUSD: cap, concurrency: Number(flag('concurrency') ?? 3), maxTokens: Number(flag('max-tokens') ?? 20000), client })
      console.log(`\ndone: ${JSON.stringify(res)}`)
      return
    }

    case 'smoke': {
      const cap = Number(flag('cap-usd'))
      if (!(cap > 0)) die('smoke needs an explicit --cap-usd <dollars> (a call costs well under $0.01). Nothing was sent.')
      requireCredentials()
      const model: Model = 'claude-haiku-5-5'
      const res = await new AnthropicLlm().complete({
        model,
        system: 'You are a connectivity check. Reply with the single word OK.',
        turns: [{ role: 'user', content: 'Reply with the single word OK.', cache: true }],
        maxTokens: 2000,
      })
      const cost = costOf(model, res.usage)
      console.log(`reply: ${JSON.stringify(res.text.trim())}  stop: ${res.stopReason}  usage: ${JSON.stringify(res.usage)}  cost: $${cost.toFixed(5)}  ${res.ms}ms`)
      if (cost > cap) die(`cost $${cost} exceeded the cap`)
      console.log('request shape accepted (adaptive thinking, effort medium, cache_control on system and user turn, streaming).')
      return
    }

    case 'count': {
      requireCredentials()
      const dir = runDir('pilot')
      const client = new AnthropicLlm()
      const file = `${dir}/tokens.json`
      const have: Record<string, number> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      for (const r of readRecords(dir)) {
        if (r.status !== 'ok' || have[r.key] !== undefined) continue
        have[r.key] = await client.countTokens!(r.model, r.rounds[r.rounds.length - 1]!.text)
      }
      writeFileSync(file, JSON.stringify(have))
      console.log(`counted ${Object.keys(have).length} lessons`)
      return
    }

    case 'judge': {
      const cap = Number(flag('cap-usd'))
      if (!(cap > 0)) die('judge needs an explicit --cap-usd <dollars>. Nothing was sent.')
      requireCredentials()
      const dir = runDir('full')
      const out = await runJudge({ dir, records: readRecords(dir), client: new AnthropicLlm(), capUSD: cap, concurrency: Number(flag('concurrency') ?? 3) })
      console.log(JSON.stringify(out))
      return
    }

    case 'report': {
      const dir = runDir('pilot')
      const records = readRecords(dir)
      if (!records.length) die(`no records in ${dir}`)
      const q2 = existsSync(`${dir}/q2-score.json`) ? (JSON.parse(readFileSync(`${dir}/q2-score.json`, 'utf8')).prefM as number) : undefined
      const md = buildReport({ run: dir.split('/').pop()!, records, dir, q2prefM: q2, iterationUsed: has('iteration-used') })
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/report.md`, md)
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
