/**
 * The platform-owned skill state and its update rules. Four estimators form
 * a closed set selected by the skill's learning loop; each keeps its own
 * state and semantics, and all expose a normalized `pMastered`.
 *
 * | loop             | estimator    | gate |
 * |------------------|--------------|------|
 * | explain-check    | BKT-lite     | P ≥ θ, distinct items, unassisted checkpoint successes |
 * | recognize-fast   | Elo          | index ≥ 0.5, fluency, distinct items, checkpoint successes |
 * | attempt-critique | oracle       | posterior ≥ target, ≥ 2 distinct unassisted checkpoint successes |
 * | drill            | item FSRS    | ≥ 90% of items acquired, checkpoint successes |
 * @module @hodos/core/mastery/skill-state
 */
import { unreachable, type ExerciseMode, type LearningLoop, type SkillKind } from '@hodos/plugin-sdk'
import { bktUpdate, bktUpdateMulti, clampP, type BktMode } from './bkt.js'
import type { MasteryConfig } from './config.js'
import { eloFromPrior, eloPMastered, eloUpdate, recentMedian, type ItemCalibration } from './elo.js'
import { FsrsScheduler, gradeRetrieval, type MemoryCard } from './fsrs.js'
import { oracleFromPrior, oracleLowerBound, oraclePMastered, oracleUpdate } from './oracle.js'

/** The closed set of estimators. */
export type EstimatorId = 'bkt' | 'elo' | 'oracle' | 'fsrs-items'

/** Estimator per loop. Not configurable by plugins. */
export const ESTIMATOR_FOR_LOOP: Readonly<Record<LearningLoop, EstimatorId>> = {
  'explain-check': 'bkt',
  'recognize-fast': 'elo',
  'attempt-critique': 'oracle',
  drill: 'fsrs-items',
}

/** Retrieval state of one fact item. */
export interface FactItemState {
  readonly card: MemoryCard | null
  /** Latest unassisted recall was correct. */
  readonly acquired: boolean
  readonly correct: number
  readonly attempts: number
}

/** Estimator-private state, discriminated by estimator. */
export type EstimatorState =
  | { readonly estimator: 'bkt'; readonly p: number }
  | { readonly estimator: 'elo'; readonly theta: number; readonly n: number }
  | { readonly estimator: 'oracle'; readonly outcomes: readonly number[] }
  | { readonly estimator: 'fsrs-items'; readonly items: Readonly<Record<string, FactItemState>> }

/** One unassisted checkpoint success. */
export interface CheckpointSuccess {
  readonly itemId: string
  readonly guessable: boolean
}

/** Persisted learner state for one skill (derived from evidence). */
export interface SkillState {
  readonly skillId: string
  readonly kind: SkillKind
  readonly loop: LearningLoop
  readonly est: EstimatorState
  readonly pMastered: number
  readonly confidence: number
  /** Where the starting estimate came from. Self-report never opens a gate. */
  readonly priorSource: 'none' | 'diagnostic' | 'self-report'
  /** The diagnostic classified the skill as known; the path skips it, the gate stays closed. */
  readonly diagnosedKnown: boolean
  readonly evidenceCount: number
  /** Distinct items that produced mastery evidence. */
  readonly masteryItems: readonly string[]
  readonly checkpointSuccesses: readonly CheckpointSuccess[]
  readonly checkpointFailures: number
  readonly assistedAttempts: number
  /** Recent unassisted correct latencies, for fluency. */
  readonly latenciesMs: readonly number[]
  readonly misconceptions: Readonly<Record<string, { readonly count: number; readonly last: string }>>
  /** Skill-level FSRS card; set when the gate opens. */
  readonly card: MemoryCard | null
  readonly gateOpen: boolean
  readonly gateOpenedAt: string | null
  readonly lastEvidenceAt: string | null
}

/** Context facts about the skill that live outside the state. */
export interface SkillContext {
  /** Number of items in the skill's fact deck (drill skills). */
  readonly deckSize?: number
  /** Fluency target for pattern skills, seconds. */
  readonly fluencyTargetSec?: number
}

/**
 * Create the starting state of a skill.
 * @param skillId - skill id.
 * @param kind - knowledge kind.
 * @param loop - learning loop (from the kind and preset).
 * @param config - mastery configuration.
 * @param prior - optional starting estimate and where it came from.
 * @returns the initial state; never gate-open.
 */
