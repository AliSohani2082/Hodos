/**
 * The knowledge-graph service: extraction from sessions and notes, the
 * graph snapshot, and deletions.
 *
 * Extraction is background model work, so it is bounded:
 * - it reads only what the tutor taught (teacher prose), never tool results
 *   or the learner's messages, and only from sessions the learner owns;
 * - each stretch is extracted once (the source records how far it was
 *   covered), in batches of bounded size;
 * - every call counts against the learner's daily budget, a learner runs one
 *   extraction at a time, and a reply that fails validation is retried once.
 * @module @hodos/core/knowledge/service
 */
import { createHash } from 'node:crypto'
import { systemClock, type Clock } from '../clock.js'
import { HodosError } from '../errors.js'
import { randomIds, type IdGenerator } from '../ids.js'
import type { LearnRepository } from '../learn/repository.js'
import { parseJsonReply, type ModelPort } from '../model.js'
import type { RegistryLogger } from '../registry/registry.js'
import { readFindings, readLinks, mergeFindings, type Findings, type IdentityLink, type MergeStats } from './findings.js'
import { birthClusters, chainLine, deriveView, type GraphProposition, type GraphSnapshot } from './graph.js'
import type { DeletionStats, GraphRepository } from './repository.js'

/** Limits on background extraction. */
export interface GraphBudget {
  /** Background model calls per learner per rolling 24 hours. */
  readonly callsPerDay: number
  /** Characters of source per extraction call. */
  readonly batchChars: number
  /** Uncovered teacher prose needed before an automatic extraction runs. */
  readonly minUncoveredChars: number
  /** Largest notes import. */
  readonly maxNotesChars: number
  /** Existing propositions shown to the auditor. */
  readonly candidateLimit: number
  /** Output tokens per call. */
  readonly maxOutputTokens: number
}

/** Default limits. */
export const DEFAULT_GRAPH_BUDGET: GraphBudget = {
  callsPerDay: 60,
  batchChars: 24_000,
  minUncoveredChars: 1_500,
  maxNotesChars: 200_000,
  candidateLimit: 200,
  maxOutputTokens: 8_000,
}

/** How an extraction run ended. */
export interface ExtractionResult {
  readonly status: 'done' | 'nothing-to-do' | 'busy' | 'budget' | 'failed' | 'unavailable'
  readonly batches: number
  readonly stats: MergeStats
  readonly message?: string
}

const ZERO: MergeStats = { propositions: 0, linked: 0, chains: 0, droppedChains: 0 }

function add(a: MergeStats, b: MergeStats): MergeStats {
  return { propositions: a.propositions + b.propositions, linked: a.linked + b.linked, chains: a.chains + b.chains, droppedChains: a.droppedChains + b.droppedChains }
}

const EXTRACTION_GOAL = `Your job is to find the source's core ideas and the arguments that derive them, for the learner's knowledge graph.

- A proposition is one true, self-contained statement about the subject, at full precision, with a short name (a few words, like a glossary headword). It never mentions the learner, the teacher or this text: write "X", not "the learner learned X". A misconception enters only as its true correction.
- A chain is an argument: premises that jointly entail a conclusion. Entailment is the only link that makes a chain; history, narrative or "is discussed after" do not. Independent arguments for one conclusion are separate chains. A conclusion may be a premise of later chains.
- Keep what a reference work on the subject would teach. Leave out examples, notation glosses and restatements that no argument needs, and anything that only makes sense inside this text (its numbering, its section names).
- When THE GRAPH SO FAR is given, this source was partly extracted already: reference its ids instead of restating them, and derive new material from what is established.

Reply with one JSON object and nothing else:
{"propositions": [{"id": "p1", "name": "…", "statement": "…", "aliases": ["…"]<PASSAGE>}], "chains": [{"premises": ["p1", "n_…"], "conclusion": "p2"}]}
Chain endpoints are ids of this reply or existing ids from THE GRAPH SO FAR, copied exactly. Use [] for an empty list.`

