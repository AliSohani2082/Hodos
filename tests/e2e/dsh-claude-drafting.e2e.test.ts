/**
 * Course drafting through DeepSeek Harness's own Claude Code subagent
 * (`@deepseek-ai/dsh-subagent-claude-code`): the tutor calls
 * hodos_draft_course, DSH runs the unmodified Claude Code binary through the
 * Agent SDK, and Hodos validates its answer into a draft the learner approves.
 *
 * No Claude account or real key is involved: Claude Code gets a dummy API key
 * and a local mock in place of Anthropic's API through the provider's `env`
 * setting, and runs with a throwaway HOME, so no sign-in on this machine is
 * visible to it. Opt-in, because it installs the bundle from the npm registry:
 * set HODOS_E2E_CLAUDE_CODE=1 (and HODOS_DSH_BIN).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { tacticsCourse } from '@hodos/chess'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosApp, openHodosTab, say } from './support/ui.js'

const ENABLED = DSH_AVAILABLE && process.env.HODOS_E2E_CLAUDE_CODE === '1'
const BUNDLE = '@deepseek-ai/dsh-subagent-claude-code@0.2.1-rc.3'
const TEST_KEY = 'hodos-e2e-dummy-key'

// What "Claude" answers: a course in a fenced JSON block, as the drafting prompt asks.
const drafted = { ...tacticsCourse(), id: 'chess.endgame-draft', version: '0.1.0', title: 'Chess endgame basics (draft)' }

let tutor: MockLlm | undefined
let claude: MockLlm | undefined
let dsh: DshProcess | undefined
let browser: Browser | undefined
let page: Page | undefined

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

describe.skipIf(!ENABLED)('course drafting through DSH\'s Claude Code subagent', () => {
  beforeAll(async () => {
    tutor = await startMockLlm(tutorScript({ environment: 'chess' }))
    claude = await startMockLlm(() => ({ text: `Here is the course.\n\`\`\`json\n${JSON.stringify(drafted)}\n\`\`\`` }))
    const home = prepareHome(['packages/dsh-adapter', 'packages/environments/chess', BUNDLE])
    // A patch replaces a row's whole config: restate dataDir for Hodos.
    const patch = home.patch('claude-drafting.yml', `- id: hodos
  config:
    dataDir: !!js dshHomePath('hodos')
    delegateProvider: claude-code
- id: subagent-claude-code
  config:
    env:
      ANTHROPIC_API_KEY: ${TEST_KEY}
      ANTHROPIC_BASE_URL: ${the(claude, 'claude mock').url}
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
      DISABLE_AUTOUPDATER: '1'
`)
    dsh = await startDsh(home, the(tutor, 'tutor mock').url, [patch])
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  }, 900_000)

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await tutor?.close()
    await claude?.close()
  })

  it('drafts a course with Claude Code and keeps it for the learner to approve', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'Please draft a course about chess endgame basics')
    const tool = (): { text: string; isError: boolean } | undefined => the(tutor, 'tutor').requests.flatMap(r => r.toolResults).find(t => t.name === 'hodos_draft_course')
    await expect.poll(() => tool() !== undefined, { timeout: 300_000, interval: 2_000 }).toBe(true)
    expect(tool()?.isError).toBe(false)
    expect(tool()?.text).toContain('Draft chess.endgame-draft@0.1.0 is ready for the learner to review')

    // Claude Code talked to the stand-in API with the dummy key only.
    const calls = the(claude, 'claude').requests
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.auth).toEqual({ apiKey: TEST_KEY, bearer: false })
    expect(calls.some(c => c.userTexts.some(t => t.includes('# Hodos course authoring guide')))).toBe(true)

    // The draft waits in the workspace for the learner.
    const session = await openHodosTab(p)
    const response = await p.request.get(`${the(dsh, 'dsh').origin}/hodos/api/v1/drafts?session=${encodeURIComponent(session)}`)
    const drafts: { data: Array<{ id: string; origin: string }> } = await response.json()
    expect(drafts.data).toEqual([expect.objectContaining({ id: 'chess.endgame-draft', origin: 'agent' })])
    await expect.poll(() => hodosApp(p).locator('section.drafts h3').first().textContent(), { timeout: 20_000 }).toContain('Chess endgame basics (draft)')
  })
})
