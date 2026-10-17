// Report: per-format validity, repair rounds and cost (the ticket's "Done when"), the K1-K6 gates, the decision,
// and a re-quote for the full run built from measured token counts (§8.6 says to replace the assumptions).
import { readJudgments, type Judgment } from './judge.ts'
import { RESERVE_PRICES } from './cost.ts'
import { MAX_REPAIRS, type GenRecord } from './score.ts'
import { cellMean, cellN, decide, pairedDiff, pairedDiffBy, scoreAll, THRESHOLDS, type Quality, type Scored } from './stats.ts'
import { TASKS } from './tasks.ts'
import { validateLesson } from './validate.ts'
import { contextFor } from './tasks.ts'
import type { Arm, DiagId, Model } from './types.ts'

const MODELS: Model[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const ARM_NAME: Record<Arm, string> = { markdoc: 'Markdoc', directive: 'Directive' }
const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const pp = (x: number) => (Number.isNaN(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`)
const num = (x: number, d = 2) => (Number.isNaN(x) ? 'n/a' : x.toFixed(d))
const usd = (x: number) => `$${x.toFixed(2)}`
const usdActual = (x: number) => `$${x.toFixed(x < 0.01 ? 5 : 3)}`
const short = (m: Model) => m.replace('claude-', '').replace('-5-5', ' 5.5')

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
}

export function qualityOf(scored: Scored[], judgments: Judgment[]): Quality | undefined {
  if (!judgments.length) return undefined
  const q1 = new Map(judgments.map((j) => [j.key, j.q1]))
  const out: Quality = { q1: {} }
  for (const model of MODELS) {
    const d = pairedDiffBy(scored, model, (x) => q1.get(x.rec.key), { sign: -1 }) // M minus D
    if (d.tasks) out.q1[model] = d
  }
  return out
}

export function buildReport(args: { run: string; records: GenRecord[]; dir: string; q2prefM?: number; iterationUsed?: boolean; totalSpendUSD?: number }): string {
  const { run, records, dir } = args
  const scored = scoreAll(records)
  const ok = records.filter((r) => r.status === 'ok')
  const spent = records.reduce((n, r) => n + r.costUSD, 0)
  const taskIds = new Set(scored.map((x) => x.task.id))
  const samples = Math.max(0, ...scored.map((x) => x.rec.sample))
  const full = taskIds.size === TASKS.length && samples >= 3 && ok.length >= TASKS.length * 2 * MODELS.length * 3
  const reducedPilot = run === 'pilot'
  const fundedRun = run === 'full'
  const judgments = readJudgments(dir)
  const quality = qualityOf(scored, judgments)
  if (quality && args.q2prefM !== undefined) quality.q2prefM = args.q2prefM
  const L: string[] = []

  L.push(`# Markdoc vs directives: results for run \`${run}\``, '')
  L.push(
    full
      ? `**Full run**: ${taskIds.size} tasks, ${samples} samples per cell.`
      : reducedPilot
        ? `**REDUCED PILOT / PARTIAL RUN**: ${taskIds.size} of ${TASKS.length} tasks, up to ${samples} sample(s) per cell. The planned reduced pilot uses 6 of the original 12 pilot tasks: one base task per domain; the 6 adversarial tasks were omitted to fit the $4.50 cumulative cap. The K1-K6 thresholds assume the full 36 tasks x 3 samples, so nothing below is a verdict.`
        : fundedRun
          ? `**FUNDED REDUCED EVALUATION**: ${taskIds.size} of ${TASKS.length} tasks with up to ${samples} sample(s) per cell. The specified 36 tasks x 2 arms x 3 models x 3 samples (648 generations) exceeds the $19.00 new-spend approval; this run prioritises paired Opus and Sonnet results. K1-K6 thresholds are unchanged, but the reduced sample weakens their precision. The rule calculation below is descriptive until coverage and quality checks are complete.`
          : `**OFFLINE OR PARTIAL RUN**: ${taskIds.size} of ${TASKS.length} tasks, up to ${samples} sample(s) per cell. The K1-K6 thresholds assume the full 36 tasks x 3 samples, so nothing below is a verdict.`,
    '',
    `${ok.length} finished generations, ${records.length - ok.length} unfinished (budget or API error, excluded). Spend so far: ${usd(spent)} on generation${judgments.length ? ` and ${usd(judgments.reduce((n, j) => n + j.costUSD, 0))} on judging` : ''}.`,
    ...(args.totalSpendUSD !== undefined ? [reducedPilot ? `Cumulative OpenRouter spend recorded across smoke and generation: $${args.totalSpendUSD.toFixed(8)} of the $4.50 pilot cap.` : `New OpenRouter spend recorded since the full-run approval: $${args.totalSpendUSD.toFixed(8)} of the $19.00 hard cap.`] : []),
    ...(reducedPilot ? ['[Ten-output manual scoring spot-check](spot-check.md).'] : []),
    '',
  )

  // ----- headline table
  L.push('## First-pass validity, repair rounds and cost, per format', '')
  L.push('| Model | Format | n | First-pass valid (M1) | Final valid (M2) | Repair rounds (M3) | Silent drops (M4) | Semantic ok, 1st pass (M5) | Disallowed block (M6) | Output tokens (M7) | $ / lesson |')
  L.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const model of MODELS)
    for (const arm of ['markdoc', 'directive'] as Arm[]) {
      const n = cellN(scored, model, arm)
      if (!n) continue
      const cost = mean(records.filter((r) => r.model === model && r.arm === arm && r.status === 'ok').map((r) => r.costUSD))
      L.push(
        `| ${short(model)} | ${ARM_NAME[arm]} | ${n} | ${pct(cellMean(scored, model, arm, 'm1'))} | ${pct(cellMean(scored, model, arm, 'm2'))} | ${num(cellMean(scored, model, arm, 'm3'))} | ${pct(cellMean(scored, model, arm, 'm4'))} | ${pct(cellMean(scored, model, arm, 'm5first'))} | ${pct(cellMean(scored, model, arm, 'm6first'))} | ${Math.round(cellMean(scored, model, arm, 'm7'))} | ${usdActual(cost)} |`,
      )
    }
  L.push('', 'M3 counts a lesson that never reaches green as 3. M4 counts only drops the validator did not report; M4-any (reported or not) is in the table below.', '')

  // ----- paired differences
  L.push('## Paired differences, Directive minus Markdoc (95% cluster bootstrap over tasks)', '')
  L.push('| Model | Metric | D - M | 95% interval | tasks |', '|---|---|---|---|---|')
  for (const model of MODELS) {
    for (const [m, label, f] of [['m1', 'First-pass valid', pp], ['m2', 'Final valid', pp], ['m3', 'Repair rounds', (x: number) => num(x)], ['m4', 'Silent drops', pp]] as const) {
      const d = pairedDiff(scored, model, m)
      if (!d.tasks) continue
      L.push(`| ${short(model)} | ${label} | ${f(d.mean)} | ${f(d.lo)} to ${f(d.hi)} | ${d.tasks} |`)
    }
  }
  L.push('')

  // ----- fidelity checks
  L.push('## Fidelity checks (additions to M1-M7)', '')
  L.push('| Model | Format | Checklist met | Literals preserved (adversarial) | Required nesting (adv 4) | Dropped blocks, any (M4-any) |', '|---|---|---|---|---|---|')
  for (const model of MODELS)
    for (const arm of ['markdoc', 'directive'] as Arm[]) {
      const cell = scored.filter((x) => x.rec.model === model && x.rec.arm === arm)
      if (!cell.length) continue
      const lit = cell.filter((x) => x.task.literals?.length)
      const nest = cell.filter((x) => x.task.nesting)
      L.push(`| ${short(model)} | ${ARM_NAME[arm]} | ${pct(mean(cell.map((x) => x.s.checklist)))} | ${lit.length ? pct(mean(lit.map((x) => x.s.literals))) : 'n/a'} | ${nest.length ? pct(mean(nest.map((x) => x.s.nesting))) : 'n/a'} | ${pct(mean(cell.map((x) => x.s.m4silent)))} |`)
    }
  L.push('')

  // ----- first-pass failure reasons
  L.push('## What fails on the first pass', '', 'Share of first-pass lessons that carry at least one diagnostic of each kind.', '')
  const hist: Record<Arm, Map<DiagId, number>> = { markdoc: new Map(), directive: new Map() }
  const total: Record<Arm, number> = { markdoc: 0, directive: 0 }
  for (const x of scored) {
    total[x.rec.arm]++
    const ids = new Set(validateLesson(x.rec.arm, x.rec.rounds[0]!.text, contextFor(x.task)).diagnostics.map((d) => d.id))
    for (const id of ids) hist[x.rec.arm].set(id, (hist[x.rec.arm].get(id) ?? 0) + 1)
  }
  const allIds = [...new Set([...hist.markdoc.keys(), ...hist.directive.keys()])].sort()
  if (allIds.length) {
    L.push('| Diagnostic | Markdoc | Directive |', '|---|---|---|')
    for (const id of allIds) L.push(`| ${id} | ${pct((hist.markdoc.get(id) ?? 0) / (total.markdoc || 1))} | ${pct((hist.directive.get(id) ?? 0) / (total.directive || 1))} |`)
  } else L.push('No first-pass diagnostics.')
  L.push('')

  // ----- by shape
  L.push('## First-pass validity by lesson shape (all models)', '', '| Shape | Markdoc M1 | Directive M1 | n per arm |', '|---|---|---|---|')
  for (const shape of [...new Set(scored.map((x) => x.task.shape))].sort()) {
    const m = scored.filter((x) => x.task.shape === shape && x.rec.arm === 'markdoc')
    const d = scored.filter((x) => x.task.shape === shape && x.rec.arm === 'directive')
    L.push(`| ${shape} | ${pct(mean(m.map((x) => x.s.m1)))} | ${pct(mean(d.map((x) => x.s.m1)))} | ${m.length} / ${d.length} |`)
  }
  L.push('')

  // ----- decision
  L.push('## Go / no-go (lesson-ir.md §8.5)', '')
  const decision = decide(scored, { quality, iterationUsed: args.iterationUsed })
  if (!full) L.push('> Reduced or partial data: these unchanged gates show the observed sample and do not establish a go/no-go decision. K5 intervals are wider with one sample per task; absent Q1 or Q2 leaves K6 untested.', '')
  L.push(`**${full ? 'Verdict by the rules' : 'Descriptive rule output'}: ${decision.verdict.toUpperCase()}** (rule ${decision.rule}). ${decision.reason}.`, '')
  L.push('| Gate | Model | Format | Measured | Pass |', '|---|---|---|---|---|')
  const fmt = (c: { id: string; value: number | string }) => (typeof c.value === 'number' ? (c.id === 'K3' ? num(c.value) : c.id.startsWith('K5') ? pp(c.value) : c.id === 'K6a' ? num(c.value) : pct(c.value)) : c.value)
  const mark = (p: boolean | null) => (p === null ? 'n/a' : p ? 'pass' : 'FAIL')
  for (const g of Object.values(decision.gates)) for (const c of g.checks) L.push(`| ${c.id} ${c.label} | ${short(c.model!)} | ${ARM_NAME[c.arm!]} | ${fmt(c)} | ${mark(c.pass)} |`)
  for (const c of [...decision.relative, ...decision.quality]) L.push(`| ${c.id} ${c.label} | ${c.model ? short(c.model) : 'both'} | M vs D | ${fmt(c)} | ${mark(c.pass)} |`)
  L.push('', `Thresholds: K1 ${THRESHOLDS.K1_finalValid}, K2 ${THRESHOLDS.K2_firstPass}, K3 ${THRESHOLDS.K3_repairRounds}, K4 ${THRESHOLDS.K4_dropped}; primary models are Opus 5.5 and Sonnet 5.5; Haiku 5.5 is informational.`, '')

  // ----- measured tokens and re-quote
  L.push('## Measured tokens and the quote for the full run (§8.6)', '')
  const perGen = (m: Model) => {
    const rs = records.filter((r) => r.model === m && r.status === 'ok')
    if (!rs.length) return null
    const inp = mean(rs.map((r) => r.rounds.reduce((n, x) => n + x.usage.input + x.usage.cacheRead + x.usage.cacheWrite, 0)))
    const out = mean(rs.map((r) => r.rounds.reduce((n, x) => n + x.usage.output, 0)))
    const think = mean(rs.map((r) => r.rounds.reduce((n, x) => n + (x.usage.thinking ?? NaN), 0)))
    const repaired = mean(rs.map((r) => (r.rounds.length > 1 ? 1 : 0)))
    const cost = mean(rs.map((r) => r.costUSD))
    return { n: rs.length, inp, out, think, repaired, cost }
  }
  L.push('The $ / generation values below are actual OpenRouter-reported usage costs. Token metrics use OpenRouter usage; visible output token count is estimated locally because the OpenRouter chat endpoint has no count-only call.', '', '| Model | n | Input tokens / gen | Output tokens / gen | of which thinking | Needed repair | $ / generation | Prompt-cache read share |', '|---|---|---|---|---|---|---|---|')
  let quoteGen = 0
  for (const m of MODELS) {
    const g = perGen(m)
    if (!g) continue
    const rs = records.filter((r) => r.model === m && r.status === 'ok')
    const reads = rs.reduce((n, r) => n + r.rounds.reduce((k, x) => k + x.usage.cacheRead, 0), 0)
    const allIn = rs.reduce((n, r) => n + r.rounds.reduce((k, x) => k + x.usage.input + x.usage.cacheRead + x.usage.cacheWrite, 0), 0)
    L.push(`| ${short(m)} | ${g.n} | ${Math.round(g.inp)} | ${Math.round(g.out)} | ${Number.isNaN(g.think) ? 'n/a' : Math.round(g.think)} | ${pct(g.repaired)} | ${usd(g.cost)} | ${pct(reads / (allIn || 1))} |`)
    quoteGen += g.cost * 216 // 36 tasks x 2 arms x 3 samples per model
  }
  const judgeCost = judgments.length ? mean(judgments.map((j) => j.costUSD)) * 648 : (648 * (8000 * RESERVE_PRICES['claude-opus-5-5'].input + 800 * RESERVE_PRICES['claude-opus-5-5'].output)) / 1e6
  const sub = quoteGen + judgeCost
  L.push(
    '',
    `**Quote for the full run** (216 generations per model, scaled from the measured cost per generation${judgments.length ? ' and measured judge cost' : '; judge cost still the spec assumption'}):`,
    `generation ${usd(quoteGen)} + judge ${usd(judgeCost)} = ${usd(sub)}, plus 25% contingency = **${usd(sub * 1.25)}**. This is a planning estimate; live cost uses OpenRouter's usage.cost. The current new-spend approval is $19.00 and cannot fund this specified design.`,
    '',
    '_Estimate rests on this run\'s mix of tasks; a pilot with fewer tasks than the full set can mis-estimate by tens of percent._',
    '',
  )
  return L.join('\n')
}
