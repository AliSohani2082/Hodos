/**
 * The skill graph: a validated directed acyclic graph of skills with
 * prerequisite edges, plus the queries the protocol needs (ancestors,
 * frontier, path planning).
 * @module @hodos/core/graph
 */
import { SKILL_ID_PATTERN, SKILL_KINDS, type Diagnostic, type SkillKind, type SkillSpec } from '@hodos/plugin-sdk'
import { HodosError } from '../errors.js'

/** Upper bound on graph size accepted from content or agents. */
export const MAX_GRAPH_SKILLS = 500

/**
 * Validate skill specifications as a prerequisite graph.
 * @param skills - candidate skills (untrusted).
 * @returns findings: duplicate ids, bad ids or kinds, unknown prerequisites,
 *   self-loops and cycles (with the cycle path), and oversized graphs.
 */
export function validateSkillGraph(skills: readonly SkillSpec[]): Diagnostic[] {
  const out: Diagnostic[] = []
  if (skills.length === 0) out.push({ severity: 'error', code: 'graph/empty', message: 'the graph has no skills' })
  if (skills.length > MAX_GRAPH_SKILLS) {
    out.push({ severity: 'error', code: 'graph/too-large', message: `the graph has ${skills.length} skills; the limit is ${MAX_GRAPH_SKILLS}` })
  }
  const ids = new Set<string>()
  for (const [index, skill] of skills.entries()) {
    const path = `/skills/${index}`
    if (typeof skill.id !== 'string' || !SKILL_ID_PATTERN.test(skill.id)) {
      out.push({ severity: 'error', code: 'graph/bad-id', message: `invalid skill id ${JSON.stringify(skill.id)}`, path })
      continue
    }
    if (ids.has(skill.id)) out.push({ severity: 'error', code: 'graph/duplicate', message: `duplicate skill id ${skill.id}`, path, target: skill.id })
    ids.add(skill.id)
    if (!SKILL_KINDS.includes(skill.kind)) {
      out.push({ severity: 'error', code: 'graph/bad-kind', message: `skill ${skill.id} has unknown kind ${JSON.stringify(skill.kind)}`, path, target: skill.id })
    }
    if (typeof skill.title !== 'string' || skill.title.trim() === '') {
      out.push({ severity: 'error', code: 'graph/no-title', message: `skill ${skill.id} has no title`, path, target: skill.id })
    }
  }
  for (const [index, skill] of skills.entries()) {
    for (const req of skill.requires ?? []) {
      if (req === skill.id) {
        out.push({ severity: 'error', code: 'graph/self-loop', message: `skill ${skill.id} requires itself`, path: `/skills/${index}/requires`, target: skill.id })
      } else if (!ids.has(req)) {
        out.push({ severity: 'error', code: 'graph/unknown-prerequisite', message: `skill ${skill.id} requires unknown skill ${req}`, path: `/skills/${index}/requires`, target: skill.id })
      }
    }
  }
  const cycle = findCycle(skills)
  if (cycle !== null) {
    out.push({ severity: 'error', code: 'graph/cycle', message: `prerequisites form a cycle: ${cycle.join(' -> ')}`, target: cycle[0] })
  }
  return out
}

/** Return one cycle as a list of ids (first id repeated at the end), or null. */
function findCycle(skills: readonly SkillSpec[]): string[] | null {
  const requires = new Map(skills.map(s => [s.id, (s.requires ?? []).filter(r => r !== s.id)]))
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const next of requires.get(id) ?? []) {
      if (!requires.has(next)) continue
      const s = state.get(next) ?? 0
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next]
      if (s === 0) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const s of skills) {
    if ((state.get(s.id) ?? 0) === 0) {
      const found = visit(s.id)
      if (found !== null) return found
    }
  }
  return null
}

/** An immutable, validated skill graph. */
export class SkillGraph {
  private readonly byId: ReadonlyMap<string, SkillSpec>
  private readonly childrenOf: ReadonlyMap<string, readonly string[]>
  private readonly order: readonly string[]

  /**
   * @param skills - skill specifications; validated on construction.
   * @throws {HodosError} `INVALID_INPUT` listing every finding when invalid.
   */
  constructor(skills: readonly SkillSpec[]) {
    const findings = validateSkillGraph(skills).filter(d => d.severity === 'error')
    if (findings.length > 0) {
      throw new HodosError('INVALID_INPUT', `invalid skill graph: ${findings.map(f => f.message).join('; ')}`)
    }
    this.byId = new Map(skills.map(s => [s.id, s]))
    const children = new Map<string, string[]>(skills.map(s => [s.id, []]))
    for (const s of skills) for (const r of s.requires ?? []) children.get(r)?.push(s.id)
    this.childrenOf = children
    this.order = topologicalOrder(skills)
  }

