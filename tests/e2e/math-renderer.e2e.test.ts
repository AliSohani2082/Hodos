/**
 * The math renderer in a real browser, under the renderer CSP in a
 * sandboxed iframe: formulas become MathML and graphs SVG.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { rendererRoot } from '@hodos/math'
import { openRenderer, post, startRendererHost, type RendererHost } from './support/renderer-host.js'

let host: RendererHost | undefined
let browser: Browser | undefined

beforeAll(async () => {
  host = await startRendererHost(rendererRoot(), '/hodos/env/hodos-math/math-view/')
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  await host?.close()
})

function ready(): { browser: Browser; host: RendererHost } {
  if (browser === undefined || host === undefined) throw new Error('not started')
  return { browser, host }
}

describe('math renderer (sandboxed iframe, renderer CSP)', () => {
  it('shows an exercise formula as MathML', async () => {
    const { page, frame, errors } = await openRenderer(ready().browser, ready().host, 'math.expression')
    await post(page, {
      type: 'hodos:present',
      exercise: {
        id: 'p1', itemId: 'exp-c2', kind: 'math.expression', environment: 'math.expression', skills: [{ skillId: 'alg.expand', weight: 1 }],
        difficulty: 0, mode: 'practice', hintsAvailable: 2, attempt: 1,
        payload: { prompt: 'Expand and simplify.', formula: '(x + 1)^2 / 2', variables: ['x'], form: 'expanded' },
      },
    })
    await expect.poll(() => frame.locator('.prompt').textContent()).toBe('Expand and simplify.')
    expect(await frame.locator('math mfrac msup').count()).toBe(1)
    expect(await frame.locator('math mo').allTextContents()).toEqual(expect.arrayContaining(['(', '+', ')']))
    expect(errors).toEqual([])
    await page.close()
  })

  it('draws graphs: points, lines through them and functions', async () => {
    const { page, frame } = await openRenderer(ready().browser, ready().host, 'math.expression')
    await post(page, {
      type: 'hodos:present',
      exercise: {
        id: 'p2', itemId: 'slo-1', kind: 'math.numeric', environment: 'math.expression', skills: [{ skillId: 'alg.slope', weight: 1 }],
        difficulty: 0, mode: 'practice', hintsAvailable: 2, attempt: 1,
        payload: { prompt: 'What is the slope of the line through the two marked points?', graph: { x: [-1, 5], y: [-1, 7], points: [[0, 1], [2, 5]], lines: [[0, 1, 2, 5]] } },
      },
    })
    await expect.poll(() => frame.locator('svg.graph circle.point').count()).toBe(2)
    expect(await frame.locator('svg.graph line.curve').count()).toBe(1)
    expect(await frame.locator('svg.graph').getAttribute('aria-label')).toBe('Graph: point (0, 1); point (2, 5)')
    await post(page, { type: 'hodos:block', block: { id: 'b1', type: 'math-graph', attributes: { id: 'b1', x: [-3, 4], y: [-4, 6], functions: [{ expr: '2x - 1' }] } } })
    await expect.poll(() => frame.locator('svg.graph polyline.curve').count()).toBe(1)
    await post(page, { type: 'hodos:block', block: { id: 'b2', type: 'math-formula', attributes: { id: 'b2', expr: 'y = 2x - 1', variables: ['x', 'y'] } } })
    await expect.poll(() => frame.locator('math mo').allTextContents()).toEqual(expect.arrayContaining(['=', '−']))
    // Text that does not parse is shown as text, never as markup.
    await post(page, { type: 'hodos:block', block: { id: 'b3', type: 'math-formula', attributes: { id: 'b3', expr: '<img src=x onerror=alert(1)>', variables: [] } } })
    await expect.poll(() => frame.locator('.formula-text').textContent()).toBe('<img src=x onerror=alert(1)>')
    expect(await frame.locator('img').count()).toBe(0)
    await page.close()
  })
})
