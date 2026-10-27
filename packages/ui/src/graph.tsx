/**
 * The knowledge-graph tab: everything the tutor taught (and imported notes),
 * as propositions and the reasoning chains between them.
 *
 * - Map: propositions grouped by the session that first taught them; arrows
 *   run from premises to conclusions, through a junction when several
 *   premises are used together. Click to read a proposition; select several
 *   to practise them.
 * - Chains: the stored arguments as lines, with their members selectable.
 * - Sources: sessions and notes that contributed, removable.
 * - Import: notes in any text format, through the same extraction.
 */
import { useEffect, useRef, useState } from 'react'
import type { GraphProposition, GraphSnapshot } from '@hodos/core'
import { api, currentChat, errorText } from './api.js'
import { convexHull, forceLayout, type Positions } from './graph-layout.js'
import { Polled, usePolled } from './store.js'

const graphResource = new Polled<GraphSnapshot>(() => api.graph(), 10_000)

type Tab = 'map' | 'chains' | 'sources' | 'import'

function chainText(premises: readonly string[], conclusion: string, names: ReadonlyMap<string, string>): string {
  return `${premises.map(p => names.get(p) ?? p).join(' + ')} → ${names.get(conclusion) ?? conclusion}`
}

interface MapProps {
  readonly graph: GraphSnapshot
  readonly selected: ReadonlySet<string>
  readonly focus: string | null
  readonly onFocus: (id: string | null) => void
  readonly onToggle: (id: string) => void
  readonly query: string
}

interface View { readonly x: number; readonly y: number; readonly w: number }

/** Recent layouts by graph contents: polling returns a new snapshot each time, but the layout only changes with the graph. */
const layouts = new Map<string, Positions>()

function layoutOf(graph: GraphSnapshot): Positions {
  const signature = `${graph.propositions.map(p => `${p.id}:${p.provenance[0]?.sourceId ?? ''}`).join(',')}|${graph.edges.map(e => `${e.from}>${e.to}`).join(',')}`
  const known = layouts.get(signature)
  if (known !== undefined) return known
  const groups = new Map(graph.propositions.map(p => [p.id, p.provenance[0]?.sourceId ?? '']))
  const nodes = [
    ...graph.propositions.map(p => ({ id: p.id, group: groups.get(p.id) ?? '' })),
    ...graph.implications.map(i => ({ id: i.id, group: groups.get(i.conclusion) ?? '' })),
  ]
  const positions = forceLayout(nodes, graph.edges, 1000)
  if (layouts.size >= 4) layouts.delete(layouts.keys().next().value ?? '')
  layouts.set(signature, positions)
  return positions
}

/** A square view around every position, with a margin. */
function fit(layout: Positions): View {
  const pts = [...layout.values()]
  if (pts.length === 0) return { x: -500, y: -500, w: 1000 }
  const xs = pts.map(p => p.x)
  const ys = pts.map(p => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const side = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 200) * 1.35
  return { x: (minX + Math.max(...xs)) / 2 - side / 2, y: (minY + Math.max(...ys)) / 2 - side / 2, w: side }
}

