/**
 * Integration: the Python tracing course with Hodos core — full-coverage
 * validation, its exercises asked from the question bank with the course's
 * explanation of a misreading released through the leak guard, and
 * code-writing exercises appearing only with a runner.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createCodePlugin, KIND, SKILL, tracingCourse, type CodeRunner } from '@hodos/code'
import { PluginRegistry, SandboxRunner, validateCourse } from '@hodos/core'
import { bankSession } from '../support/bank-session.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function registry(runner?: CodeRunner): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(createCodePlugin(runner === undefined ? {} : { runner }), { trusted: true })
  return r
}

describe('Python tracing course as a question bank', () => {
  it('validates with full coverage, lessons included', async () => {
    expect((await validateCourse(tracingCourse(), await registry(), { requireCoverage: true })).filter(f => f.severity === 'error')).toEqual([])
  })

  it('asks a program to trace and explains an integer-division misreading', async () => {
    const s = await bankSession(await registry())
    const item = tracingCourse().items.find(i => i.id === 'ex-1')
    const q = await s.ask('python-tracing/ex-1')
    expect(q.form).toMatchObject({ type: 'interface', kind: KIND.predict, responseKind: 'lines', environment: 'code.listing' })
    expect(q.form.type === 'interface' ? q.form.text : '').toContain('1 | print(')
    expect(JSON.stringify(q)).not.toContain(item?.explanation ?? '<none>')
    const { question, report } = await s.answer(q.id, { text: '3\n3\n1' })
    expect(question.answer?.verdict).toMatchObject({ outcome: 'incorrect', misconceptions: ['true-division'], countsAsEvidence: true })
    expect(question.answer?.verdict.misconceptionFeedback).toHaveLength(1)
    expect(report).toContain('Explanation shown to the learner:')
    s.close()
  })

  it('offers code-writing exercises only when the host supplies a runner', async () => {
    expect((await registry()).graderInfo(KIND.write)).toBeUndefined()
    const runner: CodeRunner = { isolation: 'test table (executes nothing)', languages: ['python'], run: r => Promise.resolve(r.inputs.map(() => ({ status: 'ok' as const, stdout: '6\n', stderr: '' }))) }
    const withRunner = await registry(runner)
    expect(withRunner.graderInfo(KIND.write)).toEqual({ id: 'code.runner-grader', method: 'oracle', trusted: true })
    const grade = await withRunner.grade({
      kind: KIND.write, mode: 'practice', attempt: 1, skills: [{ skillId: SKILL.functions, weight: 1 }],
      payload: { prompt: 'Print 6.', language: 'python' }, key: { tests: [{ input: '', output: '6' }] }, response: { code: 'print(6)' },
    })
    expect(grade).toMatchObject({ correct: true, score: 1 })
  })
})
