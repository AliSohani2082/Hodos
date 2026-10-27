/**
 * The learner's knowledge graph: true propositions and the reasoning chains
 * that derive them, extracted from what the tutor taught and from imported
 * notes. Modelled on LearnHarness's graph.
 *
 * - A **proposition** is one self-contained, true statement with a short
 *   name. It records every place it came up (its provenance).
 * - A **chain** is an argument: premises that jointly entail a conclusion.
 *   Independent arguments for one conclusion are separate chains. Chains
 *   are the stored truth; the arrows drawn on the canvas are derived from
 *   them on every read and never stored.
 *
 * Nothing about the learner enters the graph: no quiz outcomes, no
 * assessments, no "the learner thinks". A misconception enters as its true
 * correction.
 *
 * This module is pure: views, simplification and selection over plain data.
 * @module @hodos/core/knowledge/graph
 */

/** One place a proposition or chain came up: a source and, for sessions, the passage. */
export interface ProvenancePoint {
  /** A learning session id, or a notes source id. */
  readonly sourceId: string
  /** The transcript entry the proposition came from; null for notes and for chains. */
  readonly anchor: number | null
}

/** A proposition of the graph. */
export interface GraphProposition {
  readonly id: string
  /** A short handle, like a glossary headword; not unique. */
  readonly name: string
  /** The proposition at full precision: the identity of the node. */
  readonly statement: string
  /** Other phrasings sources used for it. */
  readonly aliases: readonly string[]
  readonly createdAt: string
  /** Every place it came up, oldest first; the first is its birth source. */
  readonly provenance: readonly ProvenancePoint[]
}

/** A stored reasoning chain. */
export interface GraphChain {
  readonly id: string
  /** Proposition ids that jointly entail the conclusion, sorted. */
  readonly premises: readonly string[]
  readonly conclusion: string
  readonly createdAt: string
  /** Sources that asserted the argument, oldest first. */
  readonly sources: readonly string[]
}

/** A derived, untyped arrow of the canvas. */
export interface GraphEdge {
  readonly from: string
  readonly to: string
}

/** A derived junction: where the premises of a multi-premise chain meet. */
export interface ImplicationNode {
  /** The chain's id. */
  readonly id: string
  readonly premises: readonly string[]
  readonly conclusion: string
  /** The chain as one line of proposition names. */
  readonly line: string
}

/** Propositions born in one source: drawn as a hull, labelled with the source's title. */
export interface GraphCluster {
  readonly sourceId: string
  readonly label: string
  readonly members: readonly string[]
}

/** A source that contributed to the graph. */
export interface GraphSourceInfo {
  readonly id: string
  readonly kind: 'session' | 'notes'
  readonly title: string
}

/** Everything the graph view needs, in one payload. */
export interface GraphSnapshot {
  readonly propositions: readonly GraphProposition[]
  readonly chains: readonly GraphChain[]
  readonly implications: readonly ImplicationNode[]
  /** Canvas arrows: premise → conclusion for single-premise chains, premise → junction → conclusion otherwise. */
  readonly edges: readonly GraphEdge[]
  /** Every chain contracted to premise → conclusion arrows over propositions. */
  readonly logicalEdges: readonly GraphEdge[]
  readonly clusters: readonly GraphCluster[]
  readonly sources: readonly GraphSourceInfo[]
}

/** Clusters smaller than this are not drawn. */
export const MIN_CLUSTER_SIZE = 3

/**
 * The identity of an argument: its sorted premises and its conclusion.
 * @param premises - premise ids.
 * @param conclusion - conclusion id.
 * @returns a stable key.
 */
export function chainKey(premises: readonly string[], conclusion: string): string {
  return `${[...new Set(premises)].toSorted().join('+')}=>${conclusion}`
}

/**
 * Drop redundant derivations, deterministically, per conclusion, keeping the
 * leanest and earliest:
 * - **fewest premises**: a chain whose premises strictly contain a kept
 *   chain's premises adds nothing;
 * - **ancestry cover**: a chain whose every premise is a premise of a kept
 *   chain, or derivable behind one through the full chain set, adds nothing
 *   ([A,B]⇒X and [X,C]⇒Y make [A,B,C]⇒Y redundant).
 * @param chains - all chains.
 * @returns the chains to keep, in input order.
 */
export function simplifyChains<C extends Pick<GraphChain, 'id' | 'premises' | 'conclusion' | 'createdAt'>>(chains: readonly C[]): C[] {
  if (chains.length < 2) return [...chains]
  const premisesOf = new Map<string, Array<readonly string[]>>()
  for (const c of chains) premisesOf.set(c.conclusion, [...(premisesOf.get(c.conclusion) ?? []), c.premises])
  const memo = new Map<string, Set<string>>()
  const ancestry = (id: string, visiting: Set<string>): Set<string> => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const out = new Set<string>()
    if (visiting.has(id)) return out
    visiting.add(id)
    for (const premises of premisesOf.get(id) ?? []) {
      for (const p of premises) {
        out.add(p)
        for (const a of ancestry(p, visiting)) out.add(a)
      }
    }
    visiting.delete(id)
    memo.set(id, out)
    return out
  }
  const byConclusion = new Map<string, C[]>()
  for (const c of chains) byConclusion.set(c.conclusion, [...(byConclusion.get(c.conclusion) ?? []), c])
  const dropped = new Set<string>()
  for (const group of byConclusion.values()) {
    const ordered = group.toSorted((a, b) => a.premises.length - b.premises.length || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const kept: C[] = []
    for (const candidate of ordered) {
      const set = new Set(candidate.premises)
      const redundant = kept.some(k => {
        if (k.premises.every(p => set.has(p))) return true
        const covered = new Set(k.premises)
        for (const p of k.premises) for (const a of ancestry(p, new Set())) covered.add(a)
        return candidate.premises.every(p => covered.has(p))
      })
      if (redundant) dropped.add(candidate.id)
      else kept.push(candidate)
    }
  }
  return chains.filter(c => !dropped.has(c.id))
}

