import { describe, expect, test } from 'bun:test'
import { BLOCKS } from '../src/blocks.ts'
import { blockCatalog, examples, syntaxSection, systemPrompt } from '../src/prompts.ts'
import { blocksOf } from '../src/shared-validate.ts'
import type { Arm } from '../src/types.ts'
import { parse, validateLesson, formatDiagnostics } from '../src/validate.ts'
import { CTX } from './fixtures.ts'

const EX_CTX = {
  chunkIds: new Set(['src:openstax-physics#c2', 'src:openstax-physics#c3', 'src:galileo#c1', 'src:openstax-algebra#c2', 'src:openstax-algebra#c3', 'src:openstax-algebra#c5', 'src:mactutor#c1']),
  outlets: new Set(['src:openstax-physics', 'src:galileo', 'src:openstax-algebra', 'src:mactutor']),
  allowed: CTX.allowed,
}
const shape = (arm: Arm, src: string) => blocksOf(parse(arm, src).doc.children).map((b) => ({ type: b.type, attrs: b.attrs }))

describe('canonical examples', () => {
  for (const i of [0, 1]) {
    test(`example ${i + 1} is valid in both arms`, () => {
      expect(formatDiagnostics(validateLesson('markdoc', examples('markdoc')[i]!, EX_CTX).diagnostics)).toBe('')
      expect(formatDiagnostics(validateLesson('directive', examples('directive')[i]!, EX_CTX).diagnostics)).toBe('')
    })
    test(`example ${i + 1} is the same lesson in both arms`, () => {
      expect(shape('directive', examples('directive')[i]!)).toEqual(shape('markdoc', examples('markdoc')[i]!))
    })
  }
  test('the two examples together use every kind of structured payload', () => {
    const used = new Set(examples('markdoc').flatMap((e) => shape('markdoc', e).map((b) => b.type)))
    for (const t of ['cite', 'term', 'callout', 'perspective', 'plot', 'timeline', 'worked-example', 'step', 'exercise']) expect(used.has(t)).toBe(true)
  })
})

describe('length parity (§8.2: guidance within ±10%)', () => {
  const all = BLOCKS.map((b) => b.name)
  const len = (arm: Arm) => ({
    syntax: syntaxSection(arm).length,
    examples: examples(arm).join('').length,
    system: systemPrompt(arm, all).length,
  })
  test('syntax section + examples, and the whole system prompt', () => {
    const m = len('markdoc')
    const d = len('directive')
    // The directive syntax section is longer on its own: yaml bodies, quoting and the colon-count rule need teaching.
    // That is a property of the format and is reported, not padded away in the Markdoc text.
    console.log(`syntax only: markdoc=${m.syntax} directive=${d.syntax} ratio=${(d.syntax / m.syntax).toFixed(3)}`)
    console.log(`examples:    markdoc=${m.examples} directive=${d.examples} ratio=${(d.examples / m.examples).toFixed(3)}`)
    const guidance = (x: typeof m) => x.syntax + x.examples
    const gr = guidance(d) / guidance(m)
    console.log(`guidance:    markdoc=${guidance(m)} directive=${guidance(d)} ratio=${gr.toFixed(3)}`)
    expect(gr).toBeGreaterThan(0.9)
    expect(gr).toBeLessThan(1.1)
    expect(d.examples / m.examples).toBeGreaterThan(0.9)
    expect(d.system / m.system).toBeGreaterThan(0.9)
    expect(d.system / m.system).toBeLessThan(1.1)
  })
})

describe('block syntax examples', () => {
  const sentence = (src: string) => `A claim ${src} done.\n`
  for (const arm of ['markdoc', 'directive'] as const) {
    for (const b of BLOCKS) {
      if (b.name === 'step') continue
      test(`${arm}/${b.name} canonical syntax is valid`, () => {
        const ctx = { ...EX_CTX, chunkIds: new Set([...EX_CTX.chunkIds, 'src:wiki-fork#c3']), outlets: new Set([...EX_CTX.outlets, 'src:silman']) }
        const front = '---\nlesson: t\nconcept: a.b\n---\n\n'
        const snippets = [b.syntax[arm], ...(b.alt?.[arm] ? [b.alt[arm]!.example] : [])]
        for (const s of snippets) {
          const body = b.kind === 'inline' ? sentence(s) : s + '\n'
          // alt examples reuse ids from the main one in the same lesson only if combined; validate separately.
          expect(formatDiagnostics(validateLesson(arm, front + body, ctx).diagnostics)).toBe('')
        }
      })
    }
  }
})
