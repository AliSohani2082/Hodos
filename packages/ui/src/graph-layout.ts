/**
 * Deterministic layout of the knowledge graph: a seeded force simulation
 * (Fruchterman–Reingold) where propositions start near their birth
 * source's sector, so each source's cluster stays together.
 */

/** A node to place. */
export interface LayoutNode {
  readonly id: string
  /** Nodes with the same group start in the same sector. */
  readonly group: string
}

/** Positions by node id, in a square around the origin. */
export type Positions = ReadonlyMap<string, { readonly x: number; readonly y: number }>

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/**
 * Lay out a graph.
 * @param nodes - nodes with their groups.
 * @param edges - undirected springs.
 * @param size - side of the square to fill.
 * @returns positions.
 */
export function forceLayout(nodes: readonly LayoutNode[], edges: ReadonlyArray<{ readonly from: string; readonly to: string }>, size = 1000): Positions {
  const n = nodes.length
  const pos = new Map<string, { x: number; y: number }>()
  if (n === 0) return pos
  const groups = [...new Set(nodes.map(v => v.group))]
  const k = Math.sqrt((size * size) / n) * 0.8
  nodes.forEach(v => {
    const g = groups.indexOf(v.group)
    const angle = (2 * Math.PI * g) / Math.max(1, groups.length) + (hash(v.id) - 0.5) * 0.9
    const radius = groups.length === 1 ? hash(`${v.id}r`) * size * 0.3 : size * (0.18 + hash(`${v.id}r`) * 0.22)
    pos.set(v.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  })
  const springs = edges.filter(e => pos.has(e.from) && pos.has(e.to))
  const iterations = Math.round(Math.min(300, Math.max(40, 40_000_000 / (n * n))))
  let temperature = size / 10
  const ids = nodes.map(v => v.id)
  for (let it = 0; it < iterations; it += 1) {
    const disp = new Map(ids.map(id => [id, { x: 0, y: 0 }]))
    for (let i = 0; i < n; i += 1) {
      const a = pos.get(ids[i] ?? '')
      const da = disp.get(ids[i] ?? '')
      if (a === undefined || da === undefined) continue
      for (let j = i + 1; j < n; j += 1) {
        const b = pos.get(ids[j] ?? '')
        const db = disp.get(ids[j] ?? '')
        if (b === undefined || db === undefined) continue
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dist = Math.max(0.01, Math.hypot(dx, dy))
        const force = (k * k) / dist
        da.x += (dx / dist) * force
        da.y += (dy / dist) * force
        db.x -= (dx / dist) * force
        db.y -= (dy / dist) * force
      }
    }
    for (const e of springs) {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      const da = disp.get(e.from)
      const db = disp.get(e.to)
      if (a === undefined || b === undefined || da === undefined || db === undefined) continue
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.max(0.01, Math.hypot(dx, dy))
      const force = (dist * dist) / k
      da.x -= (dx / dist) * force
      da.y -= (dy / dist) * force
      db.x += (dx / dist) * force
      db.y += (dy / dist) * force
    }
    for (const id of ids) {
      const p = pos.get(id)
      const d = disp.get(id)
      if (p === undefined || d === undefined) continue
      // Gravity keeps disconnected pieces on the canvas.
      d.x -= p.x * 0.01 * k / 10
      d.y -= p.y * 0.01 * k / 10
      const len = Math.max(0.01, Math.hypot(d.x, d.y))
      p.x += (d.x / len) * Math.min(len, temperature)
      p.y += (d.y / len) * Math.min(len, temperature)
    }
    temperature *= 0.97
  }
  return pos
}

function cross(o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/**
 * Convex hull of points (monotone chain).
 * @param points - the points.
 * @returns hull vertices in order.
 */
export function convexHull(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): Array<{ x: number; y: number }> {
  const sorted = points.toSorted((a, b) => a.x - b.x || a.y - b.y).map(p => ({ x: p.x, y: p.y }))
  if (sorted.length < 3) return sorted
  const lower: Array<{ x: number; y: number }> = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2) ?? p, lower.at(-1) ?? p, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Array<{ x: number; y: number }> = []
  for (const p of sorted.toReversed()) {
    while (upper.length >= 2 && cross(upper.at(-2) ?? p, upper.at(-1) ?? p, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}
