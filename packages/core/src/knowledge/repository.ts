/**
 * Storage of the knowledge graph (schema version 3): sources, propositions
 * with every assertion of them, chains with the sources that asserted them,
 * and the ledger of background model calls that budgets are counted from.
 * @module @hodos/core/knowledge/repository
 */
import { json, num, optNum, str, type SqlRunner } from '../store/rows.js'
import type { HodosStore } from '../store/store.js'
import type { GraphChain, GraphProposition, ProvenancePoint } from './graph.js'

/** A source of graph knowledge: a learning session, or imported notes. */
export interface GraphSourceRecord {
  readonly id: string
  readonly learnerId: string
  readonly kind: 'session' | 'notes'
  readonly title: string
  /** Sessions: the last transcript entry extracted. Notes: the number of chunks extracted. */
  readonly coveredThrough: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** What one deletion removed. */
export interface DeletionStats {
  readonly propositions: number
  readonly chains: number
}

function sourceFromRow(row: Record<string, unknown>): GraphSourceRecord {
  return {
    id: str(row, 'id'),
    learnerId: str(row, 'learner_id'),
    kind: str(row, 'kind') as GraphSourceRecord['kind'], // CHECK constraint
    title: str(row, 'title'),
    coveredThrough: num(row, 'covered_through'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  }
}

/** Knowledge-graph tables of a Hodos store. */
export class GraphRepository {
  private readonly sql: SqlRunner

  /** @param store - the store whose database holds the tables. */
  constructor(readonly store: HodosStore) {
    this.sql = store.sql
  }

  /**
   * Run work in one transaction.
   * @param fn - synchronous work.
   * @returns its result.
   */
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  // ---- sources ----

  /** @param s - the source to insert or rename. */
  upsertSource(s: GraphSourceRecord): void {
    this.sql.run(`INSERT INTO kg_sources (id, learner_id, kind, title, covered_through, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
    s.id, s.learnerId, s.kind, s.title, s.coveredThrough, s.createdAt, s.updatedAt)
  }

  /** @param id - source id. @returns the source, or undefined. */
  source(id: string): GraphSourceRecord | undefined {
    const row = this.sql.get('SELECT * FROM kg_sources WHERE id = ?', id)
    return row === undefined ? undefined : sourceFromRow(row)
  }

  /** @param learnerId - learner. @returns their sources, oldest first. */
  sources(learnerId: string): GraphSourceRecord[] {
    return this.sql.all('SELECT * FROM kg_sources WHERE learner_id = ? ORDER BY created_at, id', learnerId).map(sourceFromRow)
  }

  /** Record how far a source has been extracted. */
  setCovered(sourceId: string, through: number, at: string): void {
    this.sql.run('UPDATE kg_sources SET covered_through = ?, updated_at = ? WHERE id = ?', through, at, sourceId)
  }

  /** Store the text of an imported notes source. */
  saveNotes(sourceId: string, text: string): void {
    this.sql.run('INSERT INTO kg_notes (source_id, text) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET text = excluded.text', sourceId, text)
  }

  /** @param sourceId - a notes source. @returns its text, or undefined. */
  notes(sourceId: string): string | undefined {
    const row = this.sql.get('SELECT text FROM kg_notes WHERE source_id = ?', sourceId)
    return row === undefined ? undefined : str(row, 'text')
  }

  // ---- propositions ----

  /**
   * Every live proposition of a learner, merged from its assertions: the
   * first assertion is its birth; later phrasings join its aliases.
   * @param learnerId - learner.
   * @returns propositions in the order they were created.
   */
  propositions(learnerId: string): GraphProposition[] {
    const rows = this.sql.all(`SELECT p.id, p.name, p.statement, p.created_at, a.source_id, a.anchor, a.statement AS said, a.aliases_json
      FROM kg_propositions p JOIN kg_assertions a ON a.proposition_id = p.id
      WHERE p.learner_id = ? ORDER BY p.created_at, p.rowid, a.seq`, learnerId)
    const out = new Map<string, { id: string; name: string; statement: string; createdAt: string; aliases: Set<string>; provenance: ProvenancePoint[] }>()
    for (const row of rows) {
      const id = str(row, 'id')
      let p = out.get(id)
      if (p === undefined) {
        p = { id, name: str(row, 'name'), statement: str(row, 'statement'), createdAt: str(row, 'created_at'), aliases: new Set(), provenance: [] }
        out.set(id, p)
      }
      const said = str(row, 'said')
      if (said !== p.statement) p.aliases.add(said)
      for (const alias of json(row, 'aliases_json') as string[]) if (alias !== p.statement) p.aliases.add(alias)
      const point = { sourceId: str(row, 'source_id'), anchor: optNum(row, 'anchor') }
      if (!p.provenance.some(q => q.sourceId === point.sourceId && q.anchor === point.anchor)) p.provenance.push(point)
    }
    return [...out.values()].map(p => ({ id: p.id, name: p.name, statement: p.statement, aliases: [...p.aliases], createdAt: p.createdAt, provenance: p.provenance }))
  }

  /** @param learnerId - learner. @returns ids of their live propositions. */
  propositionIds(learnerId: string): Set<string> {
    return new Set(this.sql.all('SELECT id FROM kg_propositions WHERE learner_id = ?', learnerId).map(r => str(r, 'id')))
  }

  /** Create a proposition with its first assertion. */
  insertProposition(p: { id: string; learnerId: string; name: string; statement: string; aliases: readonly string[]; sourceId: string; anchor: number | null; createdAt: string }): void {
    this.sql.run('INSERT INTO kg_propositions (id, learner_id, name, statement, created_at) VALUES (?, ?, ?, ?, ?)', p.id, p.learnerId, p.name, p.statement, p.createdAt)
    this.appendAssertion(p.id, p.sourceId, p.anchor, p.statement, p.aliases, p.createdAt)
  }

  /** Record that a source asserted an existing proposition, in its own words. */
  appendAssertion(propositionId: string, sourceId: string, anchor: number | null, statement: string, aliases: readonly string[], at: string): void {
    this.sql.run('INSERT INTO kg_assertions (proposition_id, source_id, anchor, statement, aliases_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      propositionId, sourceId, anchor, statement, JSON.stringify(aliases), at)
  }

  // ---- chains ----

  /** @param learnerId - learner. @returns their chains with asserting sources, oldest first. */
  chains(learnerId: string): GraphChain[] {
    const rows = this.sql.all(`SELECT c.id, c.premises_json, c.conclusion_id, c.created_at, s.source_id
      FROM kg_chains c LEFT JOIN kg_chain_sources s ON s.chain_id = c.id
      WHERE c.learner_id = ? ORDER BY c.created_at, c.rowid, s.created_at, s.source_id`, learnerId)
    const out = new Map<string, { id: string; premises: string[]; conclusion: string; createdAt: string; sources: string[] }>()
    for (const row of rows) {
      const id = str(row, 'id')
      let c = out.get(id)
      if (c === undefined) {
        c = { id, premises: json(row, 'premises_json') as string[], conclusion: str(row, 'conclusion_id'), createdAt: str(row, 'created_at'), sources: [] }
        out.set(id, c)
      }
      const source = row.source_id
      if (typeof source === 'string') c.sources.push(source)
    }
    return [...out.values()]
  }

  /** @param learnerId - learner. @param key - chain key. @returns the chain's id, or undefined. */
  chainIdByKey(learnerId: string, key: string): string | undefined {
    const row = this.sql.get('SELECT id FROM kg_chains WHERE learner_id = ? AND chain_key = ?', learnerId, key)
    return row === undefined ? undefined : str(row, 'id')
  }

  /** Create a chain. */
  insertChain(c: { id: string; learnerId: string; key: string; premises: readonly string[]; conclusion: string; createdAt: string }): void {
    this.sql.run('INSERT INTO kg_chains (id, learner_id, chain_key, premises_json, conclusion_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      c.id, c.learnerId, c.key, JSON.stringify(c.premises), c.conclusion, c.createdAt)
  }

  /** Record that a source asserted a chain. @returns whether it was new for that source. */
  addChainSource(chainId: string, sourceId: string, at: string): boolean {
    const before = this.sql.get('SELECT 1 AS x FROM kg_chain_sources WHERE chain_id = ? AND source_id = ?', chainId, sourceId)
    if (before !== undefined) return false
    this.sql.run('INSERT INTO kg_chain_sources (chain_id, source_id, created_at) VALUES (?, ?, ?)', chainId, sourceId, at)
    return true
  }

  /** @param ids - chains to delete with their sources. */
  deleteChains(ids: Iterable<string>): void {
    for (const id of ids) this.sql.run('DELETE FROM kg_chains WHERE id = ?', id)
  }

  /**
   * Delete propositions and every chain that names one of them.
   * @param learnerId - learner.
   * @param ids - propositions to delete.
   * @returns what was removed.
   */
  deletePropositions(learnerId: string, ids: ReadonlySet<string>): DeletionStats {
    if (ids.size === 0) return { propositions: 0, chains: 0 }
    const dead = this.chains(learnerId).filter(c => ids.has(c.conclusion) || c.premises.some(p => ids.has(p))).map(c => c.id)
    this.deleteChains(dead)
    for (const id of ids) this.sql.run('DELETE FROM kg_propositions WHERE id = ? AND learner_id = ?', id, learnerId)
    return { propositions: ids.size, chains: dead.length }
  }

  /**
   * Remove a source from the graph.
   * - `preserve-graph`: forget the source's bookkeeping; its propositions and
   *   chains stay, still crediting it.
   * - `delete-nodes`: as if the source never existed: its assertions and
   *   chain assertions go, and propositions or chains nothing else asserts
   *   die (with every chain naming a dead proposition). A surviving
   *   proposition keeps its name and statement.
   * @param learnerId - learner.
   * @param sourceId - the source.
   * @param mode - what happens to the graph.
   * @returns what was removed.
   */
  removeSource(learnerId: string, sourceId: string, mode: 'preserve-graph' | 'delete-nodes'): DeletionStats {
    let stats: DeletionStats = { propositions: 0, chains: 0 }
    if (mode === 'delete-nodes') {
      const touched = this.sql.all(`SELECT DISTINCT a.proposition_id FROM kg_assertions a JOIN kg_propositions p ON p.id = a.proposition_id
        WHERE a.source_id = ? AND p.learner_id = ?`, sourceId, learnerId).map(r => str(r, 'proposition_id'))
      this.sql.run('DELETE FROM kg_assertions WHERE source_id = ? AND proposition_id IN (SELECT id FROM kg_propositions WHERE learner_id = ?)', sourceId, learnerId)
      const orphans = new Set(touched.filter(id => this.sql.get('SELECT 1 AS x FROM kg_assertions WHERE proposition_id = ?', id) === undefined))
      const chainsOwned = this.sql.all(`SELECT c.id FROM kg_chains c JOIN kg_chain_sources s ON s.chain_id = c.id WHERE s.source_id = ? AND c.learner_id = ?`, sourceId, learnerId).map(r => str(r, 'id'))
      this.sql.run('DELETE FROM kg_chain_sources WHERE source_id = ? AND chain_id IN (SELECT id FROM kg_chains WHERE learner_id = ?)', sourceId, learnerId)
      const unasserted = chainsOwned.filter(id => this.sql.get('SELECT 1 AS x FROM kg_chain_sources WHERE chain_id = ?', id) === undefined)
      this.deleteChains(unasserted)
      const cascade = this.deletePropositions(learnerId, orphans)
      stats = { propositions: cascade.propositions, chains: cascade.chains + unasserted.length }
    }
    this.sql.run('DELETE FROM kg_sources WHERE id = ? AND learner_id = ?', sourceId, learnerId)
    return stats
  }

  // ---- background model calls ----

  /** Record one background model call for budgets. */
  recordCall(learnerId: string, purpose: string, ok: boolean, usage: { inputTokens?: number; outputTokens?: number }, at: string): void {
    this.sql.run('INSERT INTO model_calls (learner_id, purpose, ok, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      learnerId, purpose, ok ? 1 : 0, usage.inputTokens ?? null, usage.outputTokens ?? null, at)
  }

  /** @param learnerId - learner. @param since - ISO time. @returns background model calls made since then. */
  callsSince(learnerId: string, since: string): number {
    const row = this.sql.get('SELECT count(*) AS n FROM model_calls WHERE learner_id = ? AND created_at >= ?', learnerId, since)
    return row === undefined ? 0 : num(row, 'n')
  }
}