function GraphMap(props: MapProps): React.ReactElement {
  const { graph } = props
  const layout = layoutOf(graph)
  const [chosen, setChosen] = useState<View | null>(null)
  const view = chosen ?? fit(layout)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const svg = useRef<SVGSVGElement | null>(null)
  const [pixels, setPixels] = useState(440)
  useEffect(() => {
    const el = svg.current
    if (el === null) return undefined
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect
      if (box !== undefined && box.width > 0) setPixels(Math.min(box.width, box.height))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const query = props.query.trim().toLowerCase()
  const matches = (p: GraphProposition): boolean => query !== '' && `${p.name} ${p.statement}`.toLowerCase().includes(query)
  const degree = new Map<string, number>()
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  const junctions = new Set(graph.implications.map(i => i.id))
  // Sizes are given in screen pixels and converted to the current zoom, so labels stay readable.
  const unit = view.w / pixels
  const radius = (id: string): number => unit * (5 + Math.min(5, degree.get(id) ?? 0))
  const showLabels = graph.propositions.length <= 40 || unit < 2.5
  const toWorld = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = svg.current?.getBoundingClientRect()
    if (rect === undefined) return { x: 0, y: 0 }
    const side = Math.min(rect.width, rect.height)
    return { x: view.x + ((event.clientX - rect.left - (rect.width - side) / 2) / side) * view.w, y: view.y + ((event.clientY - rect.top - (rect.height - side) / 2) / side) * view.w }
  }
  return (
    <div className="graph-canvas">
      <svg
        ref={svg}
        className="graph-map"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.w}`}
        aria-hidden="true"
        onWheel={e => {
          const at = toWorld(e)
          const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
          const w = Math.min(20_000, Math.max(100, view.w * factor))
          setChosen({ x: at.x - ((at.x - view.x) * w) / view.w, y: at.y - ((at.y - view.y) * w) / view.w, w })
        }}
        onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y } }}
        onPointerMove={e => {
          const d = drag.current
          const rect = svg.current?.getBoundingClientRect()
          if (d === null || rect === undefined) return
          const side = Math.min(rect.width, rect.height)
          setChosen({ ...view, x: d.vx - ((e.clientX - d.x) / side) * view.w, y: d.vy - ((e.clientY - d.y) / side) * view.w })
        }}
        onPointerUp={() => { drag.current = null }}
        onPointerLeave={() => { drag.current = null }}
      >
        <defs>
          <marker id="kg-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="kg-arrowhead" />
          </marker>
        </defs>
        {graph.clusters.map(c => {
          const pts = c.members.flatMap(m => {
            const p = layout.get(m)
            return p === undefined ? [] : [p]
          })
          const hull = convexHull(pts)
          if (hull.length < 3) return null
          const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
          const top = Math.min(...pts.map(p => p.y))
          return (
            <g key={c.sourceId} className="kg-cluster">
              <polygon className="kg-hull" points={hull.map(p => `${p.x},${p.y}`).join(' ')} strokeWidth={unit * 28} />
              <text x={cx} y={top - unit * 26} textAnchor="middle" fontSize={unit * 12}>{c.label}</text>
            </g>
          )
        })}
        {graph.edges.map(e => {
          const a = layout.get(e.from)
          const b = layout.get(e.to)
          if (a === undefined || b === undefined) return null
          const toJunction = junctions.has(e.to)
          const r = toJunction ? unit * 2 : radius(e.to) + unit * 2
          const len = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y))
          return <line key={`${e.from}>${e.to}`} className={`kg-edge${toJunction ? ' to-junction' : ''}`} strokeWidth={unit * 1.2} x1={a.x} y1={a.y} x2={b.x - ((b.x - a.x) / len) * r} y2={b.y - ((b.y - a.y) / len) * r} {...(toJunction ? {} : { markerEnd: 'url(#kg-arrow)' })} />
        })}
        {graph.implications.map(i => {
          const p = layout.get(i.id)
          return p === undefined ? null : <circle key={i.id} className="kg-junction" cx={p.x} cy={p.y} r={unit * 2.5}><title>{i.line}</title></circle>
        })}
        {graph.propositions.map(p => {
          const at = layout.get(p.id)
          if (at === undefined) return null
          const r = radius(p.id)
          const cls = ['kg-node', props.selected.has(p.id) ? 'selected' : '', props.focus === p.id ? 'focused' : '', matches(p) ? 'match' : ''].filter(Boolean).join(' ')
          return (
            <g
              key={p.id}
              className={cls}
              transform={`translate(${at.x} ${at.y})`}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => (e.shiftKey || e.metaKey || e.ctrlKey ? props.onToggle(p.id) : props.onFocus(p.id))}
            >
              <circle r={r} strokeWidth={unit * 2} />
              {(showLabels || props.focus === p.id || props.selected.has(p.id) || matches(p)) && <text y={-r - unit * 5} textAnchor="middle" fontSize={unit * 12} strokeWidth={unit * 3}>{p.name}</text>}
              <title>{`${p.name}: ${p.statement}`}</title>
            </g>
          )
        })}
      </svg>
      <div className="graph-tools">
        <button type="button" onClick={() => setChosen(null)}>Fit</button>
        <button type="button" onClick={() => setChosen({ x: view.x + view.w * 0.15, y: view.y + view.w * 0.15, w: view.w * 0.7 })}>Zoom in</button>
        <button type="button" onClick={() => setChosen({ x: view.x - view.w * 0.2, y: view.y - view.w * 0.2, w: view.w * 1.4 })}>Zoom out</button>
      </div>
    </div>
  )
}

function Detail(props: { readonly graph: GraphSnapshot; readonly id: string; readonly selected: boolean; readonly onToggle: () => void; readonly onDeleted: () => void }): React.ReactElement | null {
  const p = props.graph.propositions.find(x => x.id === props.id)
  const [error, setError] = useState<string | null>(null)
  if (p === undefined) return null
  const names = new Map(props.graph.propositions.map(x => [x.id, x.name]))
  const titles = new Map(props.graph.sources.map(s => [s.id, s.title]))
  const derivations = props.graph.chains.filter(c => c.conclusion === p.id)
  const uses = props.graph.chains.filter(c => c.premises.includes(p.id))
  const sources = [...new Set(p.provenance.map(q => q.sourceId))]
  const remove = async (): Promise<void> => {
    if (!window.confirm(`Delete "${p.name}" and every argument that uses it?`)) return
    try {
      await api.deleteProposition(p.id)
      props.onDeleted()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <aside className="card kg-detail" aria-labelledby="kg-detail-title">
      <h2 id="kg-detail-title">{p.name}</h2>
      <p>{p.statement}</p>
      {p.aliases.length > 0 && <details><summary>Also said as</summary><ul>{p.aliases.map(a => <li key={a}>{a}</li>)}</ul></details>}
      {derivations.length > 0 && <><h3>Follows from</h3><ul>{derivations.map(c => <li key={c.id}>{chainText(c.premises, c.conclusion, names)}</li>)}</ul></>}
      {uses.length > 0 && <><h3>Used in</h3><ul>{uses.map(c => <li key={c.id}>{chainText(c.premises, c.conclusion, names)}</li>)}</ul></>}
      <p className="muted">From: {sources.map(s => titles.get(s) ?? 'a removed source').join('; ')}</p>
      {error !== null && <p className="error" role="alert">{error}</p>}
      <div className="controls">
        <button type="button" onClick={props.onToggle}>{props.selected ? 'Unselect' : 'Select for practice'}</button>
        <button type="button" onClick={() => { void remove() }}>Delete</button>
      </div>
    </aside>
  )
}

function Sources(props: { readonly graph: GraphSnapshot; readonly onChange: () => void }): React.ReactElement {
  const [error, setError] = useState<string | null>(null)
  const remove = async (id: string, mode: 'preserve-graph' | 'delete-nodes'): Promise<void> => {
    const what = mode === 'delete-nodes' ? 'Remove this source and every proposition only it taught?' : 'Forget this source but keep what it taught?'
    if (!window.confirm(what)) return
    try {
      await api.removeSource(id, mode)
      props.onChange()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <section className="card">
      <h2>Sources</h2>
      {props.graph.sources.length === 0 && <p className="muted">Nothing yet: learn something, or import notes.</p>}
      <ul className="sources">
        {props.graph.sources.map(s => (
          <li key={s.id}>
            <span><strong>{s.title}</strong> <span className="muted">({s.kind === 'notes' ? 'notes' : 'session'})</span></span>
            <span className="controls">
              <button type="button" onClick={() => { void remove(s.id, 'preserve-graph') }}>Forget source</button>
              <button type="button" onClick={() => { void remove(s.id, 'delete-nodes') }}>Remove with its propositions</button>
            </span>
          </li>
        ))}
      </ul>
      {error !== null && <p className="error" role="alert">{error}</p>}
    </section>
  )
}

function ImportNotes(props: { readonly model: boolean }): React.ReactElement {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    try {
      await api.importNotes(title, text)
      setStatus('Importing in the background; the map updates as propositions are found.')
      setText('')
    } catch (e) {
      setStatus(errorText(e))
    }
  }
  return (
    <section className="card">
      <h2>Import notes</h2>
      <p className="muted">Paste notes in any text format. They go through the same extraction as your sessions; nothing is checked for accuracy.</p>
      {!props.model && <p className="notice">No model is available for background work in this harness, so notes cannot be imported.</p>}
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        <label className="field"><span>Title</span><input value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label className="field"><span>Notes</span><textarea value={text} onChange={e => setText(e.target.value)} rows={10} /></label>
        <button type="submit" className="primary" disabled={!props.model || title.trim() === '' || text.trim() === ''}>Import</button>
      </form>
      {status !== null && <output className="notice">{status}</output>}
    </section>
  )
}

/** The knowledge-graph tab. */
export function GraphView(props: { readonly model: boolean; readonly chatIsSession: boolean }): React.ReactElement {
  const snap = usePolled(graphResource)
  const [tab, setTab] = useState<Tab>('map')
  const [focus, setFocus] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const graph = snap.data
  const toggle = (id: string): void => setSelected(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const practise = async (): Promise<void> => {
    if (currentChat() === '' || props.chatIsSession) {
      setNotice('Open a new chat and its Knowledge graph tab to practise there; this chat is already a Hodos session.')
      return
    }
    try {
      await api.startPractice([...selected])
      setNotice('Practice started in this chat: switch to the Hodos tab for the problems.')
      setSelected(new Set())
    } catch (e) {
      setNotice(errorText(e))
    }
  }
  if (graph === null) return <p className="muted">{snap.error ?? 'Loading your knowledge graph…'}</p>
  const names = new Map(graph.propositions.map(p => [p.id, p.name]))
  return (
    <div className="graph-view">
      <header className="graph-head">
        <h1>Knowledge graph</h1>
        <p className="muted">{graph.propositions.length} propositions, {graph.chains.length} arguments, from {graph.sources.length} source(s). Shift-click to select.</p>
        <div role="tablist" className="tabs">
          {(['map', 'chains', 'sources', 'import'] as const).map(t => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0]?.toUpperCase()}{t.slice(1)}</button>
          ))}
        </div>
      </header>
      {selected.size > 0 && (
        <div className="selection-bar">
          <span>{selected.size} selected</span>
          <button type="button" className="primary" onClick={() => { void practise() }}>Practise selected</button>
          <button type="button" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {notice !== null && <output className="notice">{notice}</output>}
      {tab === 'map' && (
        <>
          <label className="field search"><span className="sr-only">Find a proposition</span><input type="search" placeholder="Find…" value={query} onChange={e => setQuery(e.target.value)} /></label>
          {graph.propositions.length === 0
            ? <p className="muted">Your graph fills in as your tutor teaches: after each turn, Hodos extracts the ideas it taught and how they follow from each other.</p>
            : <GraphMap graph={graph} selected={selected} focus={focus} onFocus={setFocus} onToggle={toggle} query={query} />}
          {focus !== null && <Detail graph={graph} id={focus} selected={selected.has(focus)} onToggle={() => toggle(focus)} onDeleted={() => { setFocus(null); void graphResource.refresh() }} />}
          <details className="card">
            <summary><h2>All propositions</h2></summary>
            <ul className="kg-list">
              {graph.propositions.map(p => (
                <li key={p.id}>
                  <label><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /> <button type="button" className="link" onClick={() => setFocus(p.id)}>{p.name}</button></label>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {tab === 'chains' && (
        <section className="card">
          <h2>Arguments</h2>
          {graph.chains.length === 0 && <p className="muted">No arguments yet.</p>}
          <ul className="kg-chains">
            {graph.chains.map(c => {
              const members = [...c.premises, c.conclusion]
              const all = members.every(m => selected.has(m))
              return (
                <li key={c.id}>
                  <label>
                    <input type="checkbox" checked={all} onChange={() => setSelected(prev => {
                      const next = new Set(prev)
                      for (const m of members) if (all) next.delete(m)
                      else next.add(m)
                      return next
                    })} />
                    {' '}{chainText(c.premises, c.conclusion, names)}
                  </label>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {tab === 'sources' && <Sources graph={graph} onChange={() => { void graphResource.refresh() }} />}
      {tab === 'import' && <ImportNotes model={props.model} />}
    </div>
  )
}
