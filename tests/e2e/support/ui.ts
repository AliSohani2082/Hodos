/**
 * Driving DeepSeek Harness's web UI from Playwright: first-run screens, the
 * chat composer and the Hodos sidebar tab.
 */
import { expect } from 'vitest'
import type { APIResponse, FrameLocator, Locator, Page } from 'playwright'
import type { CheckpointView, ExerciseView, JourneyView } from '@hodos/core'

/** DSH's chat composer. */
export function composer(page: Page): Locator {
  return page.locator('[data-composer-input="true"]')
}

/**
 * Open DSH and get to a usable composer: dismiss the preview notice and, on
 * first use, pick the session workspace in DSH's in-browser directory picker.
 */
export async function enterDsh(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForLoadState('networkidle')
  await expect.poll(async () => {
    const notice = page.getByRole('button', { name: 'Continue' })
    if (await notice.count() > 0) await notice.click()
    if (await composer(page).getAttribute('contenteditable') === 'true') return true
    const choose = page.getByRole('button', { name: 'Choose workspace' })
    if (await choose.count() > 0) {
      await choose.first().click()
      await page.getByRole('button', { name: 'Open' }).click()
    }
    return await composer(page).getAttribute('contenteditable') === 'true'
  }, { timeout: 30_000, interval: 1_000 }).toBe(true)
}

/** Send a chat message. */
export async function say(page: Page, text: string): Promise<void> {
  await expect.poll(() => composer(page).getAttribute('contenteditable')).toBe('true')
  await composer(page).click()
  await composer(page).fill(text)
  await page.keyboard.press('Enter')
}

/**
 * Open the "Hodos learning" tab in the right sidebar.
 * @returns the DSH session id the workspace is shown for.
 */
export async function openHodosTab(page: Page): Promise<string> {
  const sidebar = page.getByRole('button', { name: 'Open right sidebar' })
  if (await sidebar.count() > 0) await sidebar.click()
  // Exact match: the tutor's chat messages mention "Hodos learning" too.
  await page.getByText('Hodos learning', { exact: true }).first().click()
  const src = await page.locator('iframe[title="Hodos"]').getAttribute('src', { timeout: 20_000 })
  const session = new URL(src ?? '', 'http://x').searchParams.get('session') ?? ''
  expect(session).not.toBe('')
  return session
}

/** The Hodos workspace inside the DSH sidebar. */
export function hodosApp(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Hodos"]')
}

/**
 * The `data` of a successful Hodos API response (Hodos answers `{ data }`).
 * @param response - a response from the Hodos API.
 */
export async function apiData(response: APIResponse): Promise<unknown> {
  expect(response.status()).toBe(200)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('data' in body)) throw new Error(`not a Hodos API response: ${JSON.stringify(body)}`)
  return body.data
}

/** What the workspace reads from the Hodos API, as far as tests look at it. */
export interface HodosState {
  readonly journey: JourneyView | null
  readonly exercise: ExerciseView | null
  readonly checkpoint: CheckpointView | null
}

/**
 * Read the workspace state through Hodos's API with the browser's DSH sign-in cookie.
 * @param page - a page that opened DSH.
 * @param origin - DSH's origin.
 * @param session - the DSH session id.
 */
export async function hodosState(page: Page, origin: string, session: string): Promise<HodosState> {
  const data = await apiData(await page.request.get(`${origin}/hodos/api/v1/state?session=${encodeURIComponent(session)}`))
  if (typeof data !== 'object' || data === null || !('journey' in data && 'exercise' in data && 'checkpoint' in data)) {
    throw new Error(`not a workspace state: ${JSON.stringify(data)}`)
  }
  return data as HodosState
}

/**
 * Wait until the workspace shows an exercise.
 * @param read - reads the current state.
 * @returns the exercise.
 */
export async function waitForExercise(read: () => Promise<HodosState>): Promise<ExerciseView> {
  const found: { exercise: ExerciseView | null } = { exercise: null }
  await expect.poll(async () => {
    found.exercise = (await read()).exercise
    return found.exercise !== null
  }, { timeout: 20_000 }).toBe(true)
  if (found.exercise === null) throw new Error('no exercise')
  return found.exercise
}

/**
 * Wait until an answer to `exercise` was graded: the exercise moved on, or
 * its attempt number went up.
 * @param read - reads the current state.
 * @param exercise - the exercise as it was before answering.
 */
export async function waitForGrading(read: () => Promise<HodosState>, exercise: ExerciseView): Promise<void> {
  await expect.poll(async () => {
    const ex = (await read()).exercise
    return ex === null || ex.id !== exercise.id || ex.attempt > exercise.attempt
  }, { timeout: 20_000 }).toBe(true)
}
