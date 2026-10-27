/**
 * Integration: the sample third-party plugin (examples/binary-numbers) as an
 * untrusted declarative plugin — loaded as data, its course validated with
 * item checks run in the QuickJS sandbox, its answers graded there, and its
 * course asked from as a question bank, with grader feedback that would give
 * the key away withheld.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadDeclarativePlugin, PluginRegistry, SandboxRunner, validateCourse } from '@hodos/core'
import type { ExerciseItem, GradeInput, JsonValue } from '@hodos/plugin-sdk'
import { bankSession } from '../support/bank-session.js'

const DIR = fileURLToPath(new URL('../../examples/binary-numbers', import.meta.url))

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function registry(dir = DIR): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(await loadDeclarativePlugin(dir), { trusted: false, declarative: true })
  return r
}

// The course as the host reads it: through the plugin's declared content pack.
const course = (await registry()).contentPacks()[0]?.pack.courses[0]
if (course === undefined) throw new Error('the example pack has no course')

const item = (id: string): ExerciseItem => {
  const found = course.items.find(i => i.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}
const input = (entry: ExerciseItem, text: string): GradeInput => ({ kind: entry.kind, payload: entry.payload, key: entry.key, response: { text }, mode: 'practice', skills: entry.skills, attempt: 1 })
const withKey = (entry: ExerciseItem, key: JsonValue): ExerciseItem => ({ ...entry, key })

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

  it('is a question bank: misconceptions explained, feedback that gives the key away withheld', async () => {
    const s = await bankSession(await registry())
    expect(s.entries('decimal').map(e => e.ref)).toContain('binary-numbers/read-2')
    const q = await s.ask('binary-numbers/read-2')
    expect(q.form).toMatchObject({ type: 'interface', kind: 'binary.convert', environment: 'binary.bits', answerField: { name: 'text', type: 'string' } })
    const misread = await s.answer(q.id, { text: '1100' })
    expect(misread.question.answer?.verdict).toMatchObject({
      outcome: 'incorrect', countsAsEvidence: true, misconceptions: ['read-as-decimal'],
      misconceptionFeedback: ['The 1s and 0s are bits, not a decimal number: add up the place values that hold a 1.'],
    })
    s.close()

    // A grader whose feedback quotes the key, on items without an explanation: the verdict reveals
    // nothing of the key, so it goes without the feedback (a bank item can be asked again).
    const leaky = mkdtempSync(join(tmpdir(), 'hodos-example-'))
    cpSync(DIR, leaky, { recursive: true })
    const packFile = join(leaky, 'content/binary-basics.json')
    const pack = JSON.parse(readFileSync(packFile, 'utf8')) as { courses: Array<{ items: Array<Record<string, unknown>> }> }
    for (const c of pack.courses) for (const i of c.items) delete i.explanation
    writeFileSync(packFile, JSON.stringify(pack))
    writeFileSync(join(leaky, 'grader.js'), `function grade(input) {
      return { score: 0, correct: false, skillEvidence: [], misconceptions: [], feedback: 'Not quite: it is ' + input.key.answer + '.' }
    }
    function validateItem(item) { return [] }`)
    const t = await bankSession(await registry(leaky))
    const write = await t.ask('binary-numbers/write-2')
    const graded = await t.answer(write.id, { text: '1111' })
    expect(graded.question.answer?.verdict).toMatchObject({ outcome: 'incorrect', score: 0 })
    expect(graded.question.answer?.verdict.feedback).toBeUndefined()
    expect(JSON.stringify(graded)).not.toContain('1001')
    t.close()
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
