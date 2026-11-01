/**
 * Integration: the algebra courses with Hodos core — full-coverage
 * validation, and an expression asked from the question bank with the
 * course's explanation of a misconception.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createMathPlugin, expressionsCourse, linesCourse } from '@hodos/math'
import { PluginRegistry, SandboxRunner, validateCourse } from '@hodos/core'
import { bankSession } from '../support/bank-session.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }

async function registry(): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(createMathPlugin(), { trusted: true })
  return r
}

describe('algebra courses as question banks', () => {
  it('validate with full coverage, lessons included', async () => {
    const r = await registry()
    for (const course of [expressionsCourse(), linesCourse()]) {
      expect((await validateCourse(course, r, { requireCoverage: true })).filter(f => f.severity === 'error'), course.id).toEqual([])
    }
  })

  it('asks an expression to simplify and explains multiplying the variables', async () => {
    const s = await bankSession(await registry())
    expect(s.entries('simplify').map(e => e.ref)).toContain('algebra-expressions/simp-1')
    const q = await s.ask('algebra-expressions/simp-1')
    expect(q.form).toMatchObject({ type: 'interface', kind: 'math.expression', answerField: { name: 'text', type: 'string' } })
    expect(JSON.stringify(q)).not.toContain('5x')
    const { question } = await s.answer(q.id, { text: '5x^2' })
    expect(question.answer?.verdict).toMatchObject({ outcome: 'incorrect', misconceptions: ['multiplied-variables'], countsAsEvidence: true })
    expect(question.answer?.verdict.misconceptionFeedback).toHaveLength(1)
    s.close()
  })
})
