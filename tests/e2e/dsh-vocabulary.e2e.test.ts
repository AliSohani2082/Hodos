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
import type { JsonObject } from '@hodos/plugin-sdk'
import { startMockLlm, tutorScript, type MockLlm } from '@hodos/testing'
import { DSH_AVAILABLE, prepareHome, startDsh, type DshProcess } from './support/dsh.js'
import { enterDsh, hodosApp, hodosState, openHodosTab, say, type HodosState } from './support/ui.js'

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

async function openExercise(): Promise<ExerciseView> {
  const found: { exercise: ExerciseView | null } = { exercise: null }
  await expect.poll(async () => {
    found.exercise = (await state()).exercise
    return found.exercise !== null
  }, { timeout: 20_000 }).toBe(true)
  if (found.exercise === null) throw new Error('no exercise')
  return found.exercise
}

async function settled(exercise: ExerciseView): Promise<void> {
  await expect.poll(async () => {
    const ex = (await state()).exercise
    return ex === null || ex.id !== exercise.id || ex.attempt > exercise.attempt
  }, { timeout: 20_000 }).toBe(true)
}

/** Answer in the workspace form: a typed text or the option's radio button. */
async function answer(exercise: ExerciseView, typed?: string): Promise<void> {
  const entry = course.items.find(i => i.id === exercise.itemId)
  if (entry === undefined) throw new Error(`unknown item ${exercise.itemId}`)
  const key = entry.key as JsonObject
  if (entry.kind === KIND.choice) {
    const option = ((entry.payload as JsonObject).options as JsonObject[]).find(o => o.id === key.correct)
    await app().getByRole('radio', { name: String(option?.text) }).check()
  } else {
    await app().getByLabel('Your answer').fill(typed ?? String((key.accepted as string[])[0]))
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
    let missed = false
    for (let n = 0; n < 25; n++) {
      const now = await state()
      if (now.journey?.nextAction.type === 'practice' && now.journey.nextAction.readyForCheckpoint) break
      const next = app().getByRole('button', { name: 'Next exercise' })
      if (await next.count() > 0) await next.click()
      const exercise = await openExercise()
      const entry = course.items.find(i => i.id === exercise.itemId)
      const accepted = String(((entry?.key as JsonObject | undefined)?.accepted as string[] | undefined)?.[0] ?? '')
      if (!missed && entry?.kind !== KIND.choice && /[áéíóú]/u.test(accepted)) {
        missed = true
        await answer(exercise, accepted.normalize('NFD').replace(/́/gu, ''))
        await expect.poll(() => app().locator('.feedback').textContent()).toContain('Partly right.')
        await expect(app().locator('.feedback .misconception').first().textContent()).resolves.toContain('Check the accents')
        const retry = (await state()).exercise
        if (retry !== null && retry.id === exercise.id) await answer(retry)
        continue
      }
      await answer(exercise)
    }
    expect(missed).toBe(true)

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
