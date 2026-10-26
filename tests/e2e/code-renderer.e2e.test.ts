/**
 * The code renderer in a real browser, under the renderer CSP in a
 * sandboxed iframe: programs become highlighted listings built from text.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { rendererRoot } from '@hodos/code'
import { openRenderer, post, startRendererHost, type RendererHost } from './support/renderer-host.js'

let host: RendererHost | undefined
let browser: Browser | undefined

beforeAll(async () => {
  host = await startRendererHost(rendererRoot(), '/hodos/env/hodos-code/code-view/')
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

const exercise = (kind: string, payload: object): object => ({
  type: 'hodos:present',
  exercise: { id: 'p1', itemId: 'i1', kind, environment: 'code.listing', skills: [{ skillId: 'py.loops', weight: 1 }], difficulty: 0, mode: 'practice', hintsAvailable: 2, attempt: 1, payload },
})

describe('code renderer (sandboxed iframe, renderer CSP)', () => {
  it('shows a program as a numbered, highlighted listing and the released output', async () => {
    const { page, frame, errors } = await openRenderer(ready().browser, ready().host, 'code.listing')
    await post(page, exercise('code.predict', { language: 'python', source: 'for i in range(1, 4):\n    print(i)  # each\nprint("done")', highlight: [2] }))
    await expect.poll(() => frame.locator('.code .line').count()).toBe(3)
    expect(await frame.locator('.prompt').textContent()).toBe('What does this program print?')
    expect(await frame.locator('.code').getAttribute('aria-label')).toBe('Python program, 3 lines')
    expect(await frame.locator('.code .line .src').allTextContents()).toEqual(['for i in range(1, 4):', '    print(i)  # each', 'print("done")'])
    expect(await frame.locator('.tok-keyword').allTextContents()).toEqual(['for', 'in'])
    expect(await frame.locator('.tok-builtin').allTextContents()).toEqual(['range', 'print', 'print'])
    expect(await frame.locator('.tok-string').allTextContents()).toEqual(['"done"'])
    expect(await frame.locator('.tok-comment').allTextContents()).toEqual(['# each'])
    expect(await frame.locator('.line.hl').getAttribute('data-line')).toBe('2')
    await post(page, { type: 'hodos:result', exerciseId: 'p1', correct: true, score: 1, reveal: { output: '1\n2\n3\ndone\n' } })
    await expect.poll(() => frame.locator('.output .output-text').textContent()).toBe('1\n2\n3\ndone')
    expect(await frame.locator('.output .output-label').textContent()).toBe('The program prints')
    expect(errors).toEqual([])
    await page.close()
  })

  it('shows lesson snippets with their output, and program text never as markup', async () => {
    const { page, frame, errors } = await openRenderer(ready().browser, ready().host, 'code-snippet')
    await post(page, { type: 'hodos:block', block: { id: 'b1', type: 'code-snippet', attributes: { id: 'b1', source: 's = """two\nlines"""\nprint(s)', output: 'two\nlines' } } })
    await expect.poll(() => frame.locator('.code .line').count()).toBe(3)
    expect(await frame.locator('.tok-string').allTextContents()).toEqual(['"""two', 'lines"""'])
    expect(await frame.locator('.output-text').textContent()).toBe('two\nlines')
    await post(page, { type: 'hodos:block', block: { id: 'b2', type: 'code-snippet', attributes: { id: 'b2', source: 'print("<img src=x onerror=alert(1)>")\n<script>alert(`2`)</script>' } } })
    await expect.poll(() => frame.locator('.code .line .src').first().textContent()).toBe('print("<img src=x onerror=alert(1)>")')
    expect(await frame.locator('img, script:not([src])').count()).toBe(0)
    expect(await frame.locator('.tok-error').count()).toBe(1)
    expect(await frame.locator('.output').count()).toBe(0)
    expect(errors).toEqual([])
    await page.close()
  })

  it('shows code-writing tasks with their examples', async () => {
    const { page, frame } = await openRenderer(ready().browser, ready().host, 'code.listing')
    await post(page, exercise('code.write', { prompt: 'Read n and print 1 + … + n.', language: 'python', examples: [{ input: '3\n', output: '6\n' }], starter: 'n = int(input())\n' }))
    await expect.poll(() => frame.locator('.prompt').textContent()).toBe('Read n and print 1 + … + n.')
    expect(await frame.locator('.example h3').allTextContents()).toEqual(['Example 1'])
    expect(await frame.locator('.example .output-text').allTextContents()).toEqual(['3', '6'])
    expect(await frame.locator('.code .line .src').allTextContents()).toEqual(['n = int(input())'])
    await page.close()
  })
})
