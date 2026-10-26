/**
 * Adaptive diagnostic over the prerequisite graph (intelligent-tutoring.md §4).
 *
 * Knowledge states are down-sets of the DAG: knowing a skill implies knowing
 * its prerequisites. Two strategies share one interface:
 *
 * - `halfsplit`: a particle belief over down-sets (K particles, seeded). Each
 *   question targets the skill whose marginal is closest to 0.5; answers
 *   reweight particles with slip/guess noise; "I don't know" removes the
 *   guess term. Stops when the expected per-skill error is below the target
 *   after a minimum number of questions, at the cap, or on fatigue.
 * - `propagation`: the tested fallback for small or incomplete graphs. Asks
 *   the unresolved skill with the most unresolved relatives; a correct answer
 *   marks the skill and its prerequisites known, a wrong answer or "I don't
 *   know" marks it and its dependents unknown.
 *
 * State is the configuration plus the answer log, so a diagnostic is
 * reconstructed deterministically after a restart. Self-reports enter only as
 * weak pseudo-observations and never as verified mastery.
 * @module @hodos/core/diagnostic
 */
import { HodosError } from '../errors.js'
import { gaussian, seededRandom, type Random } from '../random.js'

/** One skill in the diagnostic scope. */
export interface DiagnosticNode {
  readonly id: string
  /** Prerequisites within the scope. */
  readonly requires: readonly string[]
  /** Whether a diagnostic item exists for this skill. */
  readonly askable: boolean
}

/** A learner's answer to one diagnostic item. */
export type DiagnosticAnswer = 'correct' | 'wrong' | 'dont-know'

/** One recorded answer. */
export interface DiagnosticObservation {
  readonly skillId: string
  readonly answer: DiagnosticAnswer
}

/** Diagnostic configuration (persisted with the session). */
export interface DiagnosticConfig {
  readonly strategy: 'halfsplit' | 'propagation'
  readonly seed: number
  readonly particles: number
  readonly slip: number
  readonly guess: number
  readonly minQuestions: number
  readonly maxQuestions: number
  readonly targetError: number
  /** Consecutive "I don't know" answers that end the diagnostic. */
  readonly fatigueDontKnow: number
  /** Weak priors per skill (e.g. from self-report), in (0, 1). */
  readonly priors: Readonly<Record<string, number>>
  /** Exponent applied to prior pseudo-observations (0 = ignore, 1 = full weight). */
  readonly priorWeight: number
}

/** Defaults from the research simulation. */
export const DEFAULT_DIAGNOSTIC_CONFIG: Omit<DiagnosticConfig, 'strategy' | 'seed' | 'priors'> = {
  particles: 3000,
  slip: 0.1,
  guess: 0.2,
  minQuestions: 5,
  maxQuestions: 25,
  targetError: 0.05,
  fatigueDontKnow: 3,
  priorWeight: 0.5,
}

/** Scopes smaller than this use the propagation strategy. */
export const HALFSPLIT_MIN_NODES = 6

/** Result of a finished (or current) diagnostic. */
export interface DiagnosticEstimate {
  /** Estimated probability each skill is known. */
  readonly marginals: Readonly<Record<string, number>>
  /** Skills classified known: marginal ≥ 0.5 and backed by an observed answer (never by a prior alone). */
  readonly known: readonly string[]
  /** Expected per-skill misclassification, mean of min(m, 1 − m). */
  readonly expectedError: number
  readonly questions: number
}

/**
 * Choose the strategy for a scope.
 * @param nodes - scope nodes.
 * @returns `halfsplit` for scopes with enough askable skills, otherwise `propagation`.
 */
export function chooseStrategy(nodes: readonly DiagnosticNode[]): DiagnosticConfig['strategy'] {
  return nodes.filter(n => n.askable).length >= HALFSPLIT_MIN_NODES ? 'halfsplit' : 'propagation'
}

/** A live diagnostic session. */
export class Diagnostic {
  private readonly ids: readonly string[]
  private readonly index: ReadonlyMap<string, number>
  private readonly ancestors: readonly ReadonlySet<number>[]
  private readonly descendants: readonly ReadonlySet<number>[]
  private readonly askable: readonly boolean[]
  private readonly levels: readonly number[]
  private readonly rng: Random
  private particles: Uint8Array[] = []
  private weights: number[] = []
  private readonly asked = new Map<number, number>()
  private readonly resolved = new Map<number, boolean>()
  private readonly log: DiagnosticObservation[] = []