export function initialSkillState(
  skillId: string,
  kind: SkillKind,
  loop: LearningLoop,
  config: MasteryConfig,
  prior?: { readonly p: number; readonly source: 'diagnostic' | 'self-report' },
): SkillState {
  const estimator = ESTIMATOR_FOR_LOOP[loop]
  // Self-report is biased (intelligent-tutoring §4.2): it moves the prior at most halfway to its claim.
  const p0 = prior === undefined
    ? config.bkt.p0
    : prior.source === 'self-report' ? config.bkt.p0 + (prior.p - config.bkt.p0) * 0.5 : prior.p
  let est: EstimatorState
  switch (estimator) {
    case 'bkt': est = { estimator, p: clampP(p0) }; break
    case 'elo': { const s = eloFromPrior(p0, config.elo); est = { estimator, theta: s.theta, n: 0 }; break }
    case 'oracle': est = { estimator, outcomes: prior?.source === 'diagnostic' ? oracleFromPrior(p0).outcomes : [] }; break
    case 'fsrs-items': est = { estimator, items: {} }; break
  }
  const base: SkillState = {
    skillId, kind, loop, est,
    pMastered: 0,
    confidence: 0,
    priorSource: prior?.source ?? 'none',
    diagnosedKnown: false,
    evidenceCount: 0,
    masteryItems: [],
    checkpointSuccesses: [],
    checkpointFailures: 0,
    assistedAttempts: 0,
    latenciesMs: [],
    misconceptions: {},
    card: null,
    gateOpen: false,
    gateOpenedAt: null,
    lastEvidenceAt: null,
  }
  return { ...base, pMastered: normalizedMastery(base, {}, new Date(0), config) }
}

/** One graded attempt as the mastery model sees it, for every skill on the item. */
export interface ItemObservation {
  readonly itemId: string
  readonly mode: ExerciseMode
  /** Per-skill score in [0, 1] and the skill's weight on the item. */
  readonly skills: ReadonlyArray<{ readonly skillId: string; readonly score: number; readonly weight: number }>
  /** Effective hint level 0..5, including tutor-relay and tutor-contact charges. */
  readonly hintLevel: number
  /** Any assistance: hints, relayed answer, or tutor contact during the attempt. */
  readonly assisted: boolean
  readonly difficulty: number
  readonly options?: number
  readonly guessable: boolean
  /** False for retries after a wrong first attempt (first-miss rule, ADR-0005). */
  readonly countsForMastery: boolean
  /** Graded by an advisory method (AI rubric): informs estimates, never counts as a checkpoint success. */
  readonly advisory?: boolean
  readonly latencyMs?: number
  readonly expectedTimeSec?: number
  readonly confidence?: 'sure' | 'unsure'
  readonly misconceptions: readonly string[]
  readonly at: Date
}

/** Shared mutable dependencies for applying evidence. */
export interface ApplyContext {
  readonly config: MasteryConfig
  readonly scheduler: FsrsScheduler
  /** Elo item calibration lookup and write-back (instance-wide). */
  readonly calibration?: {
    get(itemId: string, fallbackB: number): ItemCalibration
    set(itemId: string, value: ItemCalibration): void
  }
  readonly skillContext: (skillId: string) => SkillContext
}

/**
 * Apply one graded attempt to the states of the item's skills.
 * Diagnostic answers do not reach this function; they initialize priors.
 * @param states - current states by skill id (must contain every tagged skill).
 * @param obs - the observation.
 * @param ctx - configuration and shared dependencies.
 * @returns new states for the tagged skills (others unchanged).
 */