/**
 * A chain as one line: "Premise, Premise → Conclusion".
 * @param chain - the chain.
 * @param names - proposition names by id (unknown ids show as themselves).
 * @returns the line.
 */
export function chainLine(chain: Pick<GraphChain, 'premises' | 'conclusion'>, names: ReadonlyMap<string, string>): string {
  const name = (id: string): string => names.get(id) ?? id
  return chain.premises.length === 0 ? `${name(chain.conclusion)} (no premises)` : `${chain.premises.map(name).join(', ')} → ${name(chain.conclusion)}`
}

/** A chain restricted to a selection; a selected proposition in no surviving chain stands alone. */
export interface SelectedChain {
  /** The chain id, or the proposition id for a proposition that stands alone. */
  readonly id: string
  readonly premises: readonly string[]
  readonly conclusion: string
}

/**
 * The chains a selection of propositions carries: a chain rides along when
 * its conclusion and every premise are selected; a selected proposition in
 * none of them stands alone (no premises).
 * @param selected - selected proposition ids.
 * @param chains - all chains.
 * @returns chains and lone propositions, sorted by id.
 */
export function chainsForSelection(selected: readonly string[], chains: readonly Pick<GraphChain, 'id' | 'premises' | 'conclusion'>[]): SelectedChain[] {
  const set = new Set(selected)
  const chained = new Set<string>()
  const out: SelectedChain[] = []
  for (const c of chains) {
    if (!set.has(c.conclusion) || !c.premises.every(p => set.has(p))) continue
    out.push({ id: c.id, premises: c.premises.toSorted(), conclusion: c.conclusion })
    chained.add(c.conclusion)
    for (const p of c.premises) chained.add(p)
  }
  for (const id of set) if (!chained.has(id)) out.push({ id, premises: [], conclusion: id })
  return out.toSorted((a, b) => a.id.localeCompare(b.id))
}

/**
 * The derived canvas view of propositions and chains. Chains with a missing
 * member are skipped.
 * @param propositions - live propositions.
 * @param chains - live chains.
 * @returns edges, logical edges and implication junctions.
 */
export function deriveView(propositions: readonly GraphProposition[], chains: readonly GraphChain[]): Pick<GraphSnapshot, 'edges' | 'logicalEdges' | 'implications'> {
  const live = new Set(propositions.map(p => p.id))
  const names = new Map(propositions.map(p => [p.id, p.name]))
  const edges: GraphEdge[] = []
  const logicalEdges: GraphEdge[] = []
  const seen = new Set<string>()
  const implications: ImplicationNode[] = []
  for (const c of chains) {
    if (!live.has(c.conclusion) || !c.premises.every(p => live.has(p))) continue
    for (const p of c.premises) {
      const key = `${p}\u0000${c.conclusion}`
      if (!seen.has(key)) {
        seen.add(key)
        logicalEdges.push({ from: p, to: c.conclusion })
      }
    }
    const [only] = c.premises
    if (c.premises.length === 1 && only !== undefined) {
      edges.push({ from: only, to: c.conclusion })
      continue
    }
    implications.push({ id: c.id, premises: c.premises, conclusion: c.conclusion, line: chainLine(c, names) })
    for (const p of c.premises) edges.push({ from: p, to: c.id })
    edges.push({ from: c.id, to: c.conclusion })
  }
  return { edges, logicalEdges, implications }
}

/**
 * Group propositions by the source that first stated them.
 * @param propositions - propositions with provenance.
 * @param titles - source titles by id; a removed source is labelled as such.
 * @param minSize - smallest cluster drawn.
 * @returns clusters, largest first.
 */
export function birthClusters(propositions: readonly GraphProposition[], titles: ReadonlyMap<string, string>, minSize: number = MIN_CLUSTER_SIZE): GraphCluster[] {
  const members = new Map<string, string[]>()
  for (const p of propositions) {
    const birth = p.provenance[0]?.sourceId
    if (birth === undefined) continue
    members.set(birth, [...(members.get(birth) ?? []), p.id])
  }
  return [...members.entries()]
    .filter(([, list]) => list.length >= minSize)
    .map(([sourceId, list]) => ({ sourceId, label: titles.get(sourceId) ?? 'Removed source', members: list.toSorted() }))
    .toSorted((a, b) => b.members.length - a.members.length || a.sourceId.localeCompare(b.sourceId))
}

/**
 * Resolve a reference to a proposition: its id, or its name (case-insensitive).
 * @param reference - what the model wrote.
 * @param propositions - candidates.
 * @returns the id, or null when nothing matches.
 */
export function resolveProposition(reference: string, propositions: readonly Pick<GraphProposition, 'id' | 'name'>[]): string | null {
  const t = reference.trim().replace(/^[`"':\s]+|[`"'\s]+$/gu, '')
  if (t === '') return null
  if (propositions.some(p => p.id === t)) return t
  const lower = t.toLowerCase()
  return propositions.find(p => p.name.trim().toLowerCase() === lower)?.id ?? null
}
