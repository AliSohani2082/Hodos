// Q2: human blind check (§8.5). 30 same-task pairs, arm hidden, drawn at random. A human fills in answers.json;
// `q2 score` turns it into a preference for Arm M and the judge-vs-human agreement.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readJudgments } from './judge.ts'
import { renderPlain } from './render.ts'
import type { GenRecord } from './score.ts'
import { contextFor, taskById } from './tasks.ts'
import { validateLesson } from './validate.ts'
import type { Model } from './types.ts'

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface PairKey {
  pair: number
  task: string
  A: string // record key shown as A
  B: string
  armA: string
  armB: string
}

export function exportPairs(o: { dir: string; records: GenRecord[]; n: number; seed: number; model: Model }) {
  const r = rng(o.seed)
  const byTask = new Map<string, { markdoc?: GenRecord; directive?: GenRecord }>()
  for (const rec of o.records) {
    if (rec.status !== 'ok' || rec.model !== o.model || rec.sample !== 1 || !rec.rounds.length) continue
    byTask.set(rec.taskId, { ...byTask.get(rec.taskId), [rec.arm]: rec })
  }
  const both = [...byTask.entries()].filter(([, v]) => v.markdoc && v.directive)
  for (let i = both.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[both[i], both[j]] = [both[j]!, both[i]!]
  }
  const chosen = both.slice(0, o.n)
  const keys: PairKey[] = []
  const md: string[] = ['# Blind comparison', '', 'For each pair, decide which lesson is better for the stated task: A, B, or tie. Judge content only. Record answers in `q2-answers.json` as {"1": "A", "2": "tie", ...}.', '']
  chosen.forEach(([taskId, v], idx) => {
    const flip = r() < 0.5
    const [a, b] = flip ? [v.directive!, v.markdoc!] : [v.markdoc!, v.directive!]
    const task = taskById(taskId)
    const show = (rec: GenRecord) => renderPlain(validateLesson(rec.arm, rec.rounds[rec.rounds.length - 1]!.text, contextFor(task)).doc)
    keys.push({ pair: idx + 1, task: taskId, A: a.key, B: b.key, armA: a.arm, armB: b.arm })
    md.push(`## Pair ${idx + 1}: ${task.concept} (${task.level})`, '', '### Lesson A', '', show(a), '', '### Lesson B', '', show(b), '', '---', '')
  })
  writeFileSync(`${o.dir}/q2-pairs.md`, md.join('\n'))
  writeFileSync(`${o.dir}/q2-key.json`, JSON.stringify(keys, null, 1))
  console.log(`wrote ${keys.length} pairs to ${o.dir}/q2-pairs.md (key in q2-key.json: keep it away from the reviewer)`)
}

export function scorePairs(o: { dir: string; records: GenRecord[] }) {
  const keyFile = `${o.dir}/q2-key.json`
  const ansFile = `${o.dir}/q2-answers.json`
  if (!existsSync(keyFile) || !existsSync(ansFile)) throw new Error(`need ${keyFile} and ${ansFile}`)
  const keys: PairKey[] = JSON.parse(readFileSync(keyFile, 'utf8'))
  const ans: Record<string, string> = JSON.parse(readFileSync(ansFile, 'utf8'))
  const judged = new Map(readJudgments(o.dir).map((j) => [j.key, j.q1]))
  let m = 0, d = 0, tie = 0, agree = 0, comparable = 0
  for (const k of keys) {
    const a = ans[String(k.pair)]
    if (!a) continue
    const winnerArm = a === 'A' ? k.armA : a === 'B' ? k.armB : null
    if (winnerArm === 'markdoc') m++
    else if (winnerArm === 'directive') d++
    else tie++
    const qa = judged.get(k.A), qb = judged.get(k.B)
    if (winnerArm && qa !== undefined && qb !== undefined && qa !== qb) {
      comparable++
      if ((qa > qb) === (a === 'A')) agree++
    }
  }
  const prefM = m + d ? m / (m + d) : NaN
  const out = { markdoc: m, directive: d, ties: tie, prefM, judgeHumanAgreement: comparable ? agree / comparable : NaN, comparable }
  writeFileSync(`${o.dir}/q2-score.json`, JSON.stringify(out, null, 1))
  return out
}
