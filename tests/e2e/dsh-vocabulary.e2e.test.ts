/**
 * The vocabulary journey through a real DeepSeek Harness with the language
 * environment: "I want to learn Spanish" → placement → greetings lesson →
 * typed practice (a missed accent gets partial credit and a pointer) → an
 * unassisted checkpoint → the skill is mastered and its review scheduled.
 * The environment has no renderer: every exercise is the workspace's own
 * accessible form over the plain-text prompt.
 *
 * Needs `pnpm build` and HODOS_DSH_BIN; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import type { ExerciseView } from '@hodos/core'
import { KIND, SKILL, spanishCourse } from '@hodos/language'
import type { ExerciseItem } from '@hodos/plugin-sdk'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, waitForExercise, waitForGrading, type HodosState } from './support/ui.js'
import { jsonObject, jsonObjects, jsonString, jsonStrings } from '../support/json.js'

const course = spanishCourse()

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

const openExercise = (): Promise<ExerciseView> => waitForExercise(state)
const settled = (exercise: ExerciseView): Promise<void> => waitForGrading(state, exercise)

function item(exercise: ExerciseView): ExerciseItem {
  return the(course.items.find(i => i.id === exercise.itemId), `item ${exercise.itemId}`)
}

/** The first accepted answer of a typed item; '' for a choice. */
function accepted(entry: ExerciseItem): string {
  if (entry.kind === KIND.choice) return ''
  return the(jsonStrings(jsonObject(entry.key, `the key of ${entry.id}`).accepted, `the answers of ${entry.id}`)[0], `an answer of ${entry.id}`)
}

/** Answer in the workspace form: a typed text or the option's radio button. */
async function answer(exercise: ExerciseView, typed?: string): Promise<void> {
  const entry = item(exercise)
  if (entry.kind === KIND.choice) {
    const correct = jsonObject(entry.key, `the key of ${entry.id}`).correct
    const option = jsonObjects(jsonObject(entry.payload, `the payload of ${entry.id}`).options, `the options of ${entry.id}`).find(o => o.id === correct)
    await app().getByRole('radio', { name: jsonString(option?.text, `the right option of ${entry.id}`) }).check()
  } else {
    await app().getByLabel('Your answer').fill(typed ?? accepted(entry))
  }
  await app().getByRole('button', { name: 'Submit answer' }).click()
  await settled(exercise)
}

describe.skipIf(!DSH_AVAILABLE)('vocabulary journey in DeepSeek Harness', () => {
  beforeAll(async () => {
    mock = await startMockLlm(tutorScript({ environment: 'language' }))
    dsh = await startDsh(prepareHome(['packages/dsh-adapter', 'packages/environments/language']), mock.url)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  })

  afterAll(async () => {
    await browser?.close()
    await dsh?.stop()
    await mock?.close()
  })

  it('learns Spanish greetings from the chat to a scheduled review', async () => {
    const p = the(page, 'page')
    await enterDsh(p, the(dsh, 'dsh').url)
    await say(p, 'I want to learn Spanish')
    await expect.poll(() => the(mock, 'mock').requests.some(r => r.toolResults.some(t => t.name === 'hodos_start_learning' && !t.isError && t.text.includes('Spanish basics'))), { timeout: 60_000 }).toBe(true)
    session = await openHodosTab(p)

    // Placement: a beginner knows none of it.
    for (let n = 0; n < 15; n++) {
      if ((await state()).journey?.nextAction.type !== 'diagnostic') break
      const exercise = await openExercise()
      await app().getByRole('button', { name: 'I don\'t know' }).click()
      await settled(exercise)
    }
    const planned = await state()
    expect(planned.journey?.path[0]?.id).toBe(SKILL.greetings)
    await app().getByRole('button', { name: 'Start this path' }).click()

    // The lesson: phrases shown as text (no renderer), then the check.
    await expect.poll(() => app().locator('.lesson h2').first().textContent(), { timeout: 20_000 }).toBe('Greetings and courtesy')
    await expect(app().locator('.block-fallback').first().textContent()).resolves.toBe('hola — hello (any time of day)')
    await app().getByRole('radio', { name: 'de nada' }).check()
    await app().getByRole('button', { name: 'Check' }).click()
    await expect.poll(() => app().locator('.check-status').first().textContent()).toContain('Right.')
    await app().getByRole('button', { name: 'Continue to practice' }).click()

    // Practice until the checkpoint is recommended; one answer misses its accents.
    let accentFeedback: string | null | undefined
    for (let n = 0; n < 25; n++) {
      const now = await state()
      if (now.journey?.nextAction.type === 'practice' && now.journey.nextAction.readyForCheckpoint) break
      const next = app().getByRole('button', { name: 'Next exercise' })
      if (await next.count() > 0) await next.click()
      const exercise = await openExercise()
      const typed = accepted(item(exercise))
      if (accentFeedback === undefined && /[áéíóú]/u.test(typed)) {
        await answer(exercise, typed.normalize('NFD').replace(/́/gu, ''))
        await app().locator('.feedback', { hasText: 'Partly right.' }).waitFor({ timeout: 20_000 })
        accentFeedback = await app().locator('.feedback .misconception').first().textContent()
        const retry = (await state()).exercise
        if (retry !== null && retry.id === exercise.id) await answer(retry)
        continue
      }
      await answer(exercise)
    }
    expect(accentFeedback).toContain('Check the accents')

    await app().getByRole('button', { name: 'Take the checkpoint' }).click()
    await expect.poll(() => app().locator('.mode-banner strong').textContent(), { timeout: 20_000 }).toBe('Checkpoint')
    for (let n = 0; n < 5; n++) {
      if ((await state()).journey?.nextAction.type !== 'checkpoint') break
      await answer(await openExercise())
    }
    await expect.poll(() => app().locator('.checkpoint-result h3').textContent(), { timeout: 20_000 }).toBe('Checkpoint passed')
    const done = await state()
    const greetings = done.journey?.completedSkills.find(s => s.id === SKILL.greetings)
    expect(greetings?.status).toBe('mastered')
    expect(new Date(greetings?.dueAt ?? 0).getTime()).toBeGreaterThan(Date.now())
    expect(done.journey?.activeSkill?.id).toBe(SKILL.articles)
  })
})
