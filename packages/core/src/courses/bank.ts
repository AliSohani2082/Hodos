/**
 * Question banks: the exercises of installed, approved courses, which the
 * tutor may ask instead of writing its own. The tutor sees each exercise's
 * learner-visible text and how it was verified, never its key; it asks one
 * by reference, and Hodos grades it like any interface question.
 * @module @hodos/core/courses/bank
 */
import { stripServerFields, type ExerciseItem } from '@hodos/plugin-sdk'
import type { BankEntry, QuestionBank } from '../learn/service.js'
import type { PluginRegistry } from '../registry/registry.js'
import type { HodosStore } from '../store/store.js'

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1)
}

/**
 * A question bank over the approved courses of a store, for kinds that are installed.
 * @param store - the course store.
 * @param registry - installed kinds (their projection and text view).
 * @returns the bank.
 */
export function courseBank(store: HodosStore, registry: PluginRegistry): QuestionBank {
  const entries = (): Array<{ entry: BankEntry; item: ExerciseItem; courseId: string; haystack: string }> => {
    const out: Array<{ entry: BankEntry; item: ExerciseItem; courseId: string; haystack: string }> = []
    const seen = new Set<string>()
    // Newest version first, so an older version of a course never shadows the current one.
    for (const course of store.courses('approved')) {
      if (seen.has(course.id)) continue
      seen.add(course.id)
      const skills = new Map(course.spec.skills.map(s => [s.id, s.title]))
      for (const item of course.spec.items) {
        const kind = registry.kind(item.kind)
        if (kind === undefined) continue
        const visible = stripServerFields(kind.spec.payloadSchema, item.payload) ?? null
        const text = registry.fallbackText(item.kind, visible).replace(/\s+/gu, ' ').trim().slice(0, 300)
        const skill = item.skills.map(s => skills.get(s.skillId) ?? s.skillId).join(', ')
        const entry: BankEntry = { ref: `${course.id}/${item.id}`, course: course.title, kind: item.kind, skill, text, verifiedBy: item.provenance?.verifiedBy ?? [] }
        out.push({ entry, item, courseId: course.id, haystack: `${course.title} ${skill} ${item.kind} ${text}`.toLowerCase() })
      }
    }
    return out
  }
  return {
    search(query, limit) {
      const wanted = words(query)
      const all = entries()
      const scored = wanted.length === 0
        ? all.map(e => ({ e, score: 1 }))
        : all.map(e => ({ e, score: wanted.filter(w => e.haystack.includes(w)).length })).filter(x => x.score > 0)
      return scored.toSorted((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, limit))).map(x => x.e.entry)
    },
    item(ref) {
      const found = entries().find(e => e.entry.ref === ref)
      return found === undefined ? undefined : { item: found.item, courseId: found.courseId }
    },
  }
}
