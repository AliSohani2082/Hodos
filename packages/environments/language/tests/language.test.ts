import { describe, expect, it } from 'vitest'
import type { ExerciseItem, GradeInput, JsonObject } from '@hodos/plugin-sdk'
import { ACCENT_CREDIT, BLANK, gradeLanguage, KIND, KINDS, match, spanishCourse } from '../src/index.js'
import { canonical, withoutAccents, wrongArticleGender, wrongWordOrder } from '../src/normalize.js'

const course = spanishCourse()
const item = (id: string): ExerciseItem => {
  const found = course.items.find(i => i.id === id)
  if (found === undefined) throw new Error(`no item ${id}`)
  return found
}
const kind = (id: string) => {
  const found = KINDS.find(k => k.id === id)
  if (found === undefined) throw new Error(`no kind ${id}`)
  return found
}
const input = (it: ExerciseItem, response: JsonObject): GradeInput => ({ kind: it.kind, payload: it.payload, key: it.key, response, mode: 'practice', skills: it.skills, attempt: 1 })
const errors = (it: ExerciseItem): string[] => (kind(it.kind).validateItem?.(it) ?? []).filter(d => d.severity === 'error').map(d => d.code)

describe('comparing answers', () => {
  it('ignores case, spacing and punctuation, including ¿ and ¡', () => {
    expect(canonical('  ¿Cómo   ESTÁS? ')).toBe('cómo estás')
    expect(canonical('¡Hola, Ana!')).toBe('hola ana')
    expect(match('buenos dias', ['buenos días'])).toBe('accents')
    expect(match('Buenos días.', ['buenos días'])).toBe('exact')
  })

  it('folds acute accents and the diaeresis, but ñ is a different letter', () => {
    expect(withoutAccents('pingüino está')).toBe('pinguino esta')
    expect(match('ano', ['año'])).toBe('none')
    expect(match('', ['año'])).toBe('none')
  })

  it('recognizes swapped article gender and word order', () => {
    expect(wrongArticleGender('una', ['un'])).toBe(true)
    expect(wrongArticleGender('la libro', ['el libro'])).toBe(true)
    expect(wrongArticleGender('el perro', ['el libro'])).toBe(false)
    expect(wrongWordOrder('soy yo estudiante', ['Yo soy estudiante'])).toBe(true)
    expect(wrongWordOrder('yo soy estudiante', ['Yo soy estudiante'])).toBe(false)
  })
})

describe('grading', () => {
  it('accepts every listed answer and gives partial credit for missing accents', () => {
    expect(gradeLanguage(input(item('g-goodbye'), { text: 'Chao' }))).toMatchObject({ correct: true, score: 1 })
    const accents = gradeLanguage(input(item('e-tu'), { text: 'estas' }))
    expect(accents).toMatchObject({ correct: false, score: ACCENT_CREDIT, misconceptions: ['missing-accent'] })
    expect(gradeLanguage(input(item('g-c-how-are-you'), { text: 'que tal' })).misconceptions).toEqual(['missing-accent'])
    expect(gradeLanguage(input(item('g-c-how-are-you'), { text: '¿Qué tal?' })).correct).toBe(true)
  })

  it('reports article gender, word order and ser/estar misconceptions', () => {
    expect(gradeLanguage(input(item('a-un-gato'), { text: 'una' })).misconceptions).toEqual(['article-gender'])
    expect(gradeLanguage(input(item('st-estudiante'), { text: 'Soy yo estudiante' })).misconceptions).toEqual(['word-order'])
    const choice = gradeLanguage(input(item('se-oficina'), { choice: 'a' }))
    expect(choice).toMatchObject({ correct: false, misconceptions: ['ser-for-location'] })
    expect(item('se-oficina').misconceptionFeedback?.['ser-for-location']).toBeDefined()
    expect(gradeLanguage(input(item('se-oficina'), { choice: 'b' })).correct).toBe(true)
  })

  it('never puts an accepted answer in its feedback', () => {
    for (const it of course.items.filter(i => i.kind !== KIND.choice)) {
      const accepted = (it.key as { accepted: string[] }).accepted
      for (const response of [{ text: 'xyz' }, { text: '' }, { text: accepted[0]?.toUpperCase() ?? '' }]) {
        const feedback = gradeLanguage(input(it, response)).feedback ?? ''
        for (const a of accepted) if (canonical(a).length >= 3) expect(canonical(feedback).includes(canonical(a)), `${it.id}: ${feedback}`).toBe(false)
      }
    }
  })
})

describe('items and validation', () => {
  it('has only valid items, with practice, checkpoint and diagnostic items for every skill', () => {
    for (const it of course.items) expect(errors(it), it.id).toEqual([])
    for (const skill of course.skills) {
      const of = (mode: string): number => course.items.filter(i => i.skills.some(s => s.skillId === skill.id) && i.modes.some(m => m === mode)).length
      expect(of('practice'), skill.id).toBeGreaterThanOrEqual(3)
      expect(of('checkpoint'), skill.id).toBeGreaterThanOrEqual(3)
      expect(of('diagnostic'), skill.id).toBeGreaterThanOrEqual(1)
    }
  })

  it('catches broken items', () => {
    const cloze = item('s-somos')
    expect(errors({ ...cloze, payload: { sentence: 'Nosotros somos amigos.' } })).toContain('language/cloze-blank')
    expect(errors({ ...cloze, payload: { sentence: `${BLANK} y ${BLANK}` } })).toContain('language/cloze-blank')
    const recall = item('g-thanks')
    expect(errors({ ...recall, payload: { prompt: 'say gracias', from: 'en', to: 'es' } })).toContain('language/answer-in-prompt')
    const order = item('st-estudiante')
    expect(errors({ ...order, key: { accepted: ['Yo soy profesor'] } })).toContain('language/order-tokens')
    expect(errors({ ...order, payload: { tokens: ['Yo', 'soy', 'estudiante'] } })).toContain('language/order-shuffled')
    const choice = item('se-oficina')
    expect(errors({ ...choice, key: { correct: 'z' } })).toContain('language/choice-key')
    expect(errors({ ...choice, key: { correct: 'b', misconceptions: { b: 'ser-for-location' } } })).toContain('language/choice-misconception')
  })

  it('shows every exercise as plain text without its answer', () => {
    for (const it of course.items) {
      const text = kind(it.kind).fallbackText(it.payload)
      expect(text.length, it.id).toBeGreaterThan(5)
      if (it.kind === KIND.choice) continue
      for (const a of (it.key as { accepted: string[] }).accepted) {
        if (it.kind !== KIND.order && canonical(a).length >= 3) expect(` ${canonical(text)} `.includes(` ${canonical(a)} `), `${it.id}: ${text}`).toBe(false)
      }
    }
  })
})
