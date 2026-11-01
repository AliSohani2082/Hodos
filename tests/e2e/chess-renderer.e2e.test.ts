/**
 * The chess board renderer in a real browser: served with the adapter's
 * renderer Content-Security-Policy into a `sandbox="allow-scripts"` iframe,
 * driven over the MessagePort protocol the way the workspace drives it.
 * Requires `pnpm build` (renderer/dist) and Playwright's Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type FrameLocator, type Page } from 'playwright'
import { rendererRoot } from '@hodos/chess'
import { openRenderer, post, received, startRendererHost, type RendererHost } from './support/renderer-host.js'

async function responses(page: Page): Promise<unknown[]> {
  return (await received(page)).filter(m => m.type === 'hodos:response')
}

function exercise(id: string, fen: string, extra: Record<string, unknown> = {}): object {
  return {
    type: 'hodos:present',
    exercise: {
      id, itemId: `item-${id}`, kind: 'chess.puzzle', environment: 'chess.board',
      skills: [{ skillId: 'chess.tactics.fork.knight', weight: 1 }], difficulty: 0, mode: 'practice', hintsAvailable: 5, attempt: 1,
      payload: { fen, orientation: 'white', prompt: 'White to move and win material.', goal: 'best', plies: 1 },
      ...extra,
    },
  }
}

const FORK = '2q3k1/5ppp/8/3N4/8/8/5PPP/6K1 w - - 0 1'
const ROYAL = 'r3k3/pp3ppp/8/3N4/8/8/PPP2PPP/6K1 w - - 0 1'

let host: RendererHost | undefined
let browser: Browser | undefined

beforeAll(async () => {
  host = await startRendererHost(rendererRoot(), '/hodos/env/hodos-chess/chess-board/')
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await host?.close()
})

async function open(): Promise<{ page: Page; board: FrameLocator }> {
  if (browser === undefined || host === undefined) throw new Error('not started')
  const { page, frame, errors } = await openRenderer(browser, host, 'chess.board', ['respond', 'resize'])
  expect(errors).toEqual([])
  return { page, board: frame }
}

const square = (board: FrameLocator, name: string) => board.locator(`[data-square="${name}"]`)

describe('chess board renderer (sandboxed iframe, renderer CSP)', () => {
  it('loads under the CSP, renders an accessible grid and reports its height', async () => {
    const { page, board } = await open()
    await post(page, exercise('prs_1', FORK))
    await expect.poll(() => square(board, 'd5').getAttribute('aria-label')).toBe('d5, white knight')
    expect(await board.locator('[role="gridcell"]').count()).toBe(64)
    expect(await square(board, 'c8').getAttribute('aria-label')).toBe('c8, black queen')
    expect(await board.locator('#prompt').textContent()).toBe('White to move and win material.')
    await expect.poll(async () => (await received(page)).some(m => m.type === 'hodos:resize' && typeof m.height === 'number' && m.height > 300)).toBe(true)
    await page.close()
  })

  it('sends a legal move made by clicking, and nothing for illegal input', async () => {
    const { page, board } = await open()
    await post(page, exercise('prs_1', FORK))
    await square(board, 'c8').click()
    await square(board, 'd5').click()
    await expect.poll(() => square(board, 'e7').getAttribute('aria-label')).toBe('e7, empty, legal move')
    await square(board, 'd4').click()
    expect(await responses(page)).toEqual([])
    await square(board, 'e7').click()
    await expect.poll(() => responses(page)).toEqual([{ type: 'hodos:response', exerciseId: 'prs_1', response: { move: 'Ne7+' } }])
    // Locked (aria-disabled) until the host answers: further clicks send nothing.
    expect(await board.locator('#board').getAttribute('aria-disabled')).toBe('true')
    await square(board, 'g1').click({ force: true })
    expect(await responses(page)).toHaveLength(1)
    await page.close()
  })

  it('supports the keyboard: arrows move, Enter picks up and drops', async () => {
    const { page, board } = await open()
    await post(page, exercise('prs_2', FORK))
    await expect.poll(() => square(board, 'd5').getAttribute('aria-label')).toBe('d5, white knight')
    await square(board, 'e2').focus()
    for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'Enter', 'ArrowUp', 'ArrowUp', 'ArrowRight', 'Enter']) await page.keyboard.press(key)
    await expect.poll(() => responses(page)).toEqual([{ type: 'hodos:response', exerciseId: 'prs_2', response: { move: 'Ne7+' } }])
    await page.close()
  })

  it('shows the opponent reply, the history and the result', async () => {
    const { page, board } = await open()
    await post(page, exercise('prs_3', ROYAL, { payload: { fen: ROYAL, orientation: 'white', prompt: 'Win material.', goal: 'best', plies: 2 } }))
    await square(board, 'd5').click()
    await square(board, 'c7').click()
    await expect.poll(() => responses(page)).toHaveLength(1)
    await post(page, { type: 'hodos:progress', exerciseId: 'prs_3', progress: { fen: 'r7/ppNk1ppp/8/8/8/8/PPP2PPP/6K1 w - - 2 2', played: ['Nc7+', 'Kd7'] }, message: 'Good. Black replied Kd7. Your move.' })
    await post(page, { type: 'hodos:lock', locked: false })
    await expect.poll(() => board.locator('#status').textContent()).toBe('Good. Black replied Kd7. Your move.')
    expect(await board.locator('#history').textContent()).toBe('Moves: 1. Nc7+ Kd7')
    expect(await square(board, 'd7').getAttribute('aria-label')).toBe('d7, black king, last move')
    await square(board, 'c7').click()
    await square(board, 'a8').click()
    await expect.poll(async () => (await responses(page)).at(-1)).toEqual({ type: 'hodos:response', exerciseId: 'prs_3', response: { move: 'Nxa8' } })
    await post(page, { type: 'hodos:result', exerciseId: 'prs_3', correct: true, score: 1 })
    await expect.poll(() => board.locator('#board').getAttribute('class')).toMatch(/(^| )correct( |$)/)
    await page.close()
  })

  it('resets for another attempt after a miss, and replays a released solution', async () => {
    const { page, board } = await open()
    await post(page, exercise('prs_4', ROYAL))
    await square(board, 'd5').click()
    await square(board, 'b6').click()
    await expect.poll(() => responses(page)).toHaveLength(1)
    await post(page, { type: 'hodos:result', exerciseId: 'prs_4', correct: false, score: 0 })
    await post(page, { type: 'hodos:lock', locked: false })
    await expect.poll(() => square(board, 'd5').getAttribute('aria-label')).toBe('d5, white knight')
    expect(await board.locator('#status').textContent()).toBe('Try again from the start position.')
    await square(board, 'd5').click()
    await square(board, 'b4').click()
    await expect.poll(() => responses(page)).toHaveLength(2)
    await post(page, { type: 'hodos:result', exerciseId: 'prs_4', correct: false, score: 0, reveal: { fen: ROYAL, line: ['Nc7+', 'Kd7', 'Nxa8'] } })
    await board.locator('#replay').click()
    await expect.poll(() => square(board, 'a8').getAttribute('aria-label'), { timeout: 10_000 }).toBe('a8, white knight, last move')
    expect(await board.locator('#status').textContent()).toBe('Solution: 1. Nc7+ Kd7 2. Nxa8')
    await page.close()
  })

  it('asks which piece to promote to', async () => {
    const { page, board } = await open()
    await post(page, exercise('prs_5', '6k1/4P3/8/8/8/8/8/6K1 w - - 0 1'))
    await square(board, 'e7').click()
    await square(board, 'e8').click()
    await board.getByRole('button', { name: 'knight' }).click()
    await expect.poll(() => responses(page)).toEqual([{ type: 'hodos:response', exerciseId: 'prs_5', response: { move: 'e8=N' } }])
    await page.close()
  })

  it('draws lesson diagrams without accepting input, and survives malformed data', async () => {
    const { page, board } = await open()
    await post(page, { type: 'hodos:block', block: { id: 'b1', type: 'chess-position', attributes: { id: 'b1', fen: '4k3/8/8/1q3r2/8/2N5/8/6K1 w - - 0 1', arrows: ['c3d4', 'd4b5'], highlights: ['b5'] } } })
    await expect.poll(() => board.locator('svg line').count()).toBe(2)
    expect(await square(board, 'b5').getAttribute('aria-label')).toBe('b5, black queen, highlighted')
    expect(await board.locator('#board').getAttribute('aria-disabled')).toBe('true')
    await square(board, 'c3').click({ force: true })
    expect(await responses(page)).toEqual([])
    // Not a valid FEN: an empty board, no exception, nothing to move.
    await post(page, exercise('prs_6', 'not a position'))
    await expect.poll(() => square(board, 'b5').getAttribute('aria-label')).toBe('b5, empty')
    await post(page, { type: 'hodos:present', exercise: { id: 5 } })
    await square(board, 'e2').click()
    expect(await responses(page)).toEqual([])
    await page.close()
  })
})