export function applyItemObservation(
  states: ReadonlyMap<string, SkillState>,
  obs: ItemObservation,
  ctx: ApplyContext,
): Map<string, SkillState> {
  const out = new Map(states)
  if (obs.mode === 'diagnostic') return out
  const mode: BktMode = obs.mode
  const { config } = ctx
  const hintLevel = Math.max(0, Math.min(config.bkt.maxHintLevel, Math.round(obs.hintLevel)))
  const h = hintLevel / config.bkt.maxHintLevel
  const evidenceOf = (score: number): number => Math.min(1, Math.max(0, score)) * (1 - h)

  // BKT skills: a joint conjunctive update when every skill got the same score,
  // otherwise per-skill updates (the grader attributed the outcome).
  const bktSkills = obs.skills.filter(s => out.get(s.skillId)?.est.estimator === 'bkt')
  const bktNext = new Map<string, number>()
  if (obs.countsForMastery && bktSkills.length > 0) {
    const sameScore = bktSkills.every(s => s.score === bktSkills[0]?.score)
    if (sameScore && bktSkills.length > 1) {
      const prior: Record<string, number> = {}
      for (const s of bktSkills) {
        const st = out.get(s.skillId)
        if (st?.est.estimator === 'bkt') prior[s.skillId] = st.est.p
      }
      const next = bktUpdateMulti(prior, bktSkills.map(s => [s.skillId, s.weight] as const), {
        x: bktSkills[0]?.score ?? 0, hintLevel, b: obs.difficulty, mode, ...(obs.options === undefined ? {} : { options: obs.options }),
      }, config.bkt)
      for (const s of bktSkills) bktNext.set(s.skillId, next[s.skillId] ?? config.bkt.p0)
    } else {
      for (const s of bktSkills) {
        const st = out.get(s.skillId)
        if (st?.est.estimator !== 'bkt') continue
        bktNext.set(s.skillId, bktUpdate(st.est.p, {
          x: s.score, hintLevel, b: obs.difficulty, mode, ...(obs.options === undefined ? {} : { options: obs.options }),
        }, config.bkt))
      }
    }
  }

  for (const tag of obs.skills) {
    const prev = out.get(tag.skillId)
    if (prev === undefined) continue
    const e = evidenceOf(tag.score)
    let est = prev.est
    if (obs.countsForMastery) {
      switch (est.estimator) {
        case 'bkt':
          est = { estimator: 'bkt', p: bktNext.get(tag.skillId) ?? est.p }
          break
        case 'elo': {
          const item = ctx.calibration?.get(obs.itemId, obs.difficulty) ?? { b: obs.difficulty, m: 0 }
          const next = eloUpdate({ theta: est.theta, n: est.n }, item, e, mode, config.elo)
          ctx.calibration?.set(obs.itemId, next.item)
          est = { estimator: 'elo', theta: next.state.theta, n: next.state.n }
          break
        }
        case 'oracle':
          est = { estimator: 'oracle', outcomes: oracleUpdate({ outcomes: est.outcomes }, e).outcomes }
          break
        case 'fsrs-items': {
          const item = est.items[obs.itemId] ?? { card: null, acquired: false, correct: 0, attempts: 0 }
          const grade = gradeRetrieval({
            evidence: e, assisted: obs.assisted, bottomOut: hintLevel >= config.bkt.maxHintLevel,
            ...(obs.latencyMs !== undefined && obs.expectedTimeSec ? { speedRatio: obs.latencyMs / (obs.expectedTimeSec * 1000) } : {}),
            ...(obs.confidence === undefined ? {} : { confidence: obs.confidence }),
          })
          const success = e >= config.checkpointSuccessEvidence
          est = {
            estimator: 'fsrs-items',
            items: {
              ...est.items,
              [obs.itemId]: {
                card: ctx.scheduler.review(item.card, grade, obs.at),
                acquired: obs.assisted ? item.acquired && success : success,
                correct: item.correct + (success ? 1 : 0),
                attempts: item.attempts + 1,
              },
            },
          }
          break
        }
      }
    }

    const at = obs.at.toISOString()
    const misconceptions = { ...prev.misconceptions }
    for (const m of obs.misconceptions) misconceptions[m] = { count: (misconceptions[m]?.count ?? 0) + 1, last: at }
    const unassistedSuccess = obs.countsForMastery && !obs.assisted && e >= config.checkpointSuccessEvidence
    const checkpointSuccesses = obs.mode === 'checkpoint' && unassistedSuccess && obs.advisory !== true
      && !prev.checkpointSuccesses.some(c => c.itemId === obs.itemId)
      ? [...prev.checkpointSuccesses, { itemId: obs.itemId, guessable: obs.guessable }]
      : prev.checkpointSuccesses
    const latenciesMs = unassistedSuccess && obs.latencyMs !== undefined
      ? [...prev.latenciesMs, obs.latencyMs].slice(-10)
      : prev.latenciesMs

    // A graduated skill's review schedule moves with every review-mode answer.
    let card = prev.card
    if (obs.mode === 'review' && card !== null && obs.countsForMastery) {
      card = ctx.scheduler.review(card, gradeRetrieval({ evidence: e, assisted: obs.assisted, bottomOut: hintLevel >= config.bkt.maxHintLevel }), obs.at)
    }

    let next: SkillState = {
      ...prev,
      est,
      evidenceCount: prev.evidenceCount + (obs.countsForMastery ? 1 : 0),
      masteryItems: obs.countsForMastery && !prev.masteryItems.includes(obs.itemId) ? [...prev.masteryItems, obs.itemId] : prev.masteryItems,
      checkpointSuccesses,
      checkpointFailures: prev.checkpointFailures + (obs.mode === 'checkpoint' && obs.countsForMastery && !unassistedSuccess ? 1 : 0),
      assistedAttempts: prev.assistedAttempts + (obs.assisted ? 1 : 0),
      latenciesMs,
      misconceptions,
      card,
      lastEvidenceAt: at,
    }
    next = refreshDerived(next, ctx.skillContext(tag.skillId), obs.at, ctx)
    out.set(tag.skillId, next)
  }
  return out
}

