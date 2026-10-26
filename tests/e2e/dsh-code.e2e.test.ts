/**
 * The code and math bundles in a real DeepSeek Harness: both courses are
 * listed, "I want to learn to read Python code" starts the tracing course,
 * the lesson shows its programs in the sandboxed code-view renderer, and a
 * practice answer with a classic misreading gets that misreading's feedback
 * before the right answer releases the program's output.
 *
 * Needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import type { ExerciseView } from '@hodos/core'
import { FEEDBACK, SKILL, tracingCourse } from '@hodos/code'
import type { ExerciseItem } from '@hodos/plugin-sdk'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, waitForExercise, waitForGrading, type HodosState } from './support/ui.js'
import { jsonObject, jsonObjects, jsonString } from '../support/json.js'

const course = tracingCourse()

let mock: MockLlm | undefined
let dsh: DshProcess | undefined
let browser: Browser | undefined
let page: Page | undefined
let session = ''

function the<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not ready`)
  return value
}

const app = (): FrameLocator => hodosApp(the(page, 'page'))
const state = (): Promise<HodosState> => hodosState(the(page, 'page'), the(dsh, 'dsh').origin, session)

function item(exercise: ExerciseView): ExerciseItem {
  return the(course.items.find(i => i.id === exercise.itemId), `item ${exercise.itemId}`)
}

function key(entry: ExerciseItem): { output: string; misreading: { output: string; id: string } } {
  const k = jsonObject(entry.key, `the key of ${entry.id}`)
  const first = jsonObjects(k.misconceptions, `the misreadings of ${entry.id}`)[0]
  const misreading = the(first, `a misreading for ${entry.id}`)
  return {
    output: jsonString(k.output, `the output of ${entry.id}`),
    misreading: { output: jsonString(misreading.output, 'its output'), id: jsonString(misreading.id, 'its id') },
  }
}

async function toolResult(name: string, text: string): Promise<void> {
  await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === name && !t.isError && t.text.includes(text))), { timeout: 60_000 }).toBe(true)
}

describe.skipIf(!DSH_AVAILABLE)('code and math bundles in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(tutorScript({ environment: 'python' }))
    dsh = await startDsh(prepareHome(['packages/dsh-adapter', 'packages/environments/code', 'packages/environments/math']), mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('lists both courses, then teaches Python tracing with the code view', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'Which courses are installed?')
    await toolResult('hodos_list_courses', 'Python: reading and tracing code')
    await toolResult('hodos_list_courses', 'Algebra: simplify, expand, factor')
    await say(p, 'I want to learn to read Python code')
    await toolResult('hodos_start_learning', 'Python: reading and tracing code')
    session = await openHodosTab(p)

    // Placement: a beginner answers "I don't know" throughout.
    for (let n = 0; n < 15; n++) {
      if ((await state()).journey?.nextAction.type !== 'diagnostic') break
      const exercise = await waitForExercise(state)
      await app().getByRole('button', { name: 'I don\'t know' }).click()
      await waitForGrading(state, exercise)
    }
    expect((await state()).journey?.path[0]?.id).toBe(SKILL.expressions)
    await app().getByRole('button', { name: 'Start this path' }).click()

    // The lesson: its first program in the sandboxed code view, with the output.
    await expect.poll(() => app().locator('.lesson h2').first().textContent(), { timeout: 20_000 }).toBe('Expressions and operators')
    const snippet = app().locator('figure.block-frame iframe.renderer-frame').first().contentFrame()
    await expect.poll(() => snippet.locator('.code .line').count(), { timeout: 20_000 }).toBe(4)
    expect(await snippet.locator('.tok-builtin').first().textContent()).toBe('print')
    expect(await snippet.locator('.output-text').textContent()).toBe('2.5\n2\n2\n32')
    await app().getByRole('radio', { name: '4', exact: true }).check()
    await app().getByRole('button', { name: 'Check' }).click()
    await expect.poll(() => app().locator('.check-status').first().textContent()).toContain('Right.')
    await app().getByRole('button', { name: 'Continue to practice' }).click()

    // Practice: the exercise program in the code view; a misreading first, then the right output.
    const exercise = await waitForExercise(state)
    const entry = item(exercise)
    const { output, misreading } = key(entry)
    const listing = app().locator('section.environment-pane iframe.renderer-frame').contentFrame()
    const source = jsonString(jsonObject(entry.payload, `the payload of ${entry.id}`).source, `the source of ${entry.id}`)
    await expect.poll(() => listing.locator('.code .line').count(), { timeout: 20_000 }).toBe(source.split('\n').length)
    await app().getByLabel('Your answer').fill(misreading.output)
    await app().getByRole('button', { name: 'Submit answer' }).click()
    await waitForGrading(state, exercise)
    await expect.poll(() => app().locator('.feedback').textContent()).toContain('Not quite.')
    expect(await app().locator('.feedback .misconception').first().textContent()).toBe(FEEDBACK[misreading.id])
    const retry = await waitForExercise(state)
    await app().getByLabel('Your answer').fill(output)
    await app().getByRole('button', { name: 'Submit answer' }).click()
    await waitForGrading(state, retry)
    await expect.poll(() => app().locator('.feedback').textContent()).toContain('Correct.')
    await expect.poll(() => listing.locator('.output .output-text').textContent()).toBe(output)
  })
})
