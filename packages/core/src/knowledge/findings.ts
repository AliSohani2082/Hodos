/**
 * What the extraction stages report, how it is validated, and the
 * deterministic merger that is the only writer of the graph.
 *
 *   extractor (sees the source)  →  findings: propositions + chains
 *   auditor (sees the graph)     →  identity links: this finding IS that node
 *   merger (no model)            →  appends, links, simplifies
 * @module @hodos/core/knowledge/findings
 */
import type { IdGenerator } from '../ids.js'
import { chainKey, simplifyChains } from './graph.js'
import type { GraphRepository } from './repository.js'

/** One proposition found in a source. */
export interface ExtractedProposition {
  /** Local id within this report (p1, p2, …). */
  readonly id: string
  readonly name: string
  readonly statement: string
  readonly aliases: readonly string[]
  /** The transcript entry it came from (sessions only). */
  readonly anchor?: number
}

/** One argument found in a source. Endpoints are local ids or existing proposition ids. */
export interface ExtractedChain {
  readonly premises: readonly string[]
  readonly conclusion: string
}

/** The extractor's report. */
export interface Findings {
  readonly propositions: readonly ExtractedProposition[]
  readonly chains: readonly ExtractedChain[]
}

/** The auditor's verdict: a found proposition is an existing one. */
export interface IdentityLink {
  readonly id: string
  readonly linkTo: string
}

/** Size limits on one report. */
export const FINDINGS_LIMITS = {
  propositions: 40,
  chains: 60,
  premises: 8,
  nameChars: 80,
  statementChars: 600,
  aliases: 5,
  aliasChars: 200,
} as const

const LOCAL_ID = /^[A-Za-z0-9_-]{1,40}$/

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Arrays sometimes arrive JSON-encoded as strings. */
function list(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value as unknown[]
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as unknown[]) : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Validate an extractor report.
 * @param raw - the parsed reply.
 * @param context - existing proposition ids the report may reference, and
 *   for sessions the transcript entries of this batch (each proposition must
 *   name one as its `passage`).
 * @returns the findings, or problems to send back to the model.
 */
export function readFindings(raw: Record<string, unknown>, context: { readonly existing: ReadonlySet<string>; readonly passages?: ReadonlySet<number> }): { findings: Findings } | { problems: string[] } {
  const problems: string[] = []
  const props = list(raw.propositions)
  const chainsRaw = list(raw.chains)
  if (props === null) problems.push('"propositions" must be a list (use [] when there are none)')
  if (chainsRaw === null) problems.push('"chains" must be a list (use [] when the source makes no arguments)')
  if (props === null || chainsRaw === null) return { problems }
  if (props.length > FINDINGS_LIMITS.propositions) problems.push(`report at most ${FINDINGS_LIMITS.propositions} propositions per stretch; keep the load-bearing ones`)
  if (chainsRaw.length > FINDINGS_LIMITS.chains) problems.push(`report at most ${FINDINGS_LIMITS.chains} chains per stretch`)
  const propositions: ExtractedProposition[] = []
  const local = new Set<string>()
  props.slice(0, FINDINGS_LIMITS.propositions).forEach((entry, i) => {
    const p = obj(entry)
    const id = typeof p?.id === 'string' ? p.id.trim() : ''
    const name = typeof p?.name === 'string' ? p.name.trim() : ''
    const statement = typeof p?.statement === 'string' ? p.statement.trim() : ''
    const where = `proposition ${i + 1}${id === '' ? '' : ` (${id})`}`
    if (!LOCAL_ID.test(id)) problems.push(`${where}: "id" must be a short local id such as p1`)
    else if (local.has(id) || context.existing.has(id)) problems.push(`${where}: the id "${id}" is already used; give each new proposition its own id`)
    if (name === '' || name.length > FINDINGS_LIMITS.nameChars) problems.push(`${where}: "name" must be a short label of at most ${FINDINGS_LIMITS.nameChars} characters`)
    if (statement === '' || statement.length > FINDINGS_LIMITS.statementChars) problems.push(`${where}: "statement" must be one self-contained proposition of at most ${FINDINGS_LIMITS.statementChars} characters`)
    const aliases = (list(p?.aliases) ?? []).filter((a): a is string => typeof a === 'string').map(a => a.trim()).filter(a => a !== '' && a.length <= FINDINGS_LIMITS.aliasChars).slice(0, FINDINGS_LIMITS.aliases)
    let anchor: number | undefined
    if (context.passages !== undefined) {
      const label = typeof p?.passage === 'string' ? p.passage.trim() : typeof p?.passage === 'number' ? String(p.passage) : ''
      const n = Number(/^T?(\d+)$/iu.exec(label)?.[1] ?? Number.NaN)
      if (!context.passages.has(n)) problems.push(`${where}: "passage" must be the label of one passage of this stretch (such as "T${[...context.passages][0] ?? 1}")`)
      else anchor = n
    }
    local.add(id)
    propositions.push({ id, name, statement, aliases, ...(anchor === undefined ? {} : { anchor }) })
  })
  const chains: ExtractedChain[] = []
  const known = (id: string): boolean => local.has(id) || context.existing.has(id)
  chainsRaw.slice(0, FINDINGS_LIMITS.chains).forEach((entry, i) => {
    const c = obj(entry)
    const conclusion = typeof c?.conclusion === 'string' ? c.conclusion.trim() : ''
    const premises = (list(c?.premises) ?? []).filter((p): p is string => typeof p === 'string').map(p => p.trim())
    const where = `chain ${i + 1}`
    if (!known(conclusion)) problems.push(`${where}: conclusion "${conclusion}" is neither a proposition of this report nor an existing id`)
    const unknown = premises.filter(p => !known(p))
    if (unknown.length > 0) problems.push(`${where}: premises ${unknown.map(p => `"${p}"`).join(', ')} are neither propositions of this report nor existing ids`)
    const distinct = [...new Set(premises)].filter(p => p !== conclusion)
    if (distinct.length === 0) problems.push(`${where}: a chain needs at least one premise other than its conclusion; a bare idea goes in "propositions" alone`)
    if (distinct.length > FINDINGS_LIMITS.premises) problems.push(`${where}: at most ${FINDINGS_LIMITS.premises} premises`)
    chains.push({ premises: distinct, conclusion })
  })
  return problems.length > 0 ? { problems } : { findings: { propositions, chains } }
}