/**
 * Recompute `pMastered`, `confidence` and the gate; graduate the skill's FSRS
 * card into Review state the first time the gate opens.
 * @param state - state with updated estimator data.
 * @param skill - skill context.
 * @param now - evaluation time.
 * @param ctx - configuration and scheduler.
 * @returns the refreshed state.
 */
export function refreshDerived(state: SkillState, skill: SkillContext, now: Date, ctx: Pick<ApplyContext, 'config' | 'scheduler'>): SkillState {
  const pMastered = normalizedMastery(state, skill, now, ctx.config, ctx.scheduler)
  const withP: SkillState = { ...state, pMastered, confidence: estimateConfidence(state) }
  if (withP.gateOpen) return withP
  const gate = evaluateGate(withP, skill, ctx.config)
  if (!gate.open) return withP
  return {
    ...withP,
    gateOpen: true,
    gateOpenedAt: now.toISOString(),
    card: withP.card ?? ctx.scheduler.review(null, 3, now),
  }
}

/**
 * Normalized mastery index for any estimator.
 * @param state - the state.
 * @param skill - skill context (deck size for fact skills).
 * @param now - evaluation time (fact retrievability).
 * @param config - configuration.
 * @param scheduler - FSRS scheduler for fact retrievability.
 * @returns pMastered in [0, 1].
 */
export function normalizedMastery(
  state: SkillState,
  skill: SkillContext,
  now: Date,
  config: MasteryConfig,
  scheduler: FsrsScheduler = new FsrsScheduler(config.targetRetention),
): number {
  const est = state.est
  switch (est.estimator) {
    case 'bkt': return est.p
    case 'elo': return eloPMastered({ theta: est.theta, n: est.n }, config.elo)
    case 'oracle': return oraclePMastered({ outcomes: est.outcomes })
    case 'fsrs-items': {
      const items = Object.values(est.items)
      const deck = Math.max(skill.deckSize ?? 0, items.length)
      if (deck === 0) return 0
      const sum = items.reduce((acc, it) => acc + (it.acquired && it.card !== null ? scheduler.retrievability(it.card, now) : 0), 0)
      return sum / deck
    }
    default: return unreachable(est, 'estimator state')
  }
}

function estimateConfidence(state: SkillState): number {
  const est = state.est
  switch (est.estimator) {
    case 'bkt': return Math.min(1, state.evidenceCount / 6) * Math.abs(2 * est.p - 1)
    case 'elo': return 1 - 1 / (1 + est.n / 5)
    case 'oracle': return est.outcomes.length === 0 ? 0 : Math.min(1, oracleLowerBound({ outcomes: est.outcomes }) / Math.max(1e-9, oraclePMastered({ outcomes: est.outcomes })))
    case 'fsrs-items': {
      const items = Object.values(est.items)
      return items.length === 0 ? 0 : items.filter(i => i.attempts >= 2).length / items.length
    }
    default: return unreachable(est, 'estimator state')
  }
}

