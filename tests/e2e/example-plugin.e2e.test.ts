/**
 * The sample third-party plugin (examples/binary-numbers) in a browser and in
 * a real DeepSeek Harness. Its renderer is plain JavaScript speaking the
 * renderer protocol by hand, served under the renderer CSP into a sandboxed
 * iframe. In the Harness the plugin is loaded from the `pluginDirs` setting as
 * untrusted data: its course becomes a question bank the tutor asks from, its
 * renderer draws the question (it may not answer for the learner, so the
 * panel takes the typed answer), and its grader runs in the QuickJS sandbox.
 *
 * The Harness part needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import { learningScript, startMockLlm, type MockLlm, type MockToolResult } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { openRenderer, post, received, startRendererHost, type RendererHost } from './support/renderer-host.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, waitForQuestion, type HodosState } from './support/ui.js'

const PLUGIN = fileURLToPath(new URL('../../examples/binary-numbers', import.meta.url))

let browser: Browser | undefined

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
})

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

/** A `hodos:present` message for a conversion exercise with this payload. */
function presentMessage(payload: object): object {
  return {
    type: 'hodos:present',
    exercise: { id: 'p1', itemId: 'read-2', kind: 'binary.convert', environment: 'binary.bits', skills: [{ skillId: 'binary.read', weight: 1 }], difficulty: 0, mode: 'practice', hintsAvailable: 1, attempt: 1, payload },
  }
}

describe('example renderer (plain JavaScript, sandboxed iframe, renderer CSP)', () => {
  let host: RendererHost | undefined
  beforeAll(async () => {
    host = await startRendererHost(`${PLUGIN}/renderer`, '/hodos/env/example-binary/binary-bits/', 'bits.js')
  })
  afterAll(async () => {
    await host?.close()
  })

  it('shows place-value boxes for exercises and lesson blocks, ignoring malformed messages', async () => {
    const { page, frame, errors } = await openRenderer(the(browser, 'browser'), the(host, 'host'), 'binary.bits')
    await post(page, presentMessage({ prompt: 'What is the binary number 1100 in decimal?', direction: 'to-decimal', value: '1100' }))
    await expect.poll(() => frame.locator('.bits th').allTextContents()).toEqual(['8', '4', '2', '1'])
    expect(await frame.locator('.bits td').allTextContents()).toEqual(['1', '1', '0', '0'])
    expect(await frame.locator('.bits').getAttribute('aria-label')).toBe('Place values and bits: 8: 1, 4: 1, 2: 0, 1: 0')
    await post(page, presentMessage({ prompt: 'Write 20 in binary.', direction: 'to-binary', value: '20' }))
    await expect.poll(() => frame.locator('.bits th').count()).toBe(8)
    expect((await frame.locator('.bits td').allTextContents()).join('')).toBe('')
    await post(page, { type: 'hodos:block', block: { id: 'b1', type: 'binary-bits', attributes: { id: 'b1', value: 22, bits: 8 } } })
    await expect.poll(() => frame.locator('.bits td').allTextContents()).toEqual(['0', '0', '0', '1', '0', '1', '1', '0'])
    // Malformed or unknown messages change nothing.
    for (const junk of [{ type: 'hodos:present' }, { type: 'hodos:block', block: { type: 'binary-bits', attributes: { value: '<b>x</b>' } } }, { type: 'evil' }, 'hodos:clear']) await post(page, junk)
    expect(await frame.locator('.bits td').allTextContents()).toEqual(['0', '0', '0', '1', '0', '1', '1', '0'])
    expect((await received(page)).filter(m => m.type === 'hodos:resize').length).toBeGreaterThan(0)
    expect(errors).toEqual([])
    await page.close()
  })
})

describe.skipIf(!DSH_AVAILABLE)('example plugin in DeepSeek Harness (pluginDirs)', () => {
  let mock: MockLlm | undefined
  let dsh: DshProcess | undefined
  let page: Page | undefined
  let session = ''
  const app = (): FrameLocator => hodosApp(the(page, 'page'))
  const state = (): Promise<HodosState> => hodosState(the(page, 'page'), the(dsh, 'dsh').origin, session)

  /** Wait for the model to receive a new result of a call to `name`. */
  async function resultOf(name: string, after: number): Promise<MockToolResult> {
    const found: { result: MockToolResult | undefined } = { result: undefined }
    await expect.poll(() => {
      found.result = the(mock, 'mock').requests.slice(after).flatMap(r => r.toolResults).find(t => t.name === name)
      return found.result !== undefined
    }, { timeout: 60_000 }).toBe(true)
    return the(found.result, `the result of ${name}`)
  }

  beforeAll(async () => {
    mock = await startMockLlm(learningScript({
      probe: { question: 'What does the rightmost bit of a binary number count?', options: ['Ones', 'Twos', 'Tens'], correct: 'Ones' },
      assessment: { strands: [{ strand: 'place value', assessment: 'Reads binary digit by digit.' }] },
      plan: 'graph TD\n  read[Reading binary numbers]',
      steps: [],
    }))
    const home = prepareHome(['packages/dsh-adapter'])
    // A patch replaces a row's whole config: restate dataDir for Hodos.
    const patch = home.patch('example-plugin.yml', `- id: hodos
  config:
    dataDir: !!js dshHomePath('hodos')
    pluginDirs:
      - ${JSON.stringify(PLUGIN)}
`)
    dsh = await startDsh(home, mock.url, [patch])
    page = await the(browser, 'browser').newPage({ viewport: { width: 1500, height: 950 } })
  })

  afterAll(async () => {
    await dsh?.stop()
    await mock?.close()
  })

  it('loads the plugin as data: the tutor asks from its course, its renderer draws, its grader grades in the sandbox', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'I want to learn binary numbers')
    session = await openHodosTab(p)
    const probe = await waitForQuestion(state)

    // The course is a question bank: the tutor sees what the learner would see, never the key.
    const after = the(mock, 'mock').requests.length
    await say(p, 'Call the tool hodos_bank with {"query":"binary decimal"}')
    const listing = await resultOf('hodos_bank', after)
    expect(listing.isError).toBe(false)
    expect(listing.text).toContain('binary-numbers/read-2 (binary.convert; Binary numbers')
    expect(listing.text).toContain('What is the binary number 1100 in decimal?')
    expect(listing.text).not.toContain('answer')

    // Asked: the question ends the tutor's turn and shows in the panel.
    await say(p, 'Call the tool hodos_probe_exercise with {"question":"Read this binary number.","bank":"binary-numbers/read-2"}')
    const q = await waitForQuestion(state, new Set([probe.id]))
    expect(q.form).toMatchObject({ type: 'interface', kind: 'binary.convert', answerField: { name: 'text', type: 'string' } })
    expect(JSON.stringify(q)).not.toContain('"12"')
    const bits = app().locator('iframe.renderer-frame').contentFrame()
    await expect.poll(() => bits.locator('.bits td').allTextContents(), { timeout: 20_000 }).toEqual(['1', '1', '0', '0'])

    // Read as a decimal number: the plugin's grader names the misconception.
    await app().getByLabel('Your answer', { exact: true }).fill('1100')
    await app().getByRole('button', { name: 'Submit' }).click()
    await expect.poll(async () => (await state()).learn?.answered.find(a => a.id === q.id)?.answer?.verdict.outcome, { timeout: 30_000 }).toBe('incorrect')
    const verdict = (await state()).learn?.answered.find(a => a.id === q.id)?.answer?.verdict
    expect(verdict).toMatchObject({ outcome: 'incorrect', score: 0, misconceptions: ['read-as-decimal'] })
  })
})
