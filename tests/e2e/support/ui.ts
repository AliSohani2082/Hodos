/**
 * Driving DeepSeek Harness's web UI from Playwright: first-run screens, the
 * chat composer and the Hodos sidebar tabs.
 */
import { expect } from 'vitest'
import type { APIResponse, FrameLocator, Locator, Page } from 'playwright'
import type { PracticeView, QuestionView, SessionView } from '@hodos/core'

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
 * Open a Hodos tab in the right sidebar by its guide title.
 * @param page - the DSH page.
 * @param title - "Hodos learning" or "Knowledge graph".
 * @param frameTitle - the iframe's title.
 * @returns the DSH session id the tab is shown for.
 */
async function openTab(page: Page, title: string, frameTitle: string): Promise<string> {
  const sidebar = page.getByRole('button', { name: 'Open right sidebar' })
  if (await sidebar.count() > 0) await sidebar.click()
  // Exact match: the tutor's chat messages may mention the title too. With a tab already
  // open, the list of tab types is behind the strip's "New tab" button.
  const entry = page.getByText(title, { exact: true }).first()
  if (!await entry.isVisible()) await page.getByRole('button', { name: 'New tab' }).first().click()
  await entry.click()
  const src = await page.locator(`iframe[title="${frameTitle}"]`).getAttribute('src', { timeout: 20_000 })
  const session = new URL(src ?? '', 'http://x').searchParams.get('session') ?? ''
  expect(session).not.toBe('')
  return session
}

/**
 * Open the Hodos tab (the chat's learning or practice session).
 * @returns the DSH session id the panel is shown for.
 */
export function openHodosTab(page: Page): Promise<string> {
  return openTab(page, 'Hodos learning', 'Hodos')
}

/**
 * Open the Knowledge graph tab.
 * @returns the DSH session id the tab is shown for.
 */
export function openGraphTab(page: Page): Promise<string> {
  return openTab(page, 'Knowledge graph', 'Hodos knowledge graph')
}

/** The Hodos panel inside the DSH sidebar. */
export function hodosApp(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Hodos"]')
}

/** The Knowledge graph tab inside the DSH sidebar. */
export function graphApp(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Hodos knowledge graph"]')
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

/** What the panel reads from the Hodos API, as far as tests look at it. */
export interface HodosState {
  readonly binding: { readonly kind: string; readonly sessionId: string; readonly phase?: string } | null
  readonly learn: SessionView | null
  readonly practice: PracticeView | null
}

/**
 * Read the panel state through Hodos's API with the browser's DSH sign-in cookie.
 * @param page - a page that opened DSH.
 * @param origin - DSH's origin.
 * @param session - the DSH session id.
 */
export async function hodosState(page: Page, origin: string, session: string): Promise<HodosState> {
  const data = await apiData(await page.request.get(`${origin}/hodos/api/v1/state?session=${encodeURIComponent(session)}`))
  if (typeof data !== 'object' || data === null || !('binding' in data && 'learn' in data && 'practice' in data)) {
    throw new Error(`not a panel state: ${JSON.stringify(data)}`)
  }
  return data as HodosState
}

/**
 * Wait until the learning session shows an open question.
 * @param read - reads the current state.
 * @param after - ids of questions already seen.
 * @returns the question.
 */
export async function waitForQuestion(read: () => Promise<HodosState>, after: ReadonlySet<string> = new Set()): Promise<QuestionView> {
  const found: { question: QuestionView | null } = { question: null }
  await expect.poll(async () => {
    const q = (await read()).learn?.openQuestion ?? null
    found.question = q !== null && !after.has(q.id) ? q : null
    return found.question !== null
  }, { timeout: 60_000 }).toBe(true)
  if (found.question === null) throw new Error('no question')
  return found.question
}
