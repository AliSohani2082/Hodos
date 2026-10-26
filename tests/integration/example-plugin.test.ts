/**
 * Integration: the sample third-party plugin (examples/binary-numbers) as an
 * untrusted declarative plugin — loaded as data, its course validated with
 * item checks run in the QuickJS sandbox, its answers graded there, and a
 * journey through the engine with its lesson block and renderer.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { HodosEngine, HodosStore, loadDeclarativePlugin, PluginRegistry, SandboxRunner, validateCourse, type Actor } from '@hodos/core'
import type { ContentPack, ExerciseItem, GradeInput, JsonValue } from '@hodos/plugin-sdk'

const DIR = fileURLToPath(new URL('../../examples/binary-numbers', import.meta.url))
const pack: ContentPack = JSON.parse(readFileSync(join(DIR, 'content/binary-basics.json'), 'utf8'))
const course = pack.courses[0]
if (course === undefined) throw new Error('the example pack has no course')

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function registry(dir = DIR): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(await loadDeclarativePlugin(dir), { trusted: false, declarative: true })
  return r
}

const item = (id: string): ExerciseItem => {
  const found = course.items.find(i => i.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}
const input = (it: ExerciseItem, text: string): GradeInput => ({ kind: it.kind, payload: it.payload, key: it.key, response: { text }, mode: 'practice', skills: it.skills, attempt: 1 })
const withKey = (it: ExerciseItem, key: JsonValue): ExerciseItem => ({ ...it, key })

describe('example plugin: binary numbers (untrusted, declarative)', () => {
  it('registers as untrusted data with a sandboxed grader and renderer', async () => {
    const r = await registry()
    expect(r.graderInfo('binary.convert')).toEqual({ id: 'binary.grader', method: 'deterministic', trusted: false })
    expect(r.fallbackText('binary.convert', item('read-2').payload)).toBe('What is the binary number 1100 in decimal?')
  })

  it('validates its course with full coverage; item checks run in the sandbox', async () => {
    const r = await registry()
    expect((await validateCourse(course, r, { requireCoverage: true })).filter(f => f.severity === 'error')).toEqual([])
    expect((await r.validateItem(withKey(item('read-2'), { answer: '13' }))).map(d => d.code)).toEqual(['binary/key'])
    expect((await r.validateItem(withKey(item('write-1'), { answer: '0110' }))).map(d => d.code)).toEqual(['binary/key'])
    expect((await r.validateItem({ ...item('write-1'), payload: { prompt: 'Write 6 in binary: 110.', direction: 'to-binary', value: '6' } })).map(d => d.code)).toEqual(['binary/answer-in-prompt'])
    expect((await r.validateItem(withKey(item('read-2'), { answer: 'twelve' }))).map(d => d.code)).toEqual(['binary.convert/key'])
  })

  it('grades in the sandbox and names the mistake', async () => {
    const r = await registry()
    expect(await r.grade(input(item('read-2'), ' 12 '))).toMatchObject({ correct: true, score: 1 })
    expect((await r.grade(input(item('read-2'), '3'))).misconceptions).toEqual(['reversed-bits'])
    expect((await r.grade(input(item('read-2'), '1100'))).misconceptions).toEqual(['read-as-decimal'])
    expect((await r.grade(input(item('read-2'), '2'))).misconceptions).toEqual(['counted-ones'])
    expect(await r.grade(input(item('write-1'), '0b0110'))).toMatchObject({ correct: true })
    expect((await r.grade(input(item('write-1'), '011'))).misconceptions).toEqual(['reversed-bits'])
    expect((await r.grade(input(item('write-1'), '6'))).feedback).toBe('Use only the digits 0 and 1.')
    expect((await r.grade(input(item('read-2'), 'twelve'))).feedback).toBe('Type a whole number, like 12.')
  })

  it('runs a journey: lesson block through its renderer, practice with misconception feedback', async () => {
    const engine = new HodosEngine({ store: new HodosStore(':memory:'), registry: await registry() })
    expect(await engine.syncContentPacks()).toEqual([])
    const learnerId = engine.learnerForPrincipal('owner')
    const ui: Actor = { learnerId, channel: 'ui', sessionId: 's1' }
    const started = engine.startJourney({ ...ui, channel: 'agent' }, { goal: 'I want to learn binary numbers', skipDiagnostic: true })
    expect(started.course.id).toBe('binary-numbers')
    engine.approvePath(ui)
    const lesson = engine.lesson(ui)
    expect(Object.values(lesson.lessons[0]?.blocks ?? {})[0]).toMatchObject({ type: 'binary-bits', renderer: { pluginId: 'example-binary', rendererId: 'binary-bits' } })
    for (const l of lesson.lessons) for (const c of l.checks) engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    engine.completeLesson(ui)
    const exercise = engine.nextExercise(ui)
    expect(exercise?.renderer).toMatchObject({ pluginId: 'example-binary', rendererId: 'binary-bits' })
    const value = String((typeof exercise?.payload === 'object' && exercise.payload !== null && !Array.isArray(exercise.payload) ? exercise.payload : {}).value)
    const attempt = await engine.submitAttempt(ui, { presentationId: exercise?.id ?? '', response: { text: value } })
    expect(attempt.status).toBe('incorrect')
    expect(attempt.misconceptionFeedback).toEqual(['The 1s and 0s are bits, not a decimal number: add up the place values that hold a 1.'])
  })

  it('security: its grader sees no host objects, and a hostile one fails closed', async () => {
    const probe = mkdtempSync(join(tmpdir(), 'hodos-example-'))
    cpSync(DIR, probe, { recursive: true })
    writeFileSync(join(probe, 'grader.js'), `function grade(input) {
      var host = [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof Deno, typeof Bun].join(',')
      return { score: host === 'undefined,undefined,undefined,undefined,undefined,undefined' ? 1 : 0, correct: true, skillEvidence: [], misconceptions: [], feedback: host }
    }`)
    expect(await (await registry(probe)).grade(input(item('read-1'), '5'))).toMatchObject({ score: 1 })
    writeFileSync(join(probe, 'grader.js'), 'function grade(input) { while (true) {} }')
    await expect((await registry(probe)).grade(input(item('read-1'), '5'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    writeFileSync(join(probe, 'grader.js'), 'function grade(input) { return { score: 7, correct: true, skillEvidence: [{ skillId: "chess.mate", score: 1 }], misconceptions: [] } }')
    await expect((await registry(probe)).grade(input(item('read-1'), '5'))).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
