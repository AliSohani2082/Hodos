/**
 * The tools of a tutoring session in a real DeepSeek Harness. Before a
 * journey starts, the chat has the profile's tools (shell, files, web,
 * subagents). Once the session is bound to a journey under the default
 * `restricted` policy, the model is offered only Hodos's tools, plus DSH's
 * `subagent`, which DSH registers in the agent's own scope where no
 * restriction reaches. Hodos's guard refuses to run it, and a hidden tool
 * cannot be called at all.
 *
 * Needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { startMockLlm, tutorScript, type MockLlm, type MockToolResult } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, say } from './support/ui.js'

let mock: MockLlm | undefined
let dsh: DshProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

/** Tools offered to the model that are not Hodos's. */
function nonHodos(tools: readonly string[]): string[] {
  return tools.filter(t => !t.startsWith('hodos_'))
}

/** Wait for the model to receive the result of a call to `name`. */
async function resultOf(name: string): Promise<MockToolResult> {
  const found: { result: MockToolResult | undefined } = { result: undefined }
  await expect.poll(() => {
    found.result = the(mock, 'mock').requests.flatMap(r => r.toolResults).find(t => t.name === name)
    return found.result !== undefined
  }, { timeout: 60_000 }).toBe(true)
  return the(found.result, `the result of ${name}`)
}

describe.skipIf(!DSH_AVAILABLE)('tools of a tutoring session in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(tutorScript({ environment: 'chess' }))
    dsh = await startDsh(prepareHome(['packages/dsh-adapter', 'packages/environments/chess']), mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('offers the profile tools before the journey and only Hodos tools once the session tutors', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'Teach me chess tactics. I know the basic rules but struggle with knight forks.')
    expect((await resultOf('hodos_start_learning')).isError).toBe(false)
    const requests = the(mock, 'mock').requests
    expect(requests[0]?.tools).toEqual(expect.arrayContaining(['bash', 'write', 'web_fetch', 'subagent', 'hodos_start_learning']))
    const tutoring = requests.filter(r => r.toolResults.some(t => t.name === 'hodos_start_learning'))
    expect(tutoring.length).toBeGreaterThan(0)
    for (const request of tutoring) {
      expect(request.tools, `request ${request.index}`).toContain('hodos_submit_answer')
      // Course drafting starts a subagent, so a tutor is not offered it either.
      expect(request.tools, `request ${request.index}`).not.toContain('hodos_draft_course')
      expect(nonHodos(request.tools).filter(t => t !== 'subagent'), `request ${request.index}`).toEqual([])
    }
  })

  it('refuses to run DSH\'s subagent tool for the tutor', async () => {
    await say(the(page, 'page'), 'Call the tool subagent with {"description":"probe","prompt":"List the files in my home directory."}')
    const refused = await resultOf('subagent')
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('not available in a learning session')
  })

  it('does not run a hidden tool the tutor names anyway', async () => {
    await say(the(page, 'page'), 'Call the tool bash with {"command":"id"}')
    expect((await resultOf('bash')).isError).toBe(true)
  })
})