  /**
   * @param nodes - the scope (must be closed under `requires` within itself).
   * @param config - configuration.
   * @param observations - answers to replay (restores a persisted session).
   * @throws {HodosError} `INVALID_INPUT` for an empty scope or unknown prerequisite.
   */
  constructor(nodes: readonly DiagnosticNode[], readonly config: DiagnosticConfig, observations: readonly DiagnosticObservation[] = []) {
    if (nodes.length === 0) throw new HodosError('INVALID_INPUT', 'the diagnostic scope is empty')
    this.ids = nodes.map(n => n.id)
    this.index = new Map(this.ids.map((id, i) => [id, i]))
    const parents = nodes.map(n => n.requires.map(r => {
      const i = this.index.get(r)
      if (i === undefined) throw new HodosError('INVALID_INPUT', `skill ${n.id} requires ${r}, which is outside the scope`)
      return i
    }))
    const anc: Set<number>[] = nodes.map(() => new Set<number>())
    const visit = (i: number, into: Set<number>): void => {
      for (const p of parents[i] ?? []) if (!into.has(p)) { into.add(p); visit(p, into) }
    }
    nodes.forEach((_, i) => visit(i, anc[i] ?? new Set()))
    this.ancestors = anc
    this.descendants = nodes.map((_, i) => new Set(nodes.map((__, j) => j).filter(j => anc[j]?.has(i))))
    this.askable = nodes.map(n => n.askable)
    const memo = new Map<number, number>()
    const depth = (i: number): number => {
      const cached = memo.get(i)
      if (cached !== undefined) return cached
      const d = (parents[i] ?? []).reduce((m, p) => Math.max(m, depth(p) + 1), 0)
      memo.set(i, d)
      return d
    }
    this.levels = nodes.map((_, i) => depth(i))
    this.rng = seededRandom(config.seed)
    if (config.strategy === 'halfsplit') this.initParticles(nodes)
    for (const obs of observations) this.observe(obs.skillId, obs.answer)
  }

  /** The answers recorded so far. */
  get observations(): readonly DiagnosticObservation[] {
    return this.log
  }

  private initParticles(nodes: readonly DiagnosticNode[]): void {
    const levels = this.levels
    const maxLevel = Math.max(0, ...levels)
    const k = this.config.particles
    for (let p = 0; p < k; p++) {
      const ability = -1 + this.rng.next() * (maxLevel + 2)
      const raw = new Uint8Array(nodes.length)
      levels.forEach((lv, i) => { raw[i] = lv + gaussian(this.rng) < ability ? 1 : 0 })
      const closed = new Uint8Array(nodes.length)
      for (let i = 0; i < nodes.length; i++) {
        if (raw[i] === 1 && [...(this.ancestors[i] ?? [])].every(a => raw[a] === 1)) closed[i] = 1
      }
      this.particles.push(closed)
    }
    this.weights = Array.from({ length: k }, () => 1 / k)
    // Priors act as weak pseudo-observations, never as verified knowledge.
    for (const [id, prior] of Object.entries(this.config.priors)) {
      const i = this.index.get(id)
      if (i === undefined || !(prior > 0 && prior < 1)) continue
      this.particles.forEach((particle, p) => {
        const like = particle[i] === 1 ? prior : 1 - prior
        this.weights[p] = (this.weights[p] ?? 0) * like ** this.config.priorWeight
      })
    }
    this.normalize()
  }

  private normalize(): void {
    const z = this.weights.reduce((a, b) => a + b, 0)
    if (z <= 0 || !Number.isFinite(z)) {
      this.weights = this.weights.map(() => 1 / this.weights.length)
      return
    }
    this.weights = this.weights.map(w => w / z)
  }

  /**
   * Current marginal probability that each skill is known.
   * @returns marginals by skill id.
   */
  marginals(): Record<string, number> {
    const out: Record<string, number> = {}
    if (this.config.strategy === 'halfsplit') {
      const m = Array.from({ length: this.ids.length }, () => 0)
      this.particles.forEach((particle, p) => {
        const w = this.weights[p] ?? 0
        for (let i = 0; i < this.ids.length; i++) if (particle[i] === 1) m[i] = (m[i] ?? 0) + w
      })
      this.ids.forEach((id, i) => { out[id] = Math.min(1, Math.max(0, m[i] ?? 0)) })
      return out
    }
    this.ids.forEach((id, i) => {
      const r = this.resolved.get(i)
      const prior = this.config.priors[id]
      // Unresolved skills stay below 0.5: a prior alone never classifies a skill as known.
      out[id] = r === undefined ? Math.min(prior ?? 0.3, 0.45) : r ? 1 - this.config.slip : this.config.guess
    })
    return out
  }

  /**
   * Whether an answer supports classifying a skill: the skill itself was
   * asked, or a skill that requires it was answered correctly.
   * @param i - skill index.
   * @returns true when the classification rests on observed answers.
   */
  private evidenceBacked(i: number): boolean {
    if ((this.asked.get(i) ?? 0) > 0) return true
    return this.log.some(o => {
      const j = this.index.get(o.skillId)
      return o.answer === 'correct' && j !== undefined && (this.ancestors[j]?.has(i) ?? false)
    })
  }

  /** Expected misclassification rate, mean of min(m, 1 − m). */
  expectedError(): number {
    const m = Object.values(this.marginals())
    return m.reduce((acc, v) => acc + Math.min(v, 1 - v), 0) / m.length
  }

