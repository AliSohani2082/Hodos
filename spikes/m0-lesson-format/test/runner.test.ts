import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { CompleteRequest, CompleteResult, LlmClient } from '../src/llm.ts'
import { print } from '../src/print.ts'
import { extractLesson, keyOf, readRecords, runEval, type RunConfig } from '../src/runner.ts'
import { scoreGeneration, type GenRecord } from '../src/score.ts'
import { StubLlm, breakLesson } from '../src/stub.ts'
import { goldDoc } from '../src/synth.ts'
import { loadPack, TASKS, taskById } from '../src/tasks.ts'
import { ARMS, type Model } from '../src/types.ts'

const ROOT = new URL('../.scratch/test-runs/', import.meta.url).pathname
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
let n = 0
const fresh = () => {
  const dir = `${ROOT}run-${++n}`
  mkdirSync(dir, { recursive: true })
  return dir
}
const cfg = (over: Partial<RunConfig>): RunConfig => ({
  run: 't', dir: fresh(), tasks: ['math-s3', 'adv4'].map(taskById), models: ['claude-opus-5-5', 'claude-haiku-5-5'], arms: ARMS,
  samples: 1, capUSD: 1000, concurrency: 2, maxTokens: 20000, client: new StubLlm(0), log: () => {}, ...over,
})

describe('gold lessons score perfectly', () => {
  for (const t of TASKS)
    for (const arm of ARMS)
      test(`${t.id}/${arm}`, () => {
        const text = print(arm, goldDoc(t, loadPack(t.pack)))
        const rec = { key: 'k', run: 'r', model: 'claude-opus-5-5', arm, taskId: t.id, sample: 1, status: 'ok', costUSD: 0, rounds: [{ kind: 'generate', text, stopReason: 'end_turn', usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, costUSD: 0, ms: 1 }] } as GenRecord
        const s = scoreGeneration(rec, t)
        expect(s).toMatchObject({ m1: 1, m2: 1, m3: 0, m4: 0, m4silent: 0, m5first: 1, m6first: 0, checklist: 1, literals: 1, nesting: 1 })
      })
})

