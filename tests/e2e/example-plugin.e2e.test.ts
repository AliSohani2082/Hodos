/**
 * The sample third-party plugin (examples/binary-numbers) in a browser and in
 * a real DeepSeek Harness. Its renderer is plain JavaScript speaking the
 * renderer protocol by hand, served under the renderer CSP into a sandboxed
 * iframe. In the Harness the plugin is loaded from the `pluginDirs` setting as
 * untrusted data: its grader runs in the QuickJS sandbox.
 *
 * The Harness part needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { openRenderer, post, received, startRendererHost, type RendererHost } from './support/renderer-host.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, waitForExercise, waitForGrading, type HodosState } from './support/ui.js'
import { jsonObject, jsonString } from '../support/json.js'

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

  beforeAll(async () => {
    mock = await startMockLlm(tutorScript({ environment: 'binary' }))
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

  it('loads the plugin as data, teaches with its renderer and grades in the sandbox', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'I want to learn binary numbers')
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === 'hodos_start_learning' && !t.isError && t.text.includes('Binary numbers'))), { timeout: 60_000 }).toBe(true)
    session = await openHodosTab(p)
    for (let n = 0; n < 10; n++) {
      if ((await state()).journey?.nextAction.type !== 'diagnostic') break
      const exercise = await waitForExercise(state)
      await app().getByRole('button', { name: 'I don\'t know' }).click()
      await waitForGrading(state, exercise)
    }
    await app().getByRole('button', { name: 'Start this path' }).click()
    await expect.poll(() => app().locator('.lesson h2').first().textContent(), { timeout: 20_000 }).toBe('Reading binary numbers')
    const block = app().locator('figure.block-frame iframe.renderer-frame').first().contentFrame()
    await expect.poll(() => block.locator('.bits td').allTextContents(), { timeout: 20_000 }).toEqual(['1', '1', '1', '0'])
    await app().getByRole('radio', { name: '4', exact: true }).check()
    await app().getByRole('button', { name: 'Check' }).click()
    await app().getByRole('button', { name: 'Continue to practice' }).click()

    const practice = await waitForExercise(state)
    const value = jsonString(jsonObject(practice.payload, 'the exercise payload').value, 'the value to convert')
    const pane = app().locator('section.environment-pane iframe.renderer-frame').contentFrame()
    await expect.poll(() => pane.locator('.bits td').allTextContents(), { timeout: 20_000 }).toEqual(value.padStart(value.length > 4 ? 8 : 4, '0').split(''))
    await app().getByLabel('Your answer').fill(value)
    await app().getByRole('button', { name: 'Submit answer' }).click()
    await waitForGrading(state, practice)
    await expect.poll(() => app().locator('.feedback .misconception').first().textContent()).toBe('The 1s and 0s are bits, not a decimal number: add up the place values that hold a 1.')
    const retry = await waitForExercise(state)
    await app().getByLabel('Your answer').fill(String(parseInt(value, 2)))
    await app().getByRole('button', { name: 'Submit answer' }).click()
    await waitForGrading(state, retry)
    await expect.poll(() => app().locator('.feedback').textContent()).toContain('Correct.')
  })
})