/** Gate evaluation result. `unmet` lists every unmet condition in plain language. */
export interface GateResult {
  readonly open: boolean
  readonly unmet: readonly string[]
}

/**
 * Evaluate the mastery gate (PRD MS-2, ADR-0005). Self-reported priors and
 * diagnostic classification never satisfy the checkpoint clause.
 * @param state - the skill state.
 * @param skill - skill context.
 * @param config - configuration.
 * @returns whether the gate is open and what is missing.
 */
export function evaluateGate(state: SkillState, skill: SkillContext, config: MasteryConfig): GateResult {
  const unmet: string[] = []
  const distinct = state.masteryItems.length
  const successes = state.checkpointSuccesses
  const resistant = successes.filter(s => !s.guessable).length
  // Guessable formats need several distinct successes; one success on a guess-resistant item suffices (ADR-0005).
  const checkpointClause = (): void => {
    if (resistant >= config.checkpointSuccessesGuessResistant || successes.length >= config.checkpointSuccessesGuessable) return
    unmet.push(`needs unassisted checkpoint successes on distinct items (${successes.length} of ${config.checkpointSuccessesGuessable}; ${config.checkpointSuccessesGuessResistant} on a guess-resistant item also suffices)`)
  }
  const est = state.est
  switch (est.estimator) {
    case 'bkt':
      if (est.p < config.theta) unmet.push(`evidence index ${est.p.toFixed(2)} is below the ${config.theta.toFixed(2)} threshold`)
      if (distinct < config.minDistinctItems) unmet.push(`needs evidence from ${config.minDistinctItems} distinct items (has ${distinct})`)
      checkpointClause()
      break
    case 'elo': {
      const index = eloPMastered({ theta: est.theta, n: est.n }, config.elo)
      if (index < config.eloThreshold) unmet.push(`rating index ${index.toFixed(2)} is below ${config.eloThreshold.toFixed(2)}`)
      if (distinct < config.minDistinctItems) unmet.push(`needs evidence from ${config.minDistinctItems} distinct items (has ${distinct})`)
      checkpointClause()
      if (skill.fluencyTargetSec !== undefined) {
        const median = recentMedian(state.latenciesMs)
        if (median === null) unmet.push('needs timed unassisted successes')
        else if (median > skill.fluencyTargetSec * 1000) unmet.push(`median response ${(median / 1000).toFixed(0)}s exceeds the ${skill.fluencyTargetSec}s fluency target`)
      }
      break
    }
    case 'oracle': {
      const mean = oraclePMastered({ outcomes: est.outcomes })
      if (mean < config.oracleTarget) unmet.push(`success rate ${mean.toFixed(2)} is below ${config.oracleTarget.toFixed(2)}`)
      if (successes.length < config.oracleCheckpointSuccesses) unmet.push(`needs ${config.oracleCheckpointSuccesses - successes.length} more unassisted checkpoint success(es) on distinct tasks`)
      break
    }
    case 'fsrs-items': {
      const items = Object.values(est.items)
      const deck = Math.max(skill.deckSize ?? 0, items.length)
      const acquired = items.filter(i => i.acquired).length
      const needed = Math.ceil(deck * config.factAcquiredShare)
      if (deck === 0 || acquired < needed) unmet.push(`needs ${needed} of ${deck} items recalled unassisted (has ${acquired})`)
      const recallNeeded = Math.min(config.checkpointSuccessesGuessable, Math.max(1, deck))
      if (successes.length < recallNeeded) unmet.push(`needs ${recallNeeded - successes.length} more unassisted checkpoint recall(s) on distinct items`)
      break
    }
  }
  return { open: unmet.length === 0, unmet }
}

/**
 * Effective (currently usable) mastery: pMastered × R(now) for graduated skills.
 * @param state - the state.
 * @param now - evaluation time.
 * @param scheduler - FSRS scheduler.
 * @returns the index in [0, 1].
 */
export function effectiveMastery(state: SkillState, now: Date, scheduler: FsrsScheduler): number {
  return state.card === null ? state.pMastered : state.pMastered * scheduler.retrievability(state.card, now)
}