/**
 * Validate the auditor's verdicts.
 * @param raw - the parsed reply.
 * @param findings - the findings audited.
 * @param candidates - existing proposition ids the auditor was shown.
 * @returns the links, or problems to send back to the model.
 */
export function readLinks(raw: Record<string, unknown>, findings: Findings, candidates: ReadonlySet<string>): { links: IdentityLink[] } | { problems: string[] } {
  const entries = list(raw.links)
  if (entries === null) return { problems: ['"links" must be a list (use [] when nothing links)'] }
  const ids = new Set(findings.propositions.map(p => p.id))
  const problems: string[] = []
  const links: IdentityLink[] = []
  const linked = new Set<string>()
  entries.forEach((entry, i) => {
    const l = obj(entry)
    const id = typeof l?.id === 'string' ? l.id.trim() : ''
    const linkTo = typeof l?.linkTo === 'string' ? l.linkTo.trim() : ''
    if (!ids.has(id)) problems.push(`link ${i + 1}: "${id}" is not a proposition of the findings`)
    else if (!candidates.has(linkTo)) problems.push(`link ${i + 1}: "${linkTo}" is not an existing proposition id`)
    else if (!linked.has(id)) {
      linked.add(id)
      links.push({ id, linkTo })
    }
  })
  return problems.length > 0 ? { problems } : { links }
}

/** What one merge did. */
export interface MergeStats {
  /** New propositions. */
  readonly propositions: number
  /** Findings linked to existing propositions. */
  readonly linked: number
  /** Chains newly asserted by this source. */
  readonly chains: number
  /** Redundant chains removed by simplification. */
  readonly droppedChains: number
}

/**
 * Apply findings and verdicts to the graph. Deterministic; the caller runs it
 * in a transaction.
 * @param repo - the graph tables.
 * @param input - learner, source, findings, links, id generator and time.
 * @returns what changed.
 */
export function mergeFindings(repo: GraphRepository, input: {
  readonly learnerId: string
  readonly sourceId: string
  readonly findings: Findings
  readonly links: readonly IdentityLink[]
  readonly ids: IdGenerator
  readonly at: string
}): MergeStats {
  const { learnerId, sourceId, findings, at } = input
  const existing = repo.propositionIds(learnerId)
  const linkOf = new Map(input.links.map(l => [l.id, l.linkTo]))
  const mapping = new Map<string, string>()
  let created = 0
  let linked = 0
  for (const p of findings.propositions) {
    if (mapping.has(p.id)) continue
    const target = linkOf.get(p.id)
    if (target !== undefined && existing.has(target)) {
      repo.appendAssertion(target, sourceId, p.anchor ?? null, p.statement, p.aliases, at)
      mapping.set(p.id, target)
      linked += 1
    } else {
      const id = input.ids.next('n')
      repo.insertProposition({ id, learnerId, name: p.name, statement: p.statement, aliases: p.aliases, sourceId, anchor: p.anchor ?? null, createdAt: at })
      existing.add(id)
      mapping.set(p.id, id)
      created += 1
    }
  }
  let chains = 0
  const resolve = (id: string): string | undefined => mapping.get(id) ?? (existing.has(id) ? id : undefined)
  for (const c of findings.chains) {
    const conclusion = resolve(c.conclusion)
    if (conclusion === undefined) continue
    const premises = [...new Set(c.premises.map(resolve))].filter((p): p is string => p !== undefined && p !== conclusion).toSorted()
    if (premises.length === 0) continue
    const key = chainKey(premises, conclusion)
    let id = repo.chainIdByKey(learnerId, key)
    if (id === undefined) {
      id = input.ids.next('arg')
      repo.insertChain({ id, learnerId, key, premises, conclusion, createdAt: at })
    }
    if (repo.addChainSource(id, sourceId, at)) chains += 1
  }
  const all = repo.chains(learnerId)
  const kept = new Set(simplifyChains(all).map(c => c.id))
  const dropped = all.filter(c => !kept.has(c.id)).map(c => c.id)
  repo.deleteChains(dropped)
  return { propositions: created, linked, chains, droppedChains: dropped.length }
}
