/**
 * The plan map: the session's dependency graph, drawn top-down in layers
 * (prerequisites above what they enable), with where the lesson stands
 * (current, visited, upcoming) and Hodos's mastery estimate per node.
 */
import type { NodeMasteryView, PlanView } from '@hodos/core'

const NODE_W = 150
const NODE_H = 46
const GAP_X = 18
const GAP_Y = 44
const PAD = 12
const LINE_CHARS = 22

/** Split a title into at most two lines. */
function lines(title: string): string[] {
  if (title.length <= LINE_CHARS) return [title]
  const words = title.split(/\s+/u)
  let first = ''
  let i = 0
  while (i < words.length && `${first} ${words[i] ?? ''}`.trim().length <= LINE_CHARS) {
    first = `${first} ${words[i] ?? ''}`.trim()
    i += 1
  }
  if (first === '') return [`${title.slice(0, LINE_CHARS - 1)}…`]
  const rest = words.slice(i).join(' ')
  return [first, rest.length > LINE_CHARS ? `${rest.slice(0, LINE_CHARS - 1)}…` : rest]
}

/** Layer index of each node: its longest distance from a root. */
function layers(plan: PlanView): Map<string, number> {
  const incoming = new Map<string, string[]>(plan.nodes.map(n => [n.id, []]))
  for (const e of plan.edges) incoming.get(e.to)?.push(e.from)
  const depth = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const d = Math.max(-1, ...(incoming.get(id) ?? []).map(p => visit(p, seen))) + 1
    depth.set(id, d)
    return d
  }
  for (const n of plan.nodes) visit(n.id, new Set())
  return depth
}

/** Positions of nodes: layers top-down, ordered within a layer by their parents' positions. */
function layout(plan: PlanView): { pos: Map<string, { x: number; y: number }>; width: number; height: number } {
  const depth = layers(plan)
  const rows: string[][] = []
  for (const n of plan.nodes) {
    const d = depth.get(n.id) ?? 0
    rows[d] = [...(rows[d] ?? []), n.id]
  }
  const parents = new Map<string, string[]>(plan.nodes.map(n => [n.id, []]))
  for (const e of plan.edges) parents.get(e.to)?.push(e.from)
  const column = new Map<string, number>()
  rows.forEach((row, r) => {
    if (r > 0) {
      const center = (id: string): number => {
        const ps = (parents.get(id) ?? []).map(p => column.get(p) ?? 0)
        return ps.length === 0 ? Number.POSITIVE_INFINITY : ps.reduce((a, b) => a + b, 0) / ps.length
      }
      row.sort((a, b) => center(a) - center(b))
    }
    row.forEach((id, c) => column.set(id, c))
  })
  const widest = Math.max(1, ...rows.map(r => r.length))
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X
  const pos = new Map<string, { x: number; y: number }>()
  rows.forEach((row, r) => {
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X
    const start = (width - rowWidth) / 2
    row.forEach((id, c) => pos.set(id, { x: start + c * (NODE_W + GAP_X), y: PAD + r * (NODE_H + GAP_Y) }))
  })
  return { pos, width, height: PAD * 2 + rows.length * NODE_H + (rows.length - 1) * GAP_Y }
}

const STATUS_LABEL: Readonly<Record<string, string>> = { current: 'current', visited: 'visited', upcoming: 'upcoming' }

/**
 * The plan map.
 * @param props - the plan and the mastery estimates.
 * @returns an SVG figure with a text list for screen readers.
 */
export function PlanMap(props: { readonly plan: PlanView; readonly mastery: readonly NodeMasteryView[] }): React.ReactElement {
  const { plan } = props
  const { pos, width, height } = layout(plan)
  const mastery = new Map(props.mastery.map(m => [m.nodeId, m]))
  return (
    <figure className="plan-map">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
        <defs>
          <marker id="plan-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="plan-arrowhead" />
          </marker>
        </defs>
        {plan.edges.map(e => {
          const a = pos.get(e.from)
          const b = pos.get(e.to)
          if (a === undefined || b === undefined) return null
          const x1 = a.x + NODE_W / 2
          const y1 = a.y + NODE_H
          const x2 = b.x + NODE_W / 2
          const y2 = b.y - 2
          const mid = (y1 + y2) / 2
          return <path key={`${e.from}-${e.to}`} className="plan-edge" d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`} markerEnd="url(#plan-arrow)" />
        })}
        {plan.nodes.map(n => {
          const p = pos.get(n.id)
          if (p === undefined) return null
          const status = plan.statuses[n.id] ?? 'upcoming'
          const m = mastery.get(n.id)
          const text = lines(n.title)
          return (
            <g key={n.id} className={`plan-node status-${status}${m?.mastered === true ? ' mastered' : ''}`} transform={`translate(${p.x} ${p.y})`}>
              <title>{`${n.title} (${STATUS_LABEL[status] ?? status}${m === undefined ? '' : `, mastery ${Math.round(m.pMastered * 100)}%`})`}</title>
              <rect width={NODE_W} height={NODE_H} rx="8" />
              {text.map((t, i) => <text key={t} x={NODE_W / 2} y={text.length === 1 ? NODE_H / 2 + 4 : 18 + i * 15} textAnchor="middle">{t}</text>)}
              {m !== undefined && <rect className="mastery-bar" x="8" y={NODE_H - 6} width={(NODE_W - 16) * m.pMastered} height="3" rx="1.5" />}
            </g>
          )
        })}
      </svg>
      <figcaption className="sr-only">
        Plan map:
        <ol>
          {plan.nodes.map(n => <li key={n.id}>{n.title}: {STATUS_LABEL[plan.statuses[n.id] ?? 'upcoming']}{mastery.get(n.id)?.mastered === true ? ', mastered' : ''}</li>)}
        </ol>
      </figcaption>
    </figure>
  )
}