describe('silent drops (M4)', () => {
  const rec = (arm: 'markdoc' | 'directive', taskId: string, text: string) =>
    ({ key: 'k', run: 'r', model: 'claude-opus-5-5', arm, taskId, sample: 1, status: 'ok', costUSD: 0, rounds: [{ kind: 'generate', text, stopReason: 'end_turn', usage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, costUSD: 0, ms: 1 }] }) as GenRecord
  const indentExercise = (arm: 'markdoc' | 'directive') => {
    const t = taskById('math-s3')
    const good = print(arm, goldDoc(t, loadPack(t.pack)))
    const i = good.search(arm === 'markdoc' ? /\{% exercise/ : /:::exercise/)
    return { t, text: good.slice(0, i).trimEnd() + '\n\n' + good.slice(i).split('\n').map((l) => '    ' + l).join('\n') }
  }

  test('directive: an exercise indented four spaces becomes a code block, and nothing reports it', () => {
    const { t, text } = indentExercise('directive')
    const s = scoreGeneration(rec('directive', t.id, text), t)
    expect(s.m4silent).toBe(1)
    expect(s.m4).toBe(1)
    expect(s.m1).toBe(1) // the validator is blind to it: that is what M4 measures
    expect(s.checklist).toBeLessThan(1)
  })
  test('markdoc: the same indentation still parses as a tag, so nothing is dropped', () => {
    const { t, text } = indentExercise('markdoc')
    const s = scoreGeneration(rec('markdoc', t.id, text), t)
    expect(s.m4silent).toBe(0)
    expect(s.checklist).toBe(1)
  })
  test('a reported failure is not counted as a silent drop', () => {
    const t = taskById('math-s3')
    const good = print('markdoc', goldDoc(t, loadPack(t.pack)))
    const broken = breakLesson('markdoc', good, 0) // removes a closing tag: reported as unclosed
    expect(scoreGeneration(rec('markdoc', t.id, broken), t).m1).toBe(0)
    expect(scoreGeneration(rec('markdoc', t.id, broken), t).m4).toBe(0)
  })
})

describe('runner', () => {
  test('repairs: defective first attempts are fixed in one round and recorded per round', async () => {
    const c = cfg({ client: new StubLlm(1) }) // every first attempt is broken
    await runEval(c)
    const recs = readRecords(c.dir)
    expect(recs.length).toBe(2 * 2 * 2)
    expect(recs.every((r) => r.status === 'ok' && r.rounds.length === 2)).toBe(true)
    expect(recs.every((r) => r.rounds[0]!.kind === 'generate' && r.rounds[1]!.kind === 'repair')).toBe(true)
  })

  test('resume skips finished generations and does not pay twice', async () => {
    const c = cfg({})
    const first = await runEval(c)
    const again = await runEval(c)
    expect(first.ran).toBe(8)
    expect(again.ran).toBe(0)
    expect(again.skipped).toBe(8)
    expect(readRecords(c.dir).length).toBe(8)
  })

  test('the cap is never exceeded, even with concurrent calls, and what ran is balanced across arms', async () => {
    const expensive: LlmClient = {
      async complete(req: CompleteRequest): Promise<CompleteResult> {
        const inner = await new StubLlm(0).complete(req)
        return { ...inner, usage: { input: 8000, output: 6000, cacheWrite: 0, cacheRead: 0 } } // ~$0.15 on Opus
      },
    }
    const c = cfg({ client: expensive, tasks: TASKS.slice(0, 6), models: ['claude-opus-5-5' as Model], capUSD: 1.2, concurrency: 3 })
    const res = await runEval(c)
    const recs = readRecords(c.dir)
    const spent = recs.reduce((s, r) => s + r.costUSD, 0)
    expect(spent).toBeLessThanOrEqual(1.2)
    expect(res.budgetStopped).toBeGreaterThan(0)
    expect(recs.filter((r) => r.status === 'ok').length).toBeGreaterThan(0)
    // groups run (task, model, arm) in order, so every started task has both arms or is the last in flight
    const byTask = new Map<string, Set<string>>()
    for (const r of recs.filter((r) => r.status === 'ok')) byTask.set(r.taskId, (byTask.get(r.taskId) ?? new Set()).add(r.arm))
    const lopsided = [...byTask.values()].filter((s) => s.size < 2).length
    expect(lopsided).toBeLessThanOrEqual(3) // at most the calls that were in flight when the cap closed
  })

  test('the cap is cumulative for the run directory across restarts', async () => {
    const c = cfg({ capUSD: 1000 })
    await runEval(c)
    const spent = readRecords(c.dir).reduce((s, r) => s + r.costUSD, 0)
    const tight = { ...c, capUSD: spent + 0.0001, samples: 2 } // a second sample would need more than the remaining cap
    const res = await runEval(tight)
    expect(res.budgetStopped).toBeGreaterThan(0)
    expect(readRecords(c.dir).reduce((s, r) => s + r.costUSD, 0)).toBeLessThanOrEqual(spent + 0.0001)
  })

  test('an API error is recorded, charged nothing, and retried on the next run', async () => {
    let calls = 0
    const flaky: LlmClient = {
      async complete(req) {
        if (++calls <= 2) throw new Error('overloaded')
        return new StubLlm(0).complete(req)
      },
    }
    const c = cfg({ client: flaky, tasks: [taskById('math-s3')], models: ['claude-opus-5-5'], concurrency: 1 })
    const first = await runEval(c)
    expect(first.errors).toBe(2)
    expect(readRecords(c.dir).filter((r) => r.status === 'ok').length).toBe(0)
    const second = await runEval({ ...c, client: new StubLlm(0) })
    expect(second.ran).toBe(2)
  })
})

describe('extractLesson', () => {
  test('unwraps a single outer fence around a file with frontmatter', () => {
    expect(extractLesson('```markdown\n---\nlesson: x\n---\n\n# Hi\n```')).toBe('---\nlesson: x\n---\n\n# Hi\n')
  })
  test('leaves a code fence inside the lesson alone', () => {
    const t = '---\nlesson: x\n---\n\n```js\nlet a = 1\n```'
    expect(extractLesson(t)).toBe(t + '\n')
  })
  test('keys are stable', () => expect(keyOf('claude-opus-5-5', 'markdoc', 'math-s3', 2)).toBe('claude-opus-5-5|markdoc|math-s3|2'))
})