const SESSION_EXTRACTOR = `You are the extraction stage of a learning application. You read one stretch of a teaching session: the teacher's explanations in order, each passage labelled [T<number>].

${EXTRACTION_GOAL.replace('<PASSAGE>', ', "passage": "T12"')}
Give each proposition the label of the one passage that most directly states it, as "passage".`

const NOTES_EXTRACTOR = `You are the extraction stage of a learning application. You read one stretch of the learner's own notes, in order.

${EXTRACTION_GOAL.replace('<PASSAGE>', '')}`

const AUDITOR = `You are the identity stage of a learning application's knowledge graph. An extractor reported new propositions found in a source. You see those findings and existing propositions of the graph, never the source.

For each finding, decide whether an existing proposition already states the same claim. Paraphrases, rewordings and statements of the same claim at a different precision are the same claim: link them. Only genuinely different claims about the world stay apart. You are looking for right merges, not guarding against wrong ones.

Reply with one JSON object and nothing else: {"links": [{"id": "p1", "linkTo": "n_…"}]}. Use the finding's id and the existing proposition's id, copied exactly. Leave a finding out when nothing existing states it. Reply {"links": []} when nothing links.`

/** Split text into chunks of at most `limit` characters at paragraph or line boundaries. */
function chunks(text: string, limit: number): string[] {
  const out: string[] = []
  let current = ''
  for (const para of text.split(/\n{2,}/u)) {
    const pieces = para.length <= limit ? [para] : para.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'gu')) ?? []
    for (const piece of pieces) {
      if (current !== '' && current.length + piece.length + 2 > limit) {
        out.push(current)
        current = ''
      }
      current = current === '' ? piece : `${current}\n\n${piece}`
    }
  }
  if (current.trim() !== '') out.push(current)
  return out
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3))
}

/** Dependencies of the knowledge service. */
export interface KnowledgeServiceOptions {
  readonly graph: GraphRepository
  readonly learn: LearnRepository
  /** The host's model, read at each run; null when none is available (extraction then reports `unavailable`). */
  readonly model: () => ModelPort | null
  readonly logger: RegistryLogger
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly budget?: Partial<GraphBudget>
}

/** The knowledge-graph service. */
export class KnowledgeService {
  private readonly repo: GraphRepository
  private readonly learn: LearnRepository
  private readonly model: () => ModelPort | null
  private readonly logger: RegistryLogger
  private readonly clock: Clock
  private readonly ids: IdGenerator
  readonly budget: GraphBudget
  private readonly running = new Set<string>()

  /** @param options - dependencies. */
  constructor(options: KnowledgeServiceOptions) {
    this.repo = options.graph
    this.learn = options.learn
    this.model = options.model
    this.logger = options.logger
    this.clock = options.clock ?? systemClock
    this.ids = options.ids ?? randomIds
    this.budget = { ...DEFAULT_GRAPH_BUDGET, ...options.budget }
  }

  private now(): string {
    return this.clock.now().toISOString()
  }

  // ---- reading ----

  /**
   * The learner's graph, ready to draw.
   * @param learnerId - the learner.
   * @returns the snapshot.
   */
  snapshot(learnerId: string): GraphSnapshot {
    const propositions = this.repo.propositions(learnerId)
    const chains = this.repo.chains(learnerId)
    const sources = this.repo.sources(learnerId).map(s => ({ id: s.id, kind: s.kind, title: s.title }))
    const titles = new Map(sources.map(s => [s.id, s.title]))
    return { propositions, chains, ...deriveView(propositions, chains), clusters: birthClusters(propositions, titles), sources }
  }

  /**
   * Teacher prose of a session not yet extracted.
   * @param sessionId - the learning session.
   * @returns characters waiting.
   */
  uncovered(sessionId: string): number {
    const covered = this.repo.source(sessionId)?.coveredThrough ?? 0
    return this.learn.transcript(sessionId, covered).filter(e => e.role === 'teacher').reduce((n, e) => n + e.text.length, 0)
  }

  // ---- extraction ----

  private remainingCalls(learnerId: string): number {
    const since = new Date(this.clock.now().getTime() - 86_400_000).toISOString()
    return this.budget.callsPerDay - this.repo.callsSince(learnerId, since)
  }

