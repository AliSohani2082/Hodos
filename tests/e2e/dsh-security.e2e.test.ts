/**
 * Security boundaries in a real DeepSeek Harness.
 *
 * - Tools: before a learning session starts, the chat has the profile's tools
 *   (shell, files, web, subagents). Once the chat is bound to a session under
 *   the default `restricted` policy, the model is offered only Hodos's tools
 *   and DSH's own question tool, plus DSH's `subagent`, which DSH registers in
 *   the agent's own scope where no restriction reaches. Hodos's guard refuses
 *   to run it, and a hidden tool cannot be called at all.
 * - Answer keys: an exercise's key stays on the server while it is open, and a
 *   question whose text gives the key away is refused without quoting it.
 * - Routes: the Hodos API and workspace answer only requests that carry
 *   DeepSeek Harness's sign-in.
 *
 * Needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { learningScript, startMockLlm, type MockLlm, type MockToolResult } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosState, openHodosTab, say, waitForQuestion } from './support/ui.js'

const FORK_PAYLOAD = { fen: '6k1/3q1p1p/8/8/4N3/8/5PPP/6K1 w - - 0 1', orientation: 'white', prompt: 'White to move and win material.', goal: 'best', plies: 2 }
const FORK_KEY = { line: ['Nf6+', 'Kf8', 'Nxd7'], theme: 'fork' }

let mock: MockLlm | undefined
let dsh: DshProcess | undefined
let browser: Browser | undefined
let page: Page | undefined
let session = ''
let probeId = ''

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

/** Tools offered to the model that are neither Hodos's nor DSH's question tool. */
function nonHodos(tools: readonly string[]): string[] {
  return tools.filter(t => !t.startsWith('hodos_') && t !== 'ask_user_question')
}

/** Wait for the model to receive a new result of a call to `name`. */
async function resultOf(name: string, after = 0): Promise<MockToolResult> {
  const found: { result: MockToolResult | undefined } = { result: undefined }
  await expect.poll(() => {
    found.result = the(mock, 'mock').requests.slice(after).flatMap(r => r.toolResults).find(t => t.name === name)
    return found.result !== undefined
  }, { timeout: 60_000 }).toBe(true)
  return the(found.result, `the result of ${name}`)
}

describe.skipIf(!DSH_AVAILABLE)('security boundaries in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(learningScript({
      probe: { question: 'How does a knight move?', options: ['In an L', 'Diagonally', 'One square'], correct: 'In an L' },
      assessment: { strands: [{ strand: 'tactics', assessment: 'Has not met forks.' }] },
      plan: 'graph TD\n  fork[The knight fork]',
      steps: [],
    }))
    dsh = await startDsh(prepareHome(['packages/dsh-adapter', 'packages/environments/chess']), mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('offers the profile tools before the session and only Hodos tools once the chat is tutored', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'Teach me chess tactics. I know the basic rules but struggle with knight forks.')
    expect((await resultOf('hodos_start_learning')).isError).toBe(false)
    session = await openHodosTab(p)
    probeId = (await waitForQuestion(() => hodosState(p, the(dsh, 'dsh').origin, session))).id
    const requests = the(mock, 'mock').requests
    expect(requests[0]?.tools).toEqual(expect.arrayContaining(['bash', 'write', 'web_fetch', 'subagent', 'hodos_start_learning']))
    const start = requests.findIndex(r => r.toolResults.some(t => t.name === 'hodos_start_learning'))
    const tutoring = requests.slice(start)
    expect(tutoring.length).toBeGreaterThan(0)
    for (const request of tutoring) {
      expect(request.tools, `request ${request.index}`).toContain('hodos_probe')
      // Course drafting starts a subagent, so a tutor is not offered it either.
      expect(request.tools, `request ${request.index}`).not.toContain('hodos_draft_course')
      expect(nonHodos(request.tools).filter(t => t !== 'subagent'), `request ${request.index}`).toEqual([])
    }
  })

  it('refuses to run DSH\'s subagent tool for the tutor', async () => {
    const after = the(mock, 'mock').requests.length
    await say(the(page, 'page'), 'Call the tool subagent with {"description":"probe","prompt":"List the files in my home directory."}')
    const refused = await resultOf('subagent', after)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('not available in a Hodos session')
  })

  it('does not run a hidden tool the tutor names anyway', async () => {
    const after = the(mock, 'mock').requests.length
    await say(the(page, 'page'), 'Call the tool bash with {"command":"id"}')
    expect((await resultOf('bash', after)).isError).toBe(true)
  })

  it('keeps an exercise\'s key on the server, and refuses a question that gives it away without quoting it', async () => {
    const p = the(page, 'page')
    const origin = the(dsh, 'dsh').origin
    const after = the(mock, 'mock').requests.length
    const leaky = { question: 'Play Nf6+ and then take the queen.', kind: 'chess.puzzle', payload: FORK_PAYLOAD, key: FORK_KEY }
    await say(p, `Call the tool hodos_probe_exercise with ${JSON.stringify(leaky)}`)
    const refused = await resultOf('hodos_probe_exercise', after)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('gives away the answer')
    expect(refused.text).not.toContain('Nxd7')

    // A question that is asked ends the tutor's turn: it shows in the panel, and the call's result reaches the model with the answer.
    const fair = { question: 'Find the best move.', kind: 'chess.puzzle', payload: FORK_PAYLOAD, key: FORK_KEY }
    await say(p, `Call the tool hodos_probe_exercise with ${JSON.stringify(fair)}`)
    const open = await waitForQuestion(() => hodosState(p, origin, session), new Set([probeId]))
    expect(open.form).toMatchObject({ type: 'interface', kind: 'chess.puzzle' })
    const shown = JSON.stringify(await hodosState(p, origin, session))
    for (const secret of ['Nf6+', 'Nxd7', 'Kf8']) expect(shown).not.toContain(secret)
  })

  it('answers the API and the workspace only with DeepSeek Harness\'s sign-in', async () => {
    const origin = the(dsh, 'dsh').origin
    for (const path of [`/hodos/api/v1/state?session=${encodeURIComponent(session)}`, '/hodos/app/']) {
      // No cookie: what another local program or a page on another site would send.
      expect((await fetch(`${origin}${path}`)).status, path).toBe(401)
      // The signed-in browser gets through.
      expect((await the(page, 'page').request.get(`${origin}${path}`)).status(), path).toBe(200)
    }
  })
})
