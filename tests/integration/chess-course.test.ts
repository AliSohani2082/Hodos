/**
 * Integration: the chess environment with Hodos core — its course validates
 * with full coverage, becomes a question bank of verified positions, and a
 * knight fork asked from it is played out move by move on the server.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createChessPlugin, tacticsCourse } from '@hodos/chess'
import { PluginRegistry, SandboxRunner, validateCourse } from '@hodos/core'
import { bankSession } from '../support/bank-session.js'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => {}, warn: () => {}, error: () => {} }
const course = tacticsCourse()

async function registry(): Promise<PluginRegistry> {
  const r = new PluginRegistry({ sandbox, logger: silent })
  await r.register(createChessPlugin(), { trusted: true })
  return r
}

describe('chess course as a question bank', () => {
  it('validates with full coverage', async () => {
    const findings = await validateCourse(course, await registry(), { requireCoverage: true })
    expect(findings.filter(f => f.severity === 'error')).toEqual([])
  })

  it('lists verified positions for the tutor, never their solutions', async () => {
    const s = await bankSession(await registry())
    const forks = s.entries('fork knight')
    expect(forks.length).toBeGreaterThan(3)
    expect(forks[0]).toMatchObject({ kind: 'chess.puzzle', course: course.title })
    expect(forks[0]?.verifiedBy).toContain('chess.js')
    expect(JSON.stringify(s.entries())).not.toMatch(/Nc7\+|Nxa8|"line"/)
    s.close()
  })

  it('plays a knight fork out on the server: the reply comes back, the line is graded as evidence', async () => {
    const s = await bankSession(await registry())
    const q = await s.ask('chess-tactics/fork-royal-a8')
    expect(q.form).toMatchObject({ type: 'interface', kind: 'chess.puzzle', interaction: 'stepwise' })
    expect(JSON.stringify(q)).not.toMatch(/Nc7\+|Nxa8/)
    const first = await s.learn.answer(s.learner, q.id, { response: { move: 'Nc7+' } })
    expect(first.status).toBe('continue')
    expect(JSON.stringify(first.question.progress)).toContain('Kd7')
    const done = await s.learn.answer(s.learner, q.id, { response: { move: 'Nxa8' } })
    if (done.status !== 'answered') throw new Error('expected the line to finish')
    expect(done.question.answer?.verdict).toMatchObject({ outcome: 'correct', score: 1, countsAsEvidence: true })
    expect(done.question.answer?.reveal.solution).toBeDefined()
    expect(s.learn.view(s.learner, s.sessionId).mastery).toEqual([expect.objectContaining({ nodeId: 'topic', observations: 1 })])
    s.close()
  })
})