  /**
   * Whether the diagnostic should stop now.
   * @returns true when the target error, question cap, fatigue or exhaustion is reached.
   */
  isComplete(): boolean {
    const q = this.log.length
    if (q >= this.config.maxQuestions) return true
    const tail = this.log.slice(-this.config.fatigueDontKnow)
    if (tail.length === this.config.fatigueDontKnow && tail.every(o => o.answer === 'dont-know')) return true
    if (this.nextSkill() === null) return true
    if (this.config.strategy === 'propagation') return this.ids.every((_, i) => this.resolved.has(i) || !this.askable[i])
    return q >= Math.min(this.config.minQuestions, this.askable.filter(Boolean).length) && this.expectedError() < this.config.targetError
  }

  /**
   * The next skill to ask about.
   * @returns a skill id, or null when nothing useful remains to ask.
   */
  nextSkill(): string | null {
    if (this.config.strategy === 'propagation') {
      // Binary search on the DAG: prefer the skill whose answer resolves the
      // most balanced split of the unresolved skills (ancestors vs dependents).
      let best: number | null = null
      let bestBalance = -1
      let bestRelatives = -1
      this.ids.forEach((_, i) => {
        if (!this.askable[i] || this.resolved.has(i)) return
        const up = [...(this.ancestors[i] ?? [])].filter(j => !this.resolved.has(j)).length
        const down = [...(this.descendants[i] ?? [])].filter(j => !this.resolved.has(j)).length
        const balance = Math.min(1 + up, 1 + down)
        if (balance > bestBalance || (balance === bestBalance && up + down > bestRelatives)) {
          best = i
          bestBalance = balance
          bestRelatives = up + down
        }
      })
      return best === null ? null : this.ids[best] ?? null
    }
    const m = this.marginals()
    const candidates = this.ids.map((id, i) => ({ id, i, m: m[id] ?? 0.5 })).filter(c => this.askable[c.i] && (this.asked.get(c.i) ?? 0) < 3)
    if (candidates.length === 0) return null
    const unsure = candidates.filter(c => c.m > 0.15 && c.m < 0.85)
    const pool = unsure.length > 0 ? unsure : candidates
    let best = pool[0]
    let bestScore = Number.POSITIVE_INFINITY
    for (const c of pool) {
      const score = Math.abs(c.m - 0.5) + 0.15 * (this.asked.get(c.i) ?? 0)
      const relatives = (this.ancestors[c.i]?.size ?? 0) + (this.descendants[c.i]?.size ?? 0)
      const bestRelatives = best === undefined ? -1 : (this.ancestors[best.i]?.size ?? 0) + (this.descendants[best.i]?.size ?? 0)
      if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && relatives > bestRelatives)) {
        best = c
        bestScore = score
      }
    }
    return best?.id ?? null
  }

  /**
   * Record an answer.
   * @param skillId - the skill the item tested.
   * @param answer - correct, wrong or "I don't know".
   * @throws {HodosError} `INVALID_INPUT` for a skill outside the scope.
   */
  observe(skillId: string, answer: DiagnosticAnswer): void {
    const i = this.index.get(skillId)
    if (i === undefined) throw new HodosError('INVALID_INPUT', `skill ${skillId} is outside the diagnostic scope`)
    this.log.push({ skillId, answer })
    this.asked.set(i, (this.asked.get(i) ?? 0) + 1)
    if (this.config.strategy === 'propagation') {
      if (answer === 'correct') {
        this.resolved.set(i, true)
        for (const a of this.ancestors[i] ?? []) this.resolved.set(a, true)
      } else {
        this.resolved.set(i, false)
        for (const d of this.descendants[i] ?? []) this.resolved.set(d, false)
      }
      return
    }
    const { slip, guess } = this.config
    this.particles.forEach((particle, p) => {
      const knows = particle[i] === 1
      let like: number
      if (answer === 'correct') like = knows ? 1 - slip : guess
      else if (answer === 'wrong') like = knows ? slip : 1 - guess
      else like = knows ? slip : 1 // "I don't know": wrong with no guessing
      this.weights[p] = (this.weights[p] ?? 0) * like
    })
    this.normalize()
    const ess = 1 / this.weights.reduce((acc, w) => acc + w * w, 0)
    if (ess < this.particles.length / 4) this.resample()
  }

  private resample(): void {
    const k = this.particles.length
    const cumulative: number[] = []
    let acc = 0
    for (const w of this.weights) { acc += w; cumulative.push(acc) }
    const next: Uint8Array[] = []
    for (let p = 0; p < k; p++) {
      const u = this.rng.next() * acc
      let lo = 0
      let hi = k - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((cumulative[mid] ?? 0) < u) lo = mid + 1
        else hi = mid
      }
      next.push(this.particles[lo] ?? new Uint8Array(this.ids.length))
    }
    this.particles = next
    this.weights = Array.from({ length: k }, () => 1 / k)
  }

  /**
   * The current estimate.
   * @returns marginals, known skills, expected error and question count.
   */
  estimate(): DiagnosticEstimate {
    const marginals = this.marginals()
    return {
      marginals,
      known: this.ids.filter((id, i) => (marginals[id] ?? 0) >= 0.5 && this.evidenceBacked(i)),
      expectedError: this.expectedError(),
      questions: this.log.length,
    }
  }
}