  /** All skills in a deterministic topological order (prerequisites first). */
  get skills(): readonly SkillSpec[] {
    return this.order.map(id => this.get(id))
  }

  /** Number of skills. */
  get size(): number {
    return this.byId.size
  }

  /**
   * Look up a skill.
   * @param id - skill id.
   * @returns the skill.
   * @throws {HodosError} `NOT_FOUND` for an unknown id.
   */
  get(id: string): SkillSpec {
    const skill = this.byId.get(id)
    if (skill === undefined) throw new HodosError('NOT_FOUND', `unknown skill ${id}`)
    return skill
  }

  /** @param id - skill id. @returns whether the graph contains it. */
  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** @param id - skill id. @returns its kind. */
  kindOf(id: string): SkillKind {
    return this.get(id).kind
  }

  /** @param id - skill id. @returns direct prerequisites. */
  prerequisites(id: string): readonly string[] {
    return this.get(id).requires ?? []
  }

  /** @param id - skill id. @returns skills that directly require it. */
  dependents(id: string): readonly string[] {
    return this.childrenOf.get(id) ?? []
  }

  /**
   * All transitive prerequisites of a skill.
   * @param id - skill id.
   * @returns ancestor ids in topological order, excluding `id`.
   */
  ancestors(id: string): string[] {
    const seen = new Set<string>()
    const walk = (s: string): void => {
      for (const p of this.prerequisites(s)) if (!seen.has(p)) { seen.add(p); walk(p) }
    }
    walk(id)
    return this.order.filter(s => seen.has(s))
  }

  /**
   * All skills that transitively require a skill.
   * @param id - skill id.
   * @returns descendant ids in topological order, excluding `id`.
   */
  descendants(id: string): string[] {
    const seen = new Set<string>()
    const walk = (s: string): void => {
      for (const c of this.dependents(s)) if (!seen.has(c)) { seen.add(c); walk(c) }
    }
    walk(id)
    return this.order.filter(s => seen.has(s))
  }

  /**
   * Depth of a skill: 0 for skills without prerequisites.
   * @param id - skill id.
   * @returns the length of the longest prerequisite chain below it.
   */
  depth(id: string): number {
    const memo = new Map<string, number>()
    const d = (s: string): number => {
      const cached = memo.get(s)
      if (cached !== undefined) return cached
      const value = this.prerequisites(s).reduce((m, p) => Math.max(m, d(p) + 1), 0)
      memo.set(s, value)
      return value
    }
    return d(id)
  }

  /**
   * Skills the learner can work on now: not mastered, with every
   * prerequisite mastered.
   * @param mastered - ids considered mastered.
   * @param scope - restrict to these ids (defaults to all).
   * @returns frontier ids in topological order.
   */
  frontier(mastered: ReadonlySet<string>, scope?: ReadonlySet<string>): string[] {
    return this.order.filter(id =>
      (scope === undefined || scope.has(id))
      && !mastered.has(id)
      && this.prerequisites(id).every(p => mastered.has(p) || (scope !== undefined && !scope.has(p))))
  }

  /**
   * Plan the skills to learn for a goal: the goal and its ancestors minus
   * known skills, in a valid learning order (prerequisites first; skills
   * whose prerequisites are equally satisfied keep their authoring order).
   * @param goal - goal skill id.
   * @param known - ids already mastered or verified by the diagnostic.
   * @returns the ordered path; empty when the goal is already known.
   */
  planPath(goal: string, known: ReadonlySet<string>): string[] {
    const scope = new Set([...this.ancestors(goal), goal])
    return this.order.filter(id => scope.has(id) && !known.has(id))
  }
}

function topologicalOrder(skills: readonly SkillSpec[]): string[] {
  const indegree = new Map(skills.map(s => [s.id, (s.requires ?? []).length]))
  const dependents = new Map<string, string[]>(skills.map(s => [s.id, []]))
  for (const s of skills) for (const r of s.requires ?? []) dependents.get(r)?.push(s.id)
  const position = new Map(skills.map((s, i) => [s.id, i]))
  const ready = skills.filter(s => (s.requires ?? []).length === 0).map(s => s.id)
  const out: string[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
    const next = ready.shift()
    if (next === undefined) break
    out.push(next)
    for (const d of dependents.get(next) ?? []) {
      const left = (indegree.get(d) ?? 0) - 1
      indegree.set(d, left)
      if (left === 0) ready.push(d)
    }
  }
  return out
}
