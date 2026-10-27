/**
 * The plan map of a learning session: the dependency graph from what the
 * learner already understands to the goal, written by the teacher as a small
 * mermaid graph and shown live to the learner.
 *
 * The teacher writes mermaid because models write it fluently; Hodos parses a
 * strict subset by hand (no mermaid runtime on the server) and reports every
 * problem with its line number so the teacher can fix the map and retry.
 *
 *   graph TD | flowchart LR | … (optional header; direction is ignored)
 *   %% comment
 *   id                      a node titled by its id
 *   id[Title]  id(Title)  id("Title")
 *   a --> b                 a must be understood before b (also ==>, -.->)
 *   a --> b --> c           chains expand to pairs
 *
 * Ids are permanent lowercase slugs (`chain-rule`, `mps_translation`):
 * questions name the node they are about by id, and where the lesson stands
 * is derived from those tags, never stored.
 * @module @hodos/core/learn/plan
 */

/** One node of the plan map. */
export interface PlanNode {
  readonly id: string
  readonly title: string
}

/** `from` must be understood before `to`. */
export interface PlanEdge {
  readonly from: string
  readonly to: string
}

/** A validated plan map: a non-empty DAG. */
export interface PlanTree {
  readonly nodes: readonly PlanNode[]
  readonly edges: readonly PlanEdge[]
}

/** Where a node stands in the lesson, derived from the questions asked so far. */
export type PlanNodeStatus = 'current' | 'visited' | 'upcoming'

/** Size limits that keep the map a map rather than a syllabus. */
export const PLAN_LIMITS = { maxNodes: 30, maxTitleChars: 120, maxSourceChars: 8000 } as const

/** A permanent node id. */
export const PLAN_NODE_ID = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/

