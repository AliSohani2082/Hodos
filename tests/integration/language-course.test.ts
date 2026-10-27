/**
 * Integration: the Spanish basics course with Hodos core — validation with
 * full coverage, a typed answer with a missing accent graded as partly right
 * with the course's explanation, and the mastery layer's review schedule.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createLanguagePlugin, KIND, spanishCourse } from '@hodos/language'
import { PluginRegistry, SandboxRunner, validateCourse } from '@hodos/core'
import type { JsonObject } from '@hodos/plugin-sdk'
import { bankSession } from '../support/bank-session.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
const course = spanishCourse()

async function registry(): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(createLanguagePlugin(), { trusted: true })
  return r
}

/** A typed-answer item whose first accepted answer carries an accent. */
function accented(): { id: string; answer: string } {
  for (const item of course.items) {
    if (item.kind === KIND.choice) continue
    const accepted = (item.key as JsonObject).accepted
    const answer = Array.isArray(accepted) ? accepted[0] : undefined
    if (typeof answer === 'string' && /[áéíóú]/u.test(answer)) return { id: item.id, answer }
  }
  throw new Error('the course has no accented typed answer')
}

describe('Spanish basics as a question bank', () => {
  it('validates with full coverage', async () => {
    const findings = await validateCourse(course, await registry(), { requireCoverage: true })
    expect(findings.filter(f => f.severity === 'error')).toEqual([])
  })

  it('grades a missing accent as partly right, then a correct answer as evidence with a review scheduled', async () => {
    const s = await bankSession(await registry())
    const { id, answer } = accented()
    const first = await s.ask(`${course.id}/${id}`)
    expect(JSON.stringify(first)).not.toContain(answer)
    const { question } = await s.answer(first.id, { text: answer.normalize('NFD').replace(/́/gu, '') })
    expect(question.answer?.verdict).toMatchObject({ outcome: 'partial' })
    expect(question.answer?.verdict.misconceptionFeedback?.[0]).toContain('accents')

    const again = await s.ask(`${course.id}/${id}`)
    expect((await s.answer(again.id, { text: answer })).question.answer?.verdict).toMatchObject({ outcome: 'correct', countsAsEvidence: true })
    const [mastery] = s.learn.view(s.learner, s.sessionId).mastery
    expect(mastery).toMatchObject({ nodeId: 'topic', observations: 2 })
    expect(mastery?.dueAt).not.toBeNull()
    s.close()
  })
})
