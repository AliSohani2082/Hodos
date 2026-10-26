/**
 * Course validation: one validator for every content source (plugin content
 * packs, agent proposals, imports). Checks graph acyclicity and references,
 * environment and capability availability, lesson syntax and blocks, item
 * schemas, answer-key consistency (through the owning plugin's validator) and
 * coverage.
 * @module @hodos/core/content/course
 */
import type { CourseSpec, Diagnostic, LessonNode } from '@hodos/plugin-sdk'
import { isSemver, validateCourseShape } from '@hodos/plugin-sdk'
import { validateSkillGraph } from '../graph/skill-graph.js'
import type { PluginRegistry, RegisteredBlock } from '../registry/registry.js'
import { parseLesson, type BlockDefinition, type BlockLookup } from './lesson.js'

/**
 * Adapt the registry's blocks to the lesson parser. Untrusted plugins'
 * in-process validators are never called.
 * @param registry - the plugin registry.
 * @returns a block lookup.
 */
export function blockLookup(registry: Pick<PluginRegistry, 'block'>): BlockLookup {
  return {
    block(name: string): BlockDefinition | undefined {
      const b: RegisteredBlock | undefined = registry.block(name)
      if (b === undefined) return undefined
      const trusted = b.trusted || b.declarative
      return {
        name: b.spec.name,
        kind: b.spec.kind,
        attributes: b.spec.attributes,
        validateAttributes: b.validateAttributes,
        ...(b.trusted && b.spec.validate !== undefined ? { validate: b.spec.validate } : {}),
        fallbackText: trusted ? b.spec.fallbackText : (node: LessonNode) => `[${node.type}]`,
      }
    },
  }
}

/** Options for {@link validateCourse}. */
export interface CourseValidationOptions {
  /** Require practice and checkpoint coverage for every skill on the path (agent proposals: false → warnings). */
  readonly requireCoverage: boolean
}

/** Minimum practice items per skill before coverage stops warning. */
export const MIN_PRACTICE_ITEMS = 3

/**
 * Validate a course against the installed plugins.
 * @param course - the course (untrusted; its structure is checked first).
 * @param registry - installed plugins.
 * @param options - strictness.
 * @returns findings; the course is usable when none is an error.
 */
export async function validateCourse(course: CourseSpec, registry: PluginRegistry, options: CourseValidationOptions): Promise<Diagnostic[]> {
  const shape = validateCourseShape(course)
  if (shape.length > 0) return [...shape]
  const out: Diagnostic[] = []
  const err = (code: string, message: string, target?: string): void => {
    out.push({ severity: 'error', code, message, ...(target === undefined ? {} : { target }) })
  }
  const warn = (code: string, message: string, target?: string): void => {
    out.push({ severity: 'warning', code, message, ...(target === undefined ? {} : { target }) })
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(course.id)) err('course/bad-id', `invalid course id ${course.id}`)
  if (!isSemver(course.version)) err('course/version', `course version ${course.version} is not semver`)
  if (course.title.trim() === '') err('course/title', 'course has no title')

  out.push(...validateSkillGraph(course.skills))
  const skillIds = new Set(course.skills.map(s => s.id))
  if (!skillIds.has(course.goal)) err('course/goal', `goal skill ${course.goal} is not in the course`)
  else if (!out.some(d => d.severity === 'error' && d.code.startsWith('graph/'))) {
    const ancestors = new Set<string>()
    const byId = new Map(course.skills.map(s => [s.id, s]))
    const walk = (id: string): void => { for (const r of byId.get(id)?.requires ?? []) if (!ancestors.has(r)) { ancestors.add(r); walk(r) } }
    walk(course.goal)
    for (const s of course.skills) if (s.id !== course.goal && !ancestors.has(s.id)) warn('course/off-path', `skill ${s.id} is not a prerequisite of the goal`, s.id)
  }

  const available = new Set(registry.environments())
  for (const env of course.environments) if (!available.has(env)) err('course/missing-environment', `environment ${env} is not installed`)
  for (const s of course.skills) {
    if (s.environment !== undefined && !course.environments.includes(s.environment)) err('course/skill-environment', `skill ${s.id} uses environment ${s.environment}, which the course does not declare`, s.id)
  }
  if (course.preset !== undefined && registry.preset(course.preset) === undefined) warn('course/unknown-preset', `preset ${course.preset} is not installed; platform defaults apply`)

  const lessons = new Set<string>()
  const blocks = blockLookup(registry)
  for (const lesson of course.lessons) {
    if (lessons.has(lesson.id)) err('course/duplicate-lesson', `duplicate lesson id ${lesson.id}`, lesson.id)
    lessons.add(lesson.id)
    if (!skillIds.has(lesson.skillId)) err('course/lesson-skill', `lesson ${lesson.id} targets unknown skill ${lesson.skillId}`, lesson.id)
    const parsed = parseLesson(lesson.source, blocks, lesson.id)
    out.push(...parsed.diagnostics)
  }

  const itemIds = new Set<string>()
  const practiceBySkill = new Map<string, number>()
  const checkpointBySkill = new Map<string, number>()
  for (const item of course.items) {
    if (itemIds.has(item.id)) err('course/duplicate-item', `duplicate item id ${item.id}`, item.id)
    itemIds.add(item.id)
    for (const s of item.skills) {
      if (!skillIds.has(s.skillId)) err('course/item-skill', `item ${item.id} is tagged with unknown skill ${s.skillId}`, item.id)
      if (item.modes.includes('practice')) practiceBySkill.set(s.skillId, (practiceBySkill.get(s.skillId) ?? 0) + 1)
      if (item.modes.includes('checkpoint')) checkpointBySkill.set(s.skillId, (checkpointBySkill.get(s.skillId) ?? 0) + 1)
    }
    out.push(...await registry.validateItem(item))
  }

  for (const s of course.skills) {
    const practice = practiceBySkill.get(s.id) ?? 0
    const checkpoint = checkpointBySkill.get(s.id) ?? 0
    const report = options.requireCoverage ? err : warn
    if (practice < MIN_PRACTICE_ITEMS) report('course/coverage-practice', `skill ${s.id} has ${practice} practice items (needs ${MIN_PRACTICE_ITEMS})`, s.id)
    if (checkpoint < 1) report('course/coverage-checkpoint', `skill ${s.id} has no checkpoint items`, s.id)
    if (!course.lessons.some(l => l.skillId === s.id)) warn('course/no-lesson', `skill ${s.id} has no lesson`, s.id)
  }
  return out
}
