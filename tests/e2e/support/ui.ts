/**
 * Driving DeepSeek Harness's web UI from Playwright: first-run screens, the
 * chat composer and the Hodos sidebar tab.
 */
import { expect } from 'vitest'
import type { FrameLocator, Locator, Page } from 'playwright'
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
  const response = await page.request.get(`${origin}/hodos/api/v1/state?session=${encodeURIComponent(session)}`)
  expect(response.status()).toBe(200)
  const body: { data: HodosState } = await response.json()
  return body.data
}