const HEADER = /^(?:graph|flowchart)(?:\s+(?:td|tb|lr|rl|bt))?\s*;?$/i
const ARROW = /\s*(?:-->|==>|-\.->)\s*/
/** An endpoint: an id candidate (anything but brackets and whitespace) and an optional label. */
const ENDPOINT = /^([^\s[\]()"]+)\s*(?:\[\s*(.*?)\s*\]|\(\s*(.*?)\s*\))?$/

/** The result of parsing a plan. */
export type PlanParseResult =
  | { readonly ok: true; readonly plan: PlanTree }
  | { readonly ok: false; readonly problems: readonly string[] }

function unquote(title: string): string {
  const t = title.trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t
}

/** Strip a surrounding ```mermaid fence, which models often add. */
function unfence(source: string): string {
  const fenced = /^\s*```[a-z]*\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(source)
  return fenced?.[1] ?? source
}

/**
 * Parse and validate a plan map.
 * @param source - the mermaid subset described in the module comment.
 * @returns the plan, or every problem found, each prefixed with its line number.
 */
export function parsePlan(source: string): PlanParseResult {
  if (source.length > PLAN_LIMITS.maxSourceChars) return { ok: false, problems: [`the plan is longer than ${PLAN_LIMITS.maxSourceChars} characters; a map needs far less`] }
  const problems: string[] = []
  const titles = new Map<string, string>()
  const order: string[] = []
  const edges = new Map<string, PlanEdge>()

  const endpoint = (raw: string, line: number): string | null => {
    const m = ENDPOINT.exec(raw.trim())
    if (m === null) {
      problems.push(`line ${line}: "${raw.trim()}" is not a node; write id, id[Title] or id("Title")`)
      return null
    }
    const id = m[1] ?? ''
    if (!PLAN_NODE_ID.test(id)) {
      problems.push(`line ${line}: node id "${id}" must be lowercase letters and digits, joined by - or _ (for example chain-rule)`)
      return null
    }
    const label = m[2] ?? m[3]
    if (!titles.has(id)) order.push(id)
    if (label !== undefined && label !== '' && (titles.get(id) ?? '') === '') {
      const title = unquote(label)
      if (title.length > PLAN_LIMITS.maxTitleChars) problems.push(`line ${line}: the title of "${id}" is longer than ${PLAN_LIMITS.maxTitleChars} characters`)
      titles.set(id, title)
    } else if (!titles.has(id)) {
      titles.set(id, '')
    }
    return id
  }

  const lines = unfence(source).split('\n')
  let sawContent = false
  lines.forEach((rawLine, index) => {
    const n = index + 1
    const text = rawLine.trim().replace(/;$/u, '').trim()
    if (text === '' || text.startsWith('%%')) return
    if (!sawContent && HEADER.test(text)) {
      sawContent = true
      return
    }
    sawContent = true
    if (/^(?:subgraph|end|style|classDef|class|click|linkStyle)\b/i.test(text)) {
      problems.push(`line ${n}: "${text.split(/\s/u)[0] ?? ''}" is not supported; use only nodes and --> edges`)
      return
    }
    const parts = text.split(ARROW)
    if (parts.some(p => p.trim() === '')) {
      problems.push(`line ${n}: an arrow needs a node on both sides`)
      return
    }
    const ids = parts.map(p => endpoint(p, n))
    for (let i = 0; i + 1 < ids.length; i += 1) {
      const from = ids[i]
      const to = ids[i + 1]
      if (from === null || to === null || from === undefined || to === undefined) continue
      if (from === to) {
        problems.push(`line ${n}: "${from}" cannot depend on itself`)
        continue
      }
      edges.set(`${from}\u0000${to}`, { from, to })
    }
  })

  if (order.length === 0 && problems.length === 0) problems.push('the plan has no nodes')
  if (order.length > PLAN_LIMITS.maxNodes) problems.push(`the plan has ${order.length} nodes; keep it to ${PLAN_LIMITS.maxNodes} or fewer (a map, not a syllabus)`)
  if (problems.length > 0) return { ok: false, problems }

  const plan: PlanTree = {
    nodes: order.map(id => ({ id, title: titles.get(id) === '' ? id : titles.get(id) ?? id })),
    edges: [...edges.values()],
  }
  const cycle = findCycle(plan)
  if (cycle !== null) return { ok: false, problems: [`the plan has a cycle: ${cycle.join(' --> ')}; a node cannot depend on itself through others`] }
  return { ok: true, plan }
}

/**
 * Find a dependency cycle.
 * @param plan - nodes and edges.
 * @returns the cycle as a closed path of ids, or null when the graph is a DAG.
 */
export function findCycle(plan: PlanTree): string[] | null {
  const out = new Map<string, string[]>(plan.nodes.map(n => [n.id, []]))
  for (const e of plan.edges) out.get(e.from)?.push(e.to)
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 'open')
    stack.push(id)
    for (const next of out.get(id) ?? []) {
      if (state.get(next) === 'open') return [...stack.slice(stack.indexOf(next)), next]
      if (state.get(next) === undefined) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const n of plan.nodes) {
    if (state.get(n.id) !== undefined) continue
    const found = visit(n.id)
    if (found !== null) return found
  }
  return null
}

/**
 * Node ids in dependency order (prerequisites first; ties keep the authored order).
 * @param plan - a validated plan.
 * @returns every node id once.
 */
export function topologicalOrder(plan: PlanTree): string[] {
  const indegree = new Map(plan.nodes.map(n => [n.id, 0]))
  for (const e of plan.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
  const position = new Map(plan.nodes.map((n, i) => [n.id, i]))
  const ready = plan.nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id)
  const order: string[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
    const id = ready.shift()
    if (id === undefined) break
    order.push(id)
    for (const e of plan.edges) {
      if (e.from !== id) continue
      const left = (indegree.get(e.to) ?? 0) - 1
      indegree.set(e.to, left)
      if (left === 0) ready.push(e.to)
    }
  }
  return order
}

/**
 * Where each node stands, derived from the plan nodes that questions were
 * about, in asking order: the latest is current, earlier ones are visited,
 * the rest are upcoming. Answers move nothing; the teacher moving on is the
 * judgment that a node is finished.
 * @param plan - the plan map.
 * @param tagged - plan node ids of the questions asked, oldest first.
 * @returns a status for every node of the plan.
 */
export function planStatuses(plan: PlanTree, tagged: readonly string[]): Record<string, PlanNodeStatus> {
  const known = new Set(plan.nodes.map(n => n.id))
  const asked = tagged.filter(id => known.has(id))
  const current = asked.at(-1)
  const statuses: Record<string, PlanNodeStatus> = {}
  for (const n of plan.nodes) statuses[n.id] = n.id === current ? 'current' : asked.includes(n.id) ? 'visited' : 'upcoming'
  return statuses
}

/**
 * The plan as mermaid source, for showing it back to the teacher or exporting it.
 * Titles are quoted; a double quote inside a title becomes a single quote.
 * @param plan - a validated plan.
 * @returns a `graph TD` block.
 */
export function planToMermaid(plan: PlanTree): string {
  const lines = ['graph TD', ...plan.nodes.map(n => `  ${n.id}["${n.title.replaceAll('"', "'")}"]`), ...plan.edges.map(e => `  ${e.from} --> ${e.to}`)]
  return lines.join('\n')
}