  /** One model call with one retry on an invalid reply. Throws on budget or model failure. */
  private async call<T>(learnerId: string, purpose: string, system: string, prompt: string, read: (raw: Record<string, unknown>) => { value: T } | { problems: string[] }, signal?: AbortSignal): Promise<T> {
    const model = this.model()
    if (model === null) throw new HodosError('UNAVAILABLE', 'no model is available for background work')
    let request = prompt
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (this.remainingCalls(learnerId) <= 0) throw new HodosError('RATE_LIMITED', 'the daily budget for background model calls is used up')
      let reply
      try {
        reply = await model.complete({ purpose, system, prompt: request, maxOutputTokens: this.budget.maxOutputTokens, ...(signal === undefined ? {} : { signal }) })
      } catch (error) {
        this.repo.recordCall(learnerId, purpose, false, {}, this.now())
        throw new HodosError('UNAVAILABLE', `the model call failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`)
      }
      const parsed = parseJsonReply(reply.text)
      const result = typeof parsed === 'string' ? { problems: [parsed] } : read(parsed)
      const ok = 'value' in result
      this.repo.recordCall(learnerId, purpose, ok, { ...(reply.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }), ...(reply.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens }) }, this.now())
      if ('value' in result) return result.value
      this.logger.warn(`${purpose} reply rejected (attempt ${attempt}): ${result.problems.slice(0, 3).join('; ')}`)
      request = `${prompt}\n\nYour previous reply was rejected:\n${result.problems.slice(0, 20).map(p => `- ${p}`).join('\n')}\nReply again with the corrected JSON object only.`
    }
    throw new HodosError('UNAVAILABLE', `${purpose} produced no valid reply`)
  }

  /** What this source has already contributed, for the extractor to build on. */
  private digest(learnerId: string, sourceId: string, propositions: readonly GraphProposition[]): { text: string; ids: Set<string> } {
    const ours = propositions.filter(p => p.provenance.some(q => q.sourceId === sourceId)).slice(-150)
    if (ours.length === 0) return { text: '', ids: new Set() }
    const names = new Map(propositions.map(p => [p.id, p.name]))
    const chains = this.repo.chains(learnerId).filter(c => c.sources.includes(sourceId)).slice(-100)
    const lines = ['THE GRAPH SO FAR (from this source; reference these ids exactly):', ...ours.map(p => `${p.id} | ${p.name} | ${p.statement.replace(/\s+/gu, ' ')}`)]
    if (chains.length > 0) lines.push('ARGUMENTS ALREADY RECORDED (build on them, do not repeat them):', ...chains.map(c => `${c.premises.join(' + ')} => ${c.conclusion}: ${chainLine(c, names)}`))
    return { text: lines.join('\n'), ids: new Set(ours.map(p => p.id)) }
  }

  /** Existing propositions most likely to be the same as the findings. */
  private candidates(propositions: readonly GraphProposition[], findings: Findings, exclude: ReadonlySet<string>): GraphProposition[] {
    const pool = propositions.filter(p => !exclude.has(p.id))
    if (pool.length <= this.budget.candidateLimit) return pool
    const wanted = words(findings.propositions.map(p => `${p.name} ${p.statement} ${p.aliases.join(' ')}`).join(' '))
    const score = (p: GraphProposition): number => {
      let n = 0
      for (const w of words(`${p.name} ${p.statement} ${p.aliases.join(' ')}`)) if (wanted.has(w)) n += 1
      return n
    }
    return pool.map(p => ({ p, s: score(p) })).toSorted((a, b) => b.s - a.s).slice(0, this.budget.candidateLimit).map(x => x.p)
  }

  /** Extract one stretch: findings, identity links, merge. */
  private async extractStretch(learnerId: string, sourceId: string, system: string, body: string, passages: ReadonlySet<number> | undefined, signal?: AbortSignal): Promise<MergeStats> {
    const propositions = this.repo.propositions(learnerId)
    const digest = this.digest(learnerId, sourceId, propositions)
    const prompt = `${digest.text === '' ? '' : `${digest.text}\n\n`}THE STRETCH TO EXTRACT:\n${body}`
    const findings = await this.call(learnerId, 'graph.extract', system, prompt, raw => {
      const r = readFindings(raw, { existing: digest.ids, ...(passages === undefined ? {} : { passages }) })
      return 'findings' in r ? { value: r.findings } : r
    }, signal)
    const pool = this.candidates(propositions, findings, digest.ids)
    let links: IdentityLink[] = []
    if (findings.propositions.length > 0 && pool.length > 0) {
      const candidateIds = new Set(pool.map(p => p.id))
      const auditPrompt = [
        'FINDINGS:',
        ...findings.propositions.map(p => `${p.id} | ${p.name} | ${p.statement}`),
        '',
        'EXISTING PROPOSITIONS:',
        ...pool.map(p => `${p.id} | ${p.name} | ${p.statement.replace(/\s+/gu, ' ')}`),
      ].join('\n')
      links = await this.call(learnerId, 'graph.audit', AUDITOR, auditPrompt, raw => {
        const r = readLinks(raw, findings, candidateIds)
        return 'links' in r ? { value: r.links } : r
      }, signal)
    }
    return this.repo.transaction(() => mergeFindings(this.repo, { learnerId, sourceId, findings, links, ids: this.ids, at: this.now() }))
  }

  private async exclusive(learnerId: string, run: () => Promise<ExtractionResult>): Promise<ExtractionResult> {
    if (this.model() === null) return { status: 'unavailable', batches: 0, stats: ZERO, message: 'no model is available for background work' }
    if (this.running.has(learnerId)) return { status: 'busy', batches: 0, stats: ZERO }
    this.running.add(learnerId)
    try {
      return await run()
    } finally {
      this.running.delete(learnerId)
    }
  }

  private stopped(error: unknown, batches: number, stats: MergeStats): ExtractionResult {
    const message = error instanceof Error ? error.message : String(error)
    this.logger.warn(`graph extraction stopped: ${message}`)
    const status = error instanceof HodosError && error.code === 'RATE_LIMITED' ? 'budget' : 'failed'
    return { status, batches, stats, message }
  }

  /**
   * Extract what the tutor taught in a session and has not been extracted yet.
   * @param learnerId - the session's owner.
   * @param sessionId - the learning session.
   * @param options - `force` runs even below the automatic threshold.
   * @returns how the run ended.
   */
  async extractSession(learnerId: string, sessionId: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ExtractionResult> {
    const session = this.learn.session(sessionId)
    if (session?.learnerId !== learnerId) throw new HodosError('NOT_FOUND', 'no such learning session')
    if (options.force !== true && this.uncovered(sessionId) < this.budget.minUncoveredChars) return { status: 'nothing-to-do', batches: 0, stats: ZERO }
    return this.exclusive(learnerId, async () => {
      const at = this.now()
      if (this.repo.source(sessionId) === undefined) this.repo.upsertSource({ id: sessionId, learnerId, kind: 'session', title: session.goal, coveredThrough: 0, createdAt: at, updatedAt: at })
      let batches = 0
      let stats = ZERO
      for (;;) {
        const covered = this.repo.source(sessionId)?.coveredThrough ?? 0
        const entries = this.learn.transcript(sessionId, covered)
        const teacher = entries.filter(e => e.role === 'teacher')
        if (teacher.length === 0) {
          const last = entries.at(-1)
          if (last !== undefined) this.repo.setCovered(sessionId, last.seq, this.now())
          break
        }
        const batch: typeof teacher = []
        let size = 0
        for (const e of teacher) {
          const text = e.text.length > this.budget.batchChars ? e.text.slice(0, this.budget.batchChars) : e.text
          if (batch.length > 0 && size + text.length > this.budget.batchChars) break
          batch.push({ ...e, text })
          size += text.length
        }
        const body = batch.map(e => `[T${e.seq}]\n${e.text}`).join('\n\n')
        try {
          stats = add(stats, await this.extractStretch(learnerId, sessionId, SESSION_EXTRACTOR, body, new Set(batch.map(e => e.seq)), options.signal))
        } catch (error) {
          return this.stopped(error, batches, stats)
        }
        batches += 1
        const through = batch.at(-1)?.seq ?? covered
        this.repo.setCovered(sessionId, through, this.now())
      }
      return { status: batches === 0 ? 'nothing-to-do' : 'done', batches, stats }
    })
  }

  /**
   * Import notes into the graph through the same pipeline.
   * @param learnerId - the learner.
   * @param title - what the notes are (a file name or a topic).
   * @param text - the notes.
   * @returns the source id and how the run ended.
   */
  async importNotes(learnerId: string, title: string, text: string, signal?: AbortSignal): Promise<{ sourceId: string; result: ExtractionResult }> {
    const name = title.trim().slice(0, 200)
    const body = text.trim()
    if (name === '') throw new HodosError('INVALID_INPUT', 'give the notes a title')
    if (body === '') throw new HodosError('INVALID_INPUT', 'the notes are empty')
    if (body.length > this.budget.maxNotesChars) throw new HodosError('INVALID_INPUT', `notes are limited to ${this.budget.maxNotesChars} characters`)
    const sourceId = `src_${createHash('sha256').update(`${learnerId}\u0000${name}\u0000${body}`).digest('hex').slice(0, 24)}`
    const at = this.now()
    if (this.repo.source(sourceId) === undefined) {
      this.repo.transaction(() => {
        this.repo.upsertSource({ id: sourceId, learnerId, kind: 'notes', title: name, coveredThrough: 0, createdAt: at, updatedAt: at })
        this.repo.saveNotes(sourceId, body)
      })
    }
    return { sourceId, result: await this.resumeNotes(learnerId, sourceId, signal) }
  }

  /**
   * Continue extracting a notes source from where it stopped.
   * @param learnerId - the learner.
   * @param sourceId - the notes source.
   * @returns how the run ended.
   */
  async resumeNotes(learnerId: string, sourceId: string, signal?: AbortSignal): Promise<ExtractionResult> {
    const source = this.repo.source(sourceId)
    const text = this.repo.notes(sourceId)
    if (source?.learnerId !== learnerId || source.kind !== 'notes' || text === undefined) throw new HodosError('NOT_FOUND', 'no such notes source')
    return this.exclusive(learnerId, async () => {
      const parts = chunks(text, this.budget.batchChars)
      let batches = 0
      let stats = ZERO
      for (let i = this.repo.source(sourceId)?.coveredThrough ?? 0; i < parts.length; i += 1) {
        try {
          stats = add(stats, await this.extractStretch(learnerId, sourceId, NOTES_EXTRACTOR, parts[i] ?? '', undefined, signal))
        } catch (error) {
          return this.stopped(error, batches, stats)
        }
        batches += 1
        this.repo.setCovered(sourceId, i + 1, this.now())
      }
      return { status: batches === 0 ? 'nothing-to-do' : 'done', batches, stats }
    })
  }

  // ---- deleting ----

  /**
   * Delete one proposition and every chain that names it.
   * @param learnerId - the owner.
   * @param propositionId - the proposition.
   * @returns what was removed.
   */
  deleteProposition(learnerId: string, propositionId: string): DeletionStats {
    return this.repo.transaction(() => {
      if (!this.repo.propositionIds(learnerId).has(propositionId)) throw new HodosError('NOT_FOUND', 'no such proposition')
      return this.repo.deletePropositions(learnerId, new Set([propositionId]))
    })
  }

  /**
   * Remove a source (a session or notes) from the graph.
   * @param learnerId - the owner.
   * @param sourceId - the source.
   * @param mode - keep what it contributed, or delete what only it asserted.
   * @returns what was removed.
   */
  removeSource(learnerId: string, sourceId: string, mode: 'preserve-graph' | 'delete-nodes'): DeletionStats {
    return this.repo.transaction(() => {
      const source = this.repo.source(sourceId)
      if (source?.learnerId !== learnerId) throw new HodosError('NOT_FOUND', 'no such source')
      return this.repo.removeSource(learnerId, sourceId, mode)
    })
  }
}
