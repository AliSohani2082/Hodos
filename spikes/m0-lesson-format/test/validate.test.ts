import { describe, expect, test } from 'bun:test'
import { blocksOf } from '../src/shared-validate.ts'
import { formatDiagnostics, parse, validateLesson } from '../src/validate.ts'
import { CTX, LESSON_D, LESSON_M } from './fixtures.ts'

const shape = (arm: 'markdoc' | 'directive', src: string) =>
  blocksOf(parse(arm, src).doc.children).map((b) => ({ type: b.type, attrs: b.attrs }))

describe('parity', () => {
  test('the same lesson is valid in both arms', () => {
    const m = validateLesson('markdoc', LESSON_M, CTX)
    const d = validateLesson('directive', LESSON_D, CTX)
    expect(formatDiagnostics(m.diagnostics)).toBe('')
    expect(formatDiagnostics(d.diagnostics)).toBe('')
  })
  test('both arms normalise to identical blocks and attributes', () => {
    expect(shape('directive', LESSON_D)).toEqual(shape('markdoc', LESSON_M))
  })
})

import { markers } from '../src/markers.ts'
import { renderPlain } from '../src/render.ts'

describe('rendering and markers', () => {
  test('plain rendering is identical for the same lesson in both arms', () => {
    const m = renderPlain(parse('markdoc', LESSON_M).doc)
    const d = renderPlain(parse('directive', LESSON_D).doc)
    expect(d).toBe(m)
    expect(m).toContain('Perspective from src:silman (emphasis)')
    expect(m).toContain('Exercise e1 (mcq, recognize)')
  })
  test('markers ignore code', () => {
    expect(markers('markdoc', 'A {% cite chunk="x" %}b{% /cite %}\n\n```\n{% callout %}\n```\n\n`{% term %}`\n').map((m) => m.name)).toEqual(['cite'])
    expect(markers('directive', ':::callout{type=tip}\nx :cite[y]{chunk=z}\n:::\n```\n:::exercise\n```\nTime 12:30\n').map((m) => m.name)).toEqual(['callout', 'cite'])
  })
})
