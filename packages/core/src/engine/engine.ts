/**
 * The Hodos engine: the application service behind every host surface
 * (agent tools, HTTP API, UI). It enforces identity and mode policy, records
 * append-only evidence, derives mastery, drives the learning protocol and
 * returns only student-view data that passed the leak guard.
 *
 * The engine never trusts plugin output, model-supplied identifiers or
 * client-supplied state: grades are validated evidence, identity comes from
 * the {@link Actor} the host constructs, and checkpoint answers must come
 * from the learner's own channel.
 * @module @hodos/core/engine
 */
import {
  DEFAULT_LOOP_FOR_KIND,
  type CourseSpec,
  type ExerciseItem,
  type ExerciseMode,
  type GradeResult,
  type JsonObject,
  type JsonValue,
  type LearningLoop,
  type LessonNode,
  type SkillSpec,
  validateCourseShape,
} from '@hodos/plugin-sdk'
import { systemClock, type Clock } from '../clock.js'
import { blockLookup, validateCourse } from '../content/course.js'
import { lessonChecks, lessonPlainText, lessonServerFragments, parseLesson, projectLessonForStudent, stampBlockIds } from '../content/lesson.js'
import { chooseStrategy, DEFAULT_DIAGNOSTIC_CONFIG, Diagnostic, type DiagnosticConfig, type DiagnosticNode } from '../diagnostic/diagnostic.js'
import { HodosError } from '../errors.js'
import { SkillGraph } from '../graph/skill-graph.js'
import { brandId, randomIds, type IdGenerator, type JourneyId, type LearnerId } from '../ids.js'
import { DEFAULT_LIMITS, RateLimiter } from '../limits/rate-limiter.js'
import { itemGuessSlip } from '../mastery/bkt.js'
import { DEFAULT_MASTERY_CONFIG, THETA_BY_STRICTNESS } from '../mastery/config.js'
import { expectedSuccess } from '../mastery/elo.js'
import { FsrsScheduler } from '../mastery/fsrs.js'
import {
  applyItemObservation,
  effectiveMastery,
  evaluateGate,
  initialSkillState,
  normalizedMastery,
  type ApplyContext,
  type SkillContext,
  type SkillState,
} from '../mastery/skill-state.js'
import { selectItem } from '../practice/select.js'
import { assertNoLeak, MIN_SECRET_LENGTH, presentExercise, scanForLeaks, secretFragments } from '../projection/student-view.js'
import { initialJourneyState, transition, type JourneyEvent, type JourneyState } from '../protocol/journey.js'
import { hashSeed, seededRandom } from '../random.js'
import type { PluginRegistry } from '../registry/registry.js'
import type { CourseRecord, EvidenceRecord, HodosStore, ItemFacts, JourneyRecord, PresentationRecord, SkillFacts } from '../store/store.js'
import { DEFAULT_HINT_PACING, MODE_POLICY, nextHintLevel, STUCK_AFTER_WRONG } from '../tutor/policy.js'
import type {
  Actor,
  AttemptView,
  CheckAnswerView,
  CheckpointView,
  EngineConfig,
  EngineEvent,
  ExerciseView,
  HintView,
  JourneyView,
  LessonView,
  NextAction,
  ProgressView,
  SelfReport,
  SkillView,
} from './types.js'

/** Default engine configuration. */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  mastery: DEFAULT_MASTERY_CONFIG,
  hintPacing: DEFAULT_HINT_PACING,
  limits: DEFAULT_LIMITS,
  checkpointSize: 3,
  checkpointCooldownSec: 60,
  maxAdaptationsPerSkillPerDay: 3,
  interleaveProbability: 0.25,
  requireLessonChecks: true,
  agentMayApproveShippedPaths: true,
  diagnostic: { particles: 2000, minQuestions: 4, maxQuestions: 12 },
  seed: 20261026,
}

/** Engine dependencies. */
export interface EngineDeps {
  readonly store: HodosStore
  readonly registry: PluginRegistry
  readonly clock?: Clock
  readonly ids?: IdGenerator
  readonly config?: Partial<EngineConfig>
  readonly logger?: { info(m: string): void; warn(m: string): void; error(m: string): void }
}

const SELF_REPORT_PRIOR = { never: 0.05, 'heard-of': 0.3, 'used-it': 0.6 } as const

interface LoadedCourse {
  readonly record: CourseRecord
  readonly spec: CourseSpec
  readonly graph: SkillGraph
  readonly items: ReadonlyMap<string, ExerciseItem>
}

function tokens(text: string): string[] {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(t => t.length >= 3)
}

/** The engine. One instance per store. */
export class HodosEngine {
  readonly config: EngineConfig
  private readonly store: HodosStore
  private readonly registry: PluginRegistry
  private readonly clock: Clock
  private readonly ids: IdGenerator
  private readonly limiter: RateLimiter
  private readonly scheduler: FsrsScheduler
  private readonly courseCache = new Map<string, LoadedCourse>()
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private readonly logger: NonNullable<EngineDeps['logger']>

  /** @param deps - store, registry and optional clock, ids, config and logger. */
  constructor(deps: EngineDeps) {
    this.store = deps.store
    this.registry = deps.registry
    this.clock = deps.clock ?? systemClock
    this.ids = deps.ids ?? randomIds
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...deps.config }
    this.logger = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} }
    this.limiter = new RateLimiter(this.clock, this.config.limits)
    this.scheduler = new FsrsScheduler(this.config.mastery.targetRetention)
  }

  private now(): Date {
    return this.clock.now()
  }

  /**
   * Subscribe to engine events.
   * @param listener - receives events after their transaction committed.
   * @returns the unsubscriber.
   */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn(`engine listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ---------------------------------------------------------------- identity

  /**
   * Resolve an authenticated host principal to a learner, creating the learner on first use.
   * @param principal - stable principal key from the host's authentication (never from a model).
   * @param displayName - name for a new learner.
   * @returns the learner id.
   */
  learnerForPrincipal(principal: string, displayName = 'Learner'): LearnerId {
    const existing = this.store.learnerForPrincipal(principal)
    if (existing !== undefined) return existing
    const id = brandId<'LearnerId'>(this.ids.next('lrn'))
    this.store.transaction(() => {
      this.store.insertLearner({ id, displayName, settings: {}, createdAt: this.now().toISOString() })
      this.store.bindPrincipal(principal, id)
    })
    return id
  }

  /**
   * The learner bound to a host session (e.g. a DeepSeek Harness session), binding it on first use.
   * @param sessionId - host session id (trusted, from the host runtime).
   * @param defaultPrincipal - principal to bind an unbound session to.
   * @returns the learner id.
   */
  learnerForSession(sessionId: string, defaultPrincipal: string): LearnerId {
    const binding = this.store.sessionBinding(sessionId)
    if (binding !== undefined) return binding.learnerId
    const learnerId = this.learnerForPrincipal(defaultPrincipal)
    this.store.bindSession(sessionId, learnerId, null, this.now().toISOString())
    return learnerId
  }

  private assertOwner(actor: Actor, learnerId: string, what: string): void {
    if (actor.learnerId !== learnerId) {
      this.store.securityEvent('forbidden-access', actor.learnerId, { what, channel: actor.channel }, this.now().toISOString())
      this.emit({ type: 'security', learnerId: actor.learnerId, kind: 'forbidden-access' })
      throw new HodosError('FORBIDDEN', `this ${what} belongs to another learner`)
    }
  }

  // ---------------------------------------------------------------- courses

  /**
   * Import the courses of every registered content pack (validated) as approved shipped content.
   * Existing course versions are immutable and kept.
   * @returns findings per rejected course.
   */
  async syncContentPacks(): Promise<Array<{ courseId: string; errors: string[] }>> {
    const rejected: Array<{ courseId: string; errors: string[] }> = []
    for (const { pluginId, pack } of this.registry.contentPacks()) {
      for (const course of pack.courses) {
        if (this.store.course(course.id, course.version) !== undefined) continue
        const findings = await validateCourse(course, this.registry, { requireCoverage: false })
        const errors = findings.filter(f => f.severity === 'error')
        if (errors.length > 0) {
          rejected.push({ courseId: course.id, errors: errors.map(e => e.message) })
          this.logger.error(`course ${course.id}@${course.version} from ${pluginId} rejected: ${errors.map(e => e.message).join('; ')}`)
          continue
        }
        this.store.upsertCourse({
          id: course.id, version: course.version, status: 'approved', origin: 'pack', pluginId, title: course.title,
          spec: { ...course, lessons: course.lessons.map(l => ({ ...l, source: stampBlockIds(l.source, l.id) })) },
          proposedBy: null, createdAt: this.now().toISOString(), approvedAt: this.now().toISOString(),
        })
      }
    }
    return rejected
  }

  private loadCourse(id: string, version: string): LoadedCourse {
    const key = `${id}@${version}`
    const cached = this.courseCache.get(key)
    if (cached !== undefined) return cached
    const record = this.store.course(id, version)
    if (record === undefined) throw new HodosError('NOT_FOUND', `course ${key} not found`)
    const loaded: LoadedCourse = { record, spec: record.spec, graph: new SkillGraph(record.spec.skills), items: new Map(record.spec.items.map(i => [i.id, i])) }
    this.courseCache.set(key, loaded)
    return loaded
  }

  private courseAvailable(spec: CourseSpec): boolean {
    const envs = new Set(this.registry.environments())
    return spec.environments.every(e => envs.has(e))
  }

  /**
   * The approved courses (latest version of each) with availability.
   * @returns the catalog.
   */
  catalog(): Array<{ id: string; version: string; title: string; description: string; environments: string[]; available: boolean; goal: string; skills: Array<{ id: string; title: string; kind: string }> }> {
    const latest = new Map<string, CourseRecord>()
    for (const c of this.store.courses('approved')) if (!latest.has(c.id)) latest.set(c.id, c)
    return [...latest.values()].map(c => ({
      id: c.id, version: c.version, title: c.title, description: c.spec.description, environments: [...c.spec.environments],
      available: this.courseAvailable(c.spec), goal: c.spec.goal,
      skills: c.spec.skills.map(s => ({ id: s.id, title: s.title, kind: s.kind })),
    }))
  }

  private findCourse(goal: string, environment?: string, courseId?: string): CourseRecord {
    const approved = this.store.courses('approved')
    if (courseId !== undefined) {
      const c = approved.find(x => x.id === courseId)
      if (c === undefined) throw new HodosError('NOT_FOUND', `course ${courseId} is not available`)
      if (!this.courseAvailable(c.spec)) throw new HodosError('UNAVAILABLE', `course ${courseId} needs an environment that is not installed`)
      return c
    }
    const goalTokens = new Set(tokens(goal))
    const envTokens = environment === undefined ? null : new Set(tokens(environment))
    let best: CourseRecord | null = null
    let bestScore = 0
    const seen = new Set<string>()
    for (const c of approved) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (!this.courseAvailable(c.spec)) continue
      if (envTokens !== null && !c.spec.environments.some(e => tokens(e).some(t => envTokens.has(t))) && !c.spec.keywords.some(k => envTokens.has(k.toLowerCase()))) continue
      const vocabulary = new Set([...c.spec.keywords.flatMap(tokens), ...tokens(c.spec.title), ...c.spec.skills.flatMap(s => tokens(s.title))])
      const score = [...goalTokens].filter(t => vocabulary.has(t)).length + (envTokens !== null ? 0.5 : 0)
      if (score > bestScore) {
        best = c
        bestScore = score
      }
    }
    if (best === null) {
      throw new HodosError('NOT_FOUND', 'no installed course matches this goal; propose one with a validated skill graph, or install an environment', { goal: goal.slice(0, 80) })
    }
    return best
  }

  private loopFor(spec: CourseSpec, skill: SkillSpec): LearningLoop {
    const preset = spec.preset === undefined ? undefined : this.registry.preset(spec.preset)
    return preset?.kindLoops?.[skill.kind] ?? DEFAULT_LOOP_FOR_KIND[skill.kind]
  }

  private masteryConfigFor(spec: CourseSpec): EngineConfig['mastery'] {
    const preset = spec.preset === undefined ? undefined : this.registry.preset(spec.preset)
    const strictness = preset?.gate?.strictness
    return strictness === undefined ? this.config.mastery : { ...this.config.mastery, theta: THETA_BY_STRICTNESS[strictness] }
  }

  private skillContext(course: LoadedCourse, skillId: string): SkillContext {
    const skill = course.graph.has(skillId) ? course.graph.get(skillId) : undefined
    const deckSize = course.spec.items.filter(i => i.skills.some(s => s.skillId === skillId) && i.modes.includes('practice')).length
    return {
      ...(deckSize > 0 ? { deckSize } : {}),
      ...(skill?.fluencyTargetSec === undefined ? {} : { fluencyTargetSec: skill.fluencyTargetSec }),
    }
  }

  // ---------------------------------------------------------------- skill state

  private applyContext(config: EngineConfig['mastery'], contexts: ReadonlyMap<string, SkillContext>, replay: boolean, calibratedB?: number): ApplyContext {
    return {
      config,
      scheduler: this.scheduler,
      calibration: {
        get: (itemId, fallbackB) => (replay ? { b: calibratedB ?? fallbackB, m: Number.MAX_SAFE_INTEGER } : this.store.calibration(itemId) ?? { b: fallbackB, m: 0 }),
        set: (itemId, value) => { if (!replay) this.store.saveCalibration(itemId, value) },
      },
      skillContext: id => contexts.get(id) ?? {},
    }
  }

  private initialState(learnerId: string, facts: SkillFacts | { skillId: string; kind: SkillSpec['kind']; loop: LearningLoop }, config: EngineConfig['mastery']): SkillState {
    const prior = this.store.priors(learnerId).get(facts.skillId)
    const state = initialSkillState(facts.skillId, facts.kind, facts.loop, config, prior === undefined ? undefined : { p: prior.prior, source: prior.source })
    return prior?.diagnosedKnown === true ? { ...state, diagnosedKnown: true } : state
  }

  /** Apply one evidence record to the learner's derived states (inside a transaction). */
  private applyEvidence(states: Map<string, SkillState>, e: EvidenceRecord, config: EngineConfig['mastery'], replay: boolean): void {
    for (const s of e.itemFacts.skills) if (!states.has(s.skillId)) states.set(s.skillId, this.initialState(e.learnerId, s, config))
    const contexts = new Map(e.itemFacts.skills.map(s => [s.skillId, {
      ...(s.deckSize === undefined ? {} : { deckSize: s.deckSize }),
      ...(s.fluencyTargetSec === undefined ? {} : { fluencyTargetSec: s.fluencyTargetSec }),
    }]))
    const perSkill = new Map(e.grade.skillEvidence.map(x => [x.skillId, x.score]))
    const next = applyItemObservation(states, {
      itemId: e.itemId,
      mode: e.mode,
      skills: e.itemFacts.skills.map(s => ({ skillId: s.skillId, weight: s.weight, score: perSkill.get(s.skillId) ?? e.grade.score })),
      hintLevel: e.hintLevel,
      assisted: e.assisted,
      difficulty: e.itemFacts.difficulty,
      ...(e.itemFacts.options === undefined ? {} : { options: e.itemFacts.options }),
      guessable: e.itemFacts.guessable,
      countsForMastery: e.countsForMastery,
      ...(e.itemFacts.advisory === true ? { advisory: true } : {}),
      ...(e.latencyMs === null ? {} : { latencyMs: e.latencyMs }),
      ...(e.itemFacts.expectedTimeSec === undefined ? {} : { expectedTimeSec: e.itemFacts.expectedTimeSec }),
      ...(e.confidence === null ? {} : { confidence: e.confidence }),
      misconceptions: e.grade.misconceptions,
      at: new Date(e.createdAt),
    }, this.applyContext(config, contexts, replay, e.itemFacts.calibratedB))
    for (const [k, v] of next) states.set(k, v)
  }

  private states(learnerId: string): Map<string, SkillState> {
    return this.store.skillStates(learnerId)
  }

  private stateOf(learnerId: string, course: LoadedCourse, skillId: string, states?: ReadonlyMap<string, SkillState>): SkillState {
    const stored = (states ?? this.states(learnerId)).get(skillId)
    const config = this.masteryConfigFor(course.spec)
    const base = stored ?? this.initialState(learnerId, { skillId, kind: course.graph.kindOf(skillId), loop: this.loopFor(course.spec, course.graph.get(skillId)) }, config)
    const ctx = this.skillContext(course, skillId)
    // Recompute time-dependent mastery (fact retrievability) for "now" without persisting it.
    return { ...base, pMastered: normalizedMastery(base, ctx, this.now(), config, this.scheduler) }
  }

  /**
   * Rebuild a learner's derived skill state from the evidence log. Used after
   * changing mastery formulas: no learning history is lost.
   * @param learnerId - the learner.
   * @returns the number of evidence records replayed.
   */
  rebuildDerivedState(learnerId: LearnerId): number {
    return this.store.transaction(() => {
      const evidence = this.store.evidence(learnerId)
      const states = new Map<string, SkillState>()
      for (const e of evidence) {
        if (e.mode === 'diagnostic') continue
        const course = this.store.course(e.courseId, e.courseVersion)
        const config = course === undefined ? this.config.mastery : this.masteryConfigFor(course.spec)
        this.applyEvidence(states, e, config, true)
      }
      this.store.clearDerived(learnerId)
      const through = evidence.at(-1)?.seq ?? 0
      this.store.saveSkillStates(learnerId, states.values(), through, this.now().toISOString())
      return evidence.length
    })
  }

  // ---------------------------------------------------------------- views

  private skillView(learnerId: string, course: LoadedCourse, state: JourneyState, skillId: string, states: ReadonlyMap<string, SkillState>): SkillView {
    const skill = course.graph.get(skillId)
    const s = this.stateOf(learnerId, course, skillId, states)
    const config = this.masteryConfigFor(course.spec)
    const gate = s.gateOpen ? { open: true, unmet: [] as string[] } : evaluateGate(s, this.skillContext(course, skillId), config)
    const now = this.now()
    const due = s.card !== null && new Date(s.card.due) <= now
    let status: SkillView['status']
    if (s.gateOpen) status = due ? 'review-due' : 'mastered'
    else if (state.activeSkill === skillId) status = 'active'
    else if (state.diagnosedKnown.includes(skillId) || s.diagnosedKnown) status = 'known'
    else {
      const prereqsDone = course.graph.prerequisites(skillId).every(p => {
        const ps = states.get(p)
        return ps?.gateOpen === true || state.diagnosedKnown.includes(p) || state.completed.includes(p)
      })
      status = prereqsDone ? 'available' : 'locked'
    }
    return {
      id: skillId, title: skill.title, kind: skill.kind, loop: s.loop, status,
      pMastered: round(s.pMastered), effective: round(effectiveMastery(s, now, this.scheduler)), confidence: round(s.confidence),
      gateOpen: s.gateOpen, unmet: gate.unmet, evidenceCount: s.evidenceCount, dueAt: s.card?.due ?? null,
    }
  }

  private dueReviewList(learnerId: string): Array<{ skillId: string; title: string; dueAt: string; retrievability: number }> {
    const now = this.now()
    const out: Array<{ skillId: string; title: string; dueAt: string; retrievability: number }> = []
    for (const s of this.states(learnerId).values()) {
      if (!s.gateOpen || s.card === null || new Date(s.card.due) > now) continue
      out.push({ skillId: s.skillId, title: s.skillId, dueAt: s.card.due, retrievability: round(this.scheduler.retrievability(s.card, now)) })
    }
    return out.sort((a, b) => a.retrievability - b.retrievability)
  }

  private readyForCheckpoint(learnerId: string, course: LoadedCourse, skillId: string): boolean {
    const s = this.stateOf(learnerId, course, skillId)
    const unmet = evaluateGate(s, this.skillContext(course, skillId), this.masteryConfigFor(course.spec)).unmet
    return unmet.every(u => /checkpoint/.test(u))
  }

  private nextAction(journey: JourneyRecord, course: LoadedCourse): NextAction {
    const st = journey.state
    switch (st.phase) {
      case 'diagnostic': {
        const d = this.store.diagnosticForJourney(journey.id)
        const asked = d?.observations.length ?? 0
        return { type: 'diagnostic', remaining: Math.max(0, this.config.diagnostic.maxQuestions - asked) }
      }
      case 'planning': return { type: 'approve-path' }
      case 'reviewing': return { type: 'review', due: this.dueReviewList(journey.learnerId).length }
      case 'complete': {
        const due = this.dueReviewList(journey.learnerId).length
        return due > 0 ? { type: 'review', due } : { type: 'complete' }
      }
      case 'learning': {
        const skillId = st.activeSkill ?? ''
        switch (st.stage) {
          case 'teach': return { type: 'lesson', skillId }
          case 'practice': return { type: 'practice', skillId, readyForCheckpoint: this.readyForCheckpoint(journey.learnerId, course, skillId) }
          case 'checkpoint': {
            const active = this.store.checkpoints(journey.id).find(c => c.status === 'active')
            return { type: 'checkpoint', skillId, checkpointId: active?.id ?? '' }
          }
          case 'adapt':
          case 'remedial': {
            const last = this.store.checkpoints(journey.id).find(c => c.skillId === skillId)
            const adaptation = last?.result?.adaptation
            const resting = typeof adaptation === 'object' && adaptation !== null && !Array.isArray(adaptation) && adaptation.rest === true
              && last?.completedAt !== null && last?.completedAt !== undefined && last.completedAt >= startOfUtcDay(this.now())
            return resting ? { type: 'rest', reason: 'take a break from this skill today; reviews and the remedial step will be waiting' } : { type: 'remedial', skillId }
          }
          case null: return { type: 'complete' }
        }
      }
    }
  }

  private journeyView(journey: JourneyRecord): JourneyView {
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const states = this.states(journey.learnerId)
    const st = journey.state
    const goalScope = [...course.graph.ancestors(course.spec.goal), course.spec.goal]
    const views = new Map(goalScope.map(id => [id, this.skillView(journey.learnerId, course, st, id, states)]))
    const pathViews = (st.path.length > 0 ? st.path : []).filter(id => views.has(id)).map(id => views.get(id) as SkillView)
    const learnable = goalScope.filter(id => !st.diagnosedKnown.includes(id))
    const mastered = learnable.filter(id => views.get(id)?.gateOpen === true || st.completed.includes(id)).length
    const envs = new Set(this.registry.environments())
    const view: JourneyView = {
      id: journey.id,
      goalText: journey.goalText,
      course: { id: course.record.id, version: course.record.version, title: course.record.title, origin: course.record.origin },
      phase: st.phase,
      stage: st.stage,
      activeSkill: st.activeSkill === null ? null : views.get(st.activeSkill) ?? null,
      path: pathViews,
      completed: st.completed,
      diagnosedKnown: st.diagnosedKnown,
      pathApproved: st.pathApproved,
      progress: { mastered, total: learnable.length, percent: learnable.length === 0 ? 100 : Math.round((100 * mastered) / learnable.length) },
      environments: course.spec.environments.map(id => ({ id, available: envs.has(id) })),
      dueReviews: this.dueReviewList(journey.learnerId).length,
      nextAction: this.nextAction(journey, course),
    }
    return view
  }

  private journeyFor(actor: Actor, journeyId?: string): JourneyRecord {
    let journey: JourneyRecord | undefined
    if (journeyId !== undefined) {
      journey = this.store.journey(journeyId)
      if (journey === undefined) throw new HodosError('NOT_FOUND', `journey ${journeyId} not found`)
      this.assertOwner(actor, journey.learnerId, 'journey')
      return journey
    }
    if (actor.sessionId !== undefined) {
      const bound = this.store.sessionBinding(actor.sessionId)?.journeyId
      if (bound !== undefined && bound !== null) {
        const j = this.store.journey(bound)
        if (j !== undefined && j.learnerId === actor.learnerId) return j
      }
    }
    journey = this.store.journeys(actor.learnerId)[0]
    if (journey === undefined) throw new HodosError('NOT_FOUND', 'no learning journey yet; start one with a goal')
    return journey
  }

  private advance(journey: JourneyRecord, event: JourneyEvent, channel: string): JourneyRecord {
    const state = transition(journey.state, event)
    const at = this.now().toISOString()
    this.store.appendJourneyEvent(journey.id, event, state, channel, at)
    const next = { ...journey, state, updatedAt: at }
    this.emit({ type: 'journey', learnerId: journey.learnerId, journeyId: journey.id, phase: state.phase, stage: state.stage, activeSkill: state.activeSkill })
    return next
  }

  // ---------------------------------------------------------------- journeys

  /**
   * Start a learning journey toward a goal.
   * @param actor - the learner (any channel).
   * @param request - goal text, optional course or environment, self-report and diagnostic choice.
   * @returns the journey view.
   * @throws {HodosError} `NOT_FOUND` when no installed course matches.
   */
  startJourney(actor: Actor, request: { goal: string; courseId?: string; environment?: string; selfReport?: readonly SelfReport[]; skipDiagnostic?: boolean }): JourneyView {
    const goal = request.goal.trim().slice(0, 500)
    if (goal === '') throw new HodosError('INVALID_INPUT', 'a learning goal is required')
    const record = this.findCourse(goal, request.environment, request.courseId)
    const course = this.loadCourse(record.id, record.version)
    const at = this.now().toISOString()
    const journeyId = brandId<'JourneyId'>(this.ids.next('jrn'))
    const scope = [...course.graph.ancestors(course.spec.goal), course.spec.goal]
    const states = this.states(actor.learnerId)
    // A second course starts warm: skills already mastered with confidence are not re-diagnosed.
    const warm = new Set(scope.filter(id => {
      const s = states.get(id)
      return s !== undefined && s.gateOpen && effectiveMastery(s, this.now(), this.scheduler) >= 0.8
    }))
    const diagnosable = scope.filter(id => !warm.has(id))
    const askable = new Set(course.spec.items.filter(i => i.modes.includes('diagnostic')).flatMap(i => i.skills.map(s => s.skillId)))
    const withDiagnostic = request.skipDiagnostic !== true && diagnosable.some(id => askable.has(id))
    const priors: Record<string, number> = {}
    this.store.transaction(() => {
      for (const report of request.selfReport ?? []) {
        const skillId = report.skillId !== undefined && course.graph.has(report.skillId) ? report.skillId : matchSkill(course.spec.skills, report.skill ?? '')
        if (skillId === null) continue
        priors[skillId] = SELF_REPORT_PRIOR[report.level]
        this.store.savePrior(actor.learnerId, { skillId, prior: SELF_REPORT_PRIOR[report.level], source: 'self-report', diagnosedKnown: false }, at)
      }
      this.store.insertJourney({
        id: journeyId, learnerId: actor.learnerId, courseId: record.id, courseVersion: record.version, goalText: goal,
        state: initialJourneyState(withDiagnostic), createdAt: at, updatedAt: at,
      })
      if (withDiagnostic) {
        const nodes: DiagnosticNode[] = diagnosable.map(id => ({
          id, requires: course.graph.prerequisites(id).filter(p => diagnosable.includes(p)), askable: askable.has(id),
        }))
        const config: DiagnosticConfig = {
          ...DEFAULT_DIAGNOSTIC_CONFIG,
          particles: this.config.diagnostic.particles,
          minQuestions: this.config.diagnostic.minQuestions,
          maxQuestions: this.config.diagnostic.maxQuestions,
          strategy: chooseStrategy(nodes),
          seed: hashSeed(`${this.config.seed}:${journeyId}`),
          priors,
        }
        this.store.insertDiagnostic({
          id: this.ids.next('dgn'), learnerId: actor.learnerId, journeyId, status: 'active',
          scope: nodes, config, observations: [], result: null, createdAt: at, completedAt: null,
        })
      }
      if (actor.sessionId !== undefined) this.store.bindSession(actor.sessionId, actor.learnerId, journeyId, at)
    })
    let journey = this.store.journey(journeyId)
    if (journey === undefined) throw new HodosError('INTERNAL', 'journey was not stored')
    if (!withDiagnostic) journey = this.proposePath(journey, actor.channel)
    this.emit({ type: 'journey', learnerId: actor.learnerId, journeyId, phase: journey.state.phase, stage: journey.state.stage, activeSkill: journey.state.activeSkill })
    return this.journeyView(journey)
  }

  private proposePath(journey: JourneyRecord, channel: string): JourneyRecord {
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const states = this.states(journey.learnerId)
    const known = new Set([...journey.state.diagnosedKnown, ...[...states.values()].filter(s => s.gateOpen).map(s => s.skillId)])
    const path = course.graph.planPath(course.spec.goal, known)
    return this.store.transaction(() => this.advance(journey, { type: 'PATH_PROPOSED', path }, channel))
  }

  /**
   * The learner's current (or a specific) journey.
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the journey view.
   */
  journey(actor: Actor, journeyId?: string): JourneyView {
    return this.journeyView(this.journeyFor(actor, journeyId))
  }

  /**
   * All journeys of the learner, most recent first.
   * @param actor - the learner.
   * @returns journey views.
   */
  journeys(actor: Actor): JourneyView[] {
    return this.store.journeys(actor.learnerId).map(j => this.journeyView(j))
  }

  /**
   * Resume: bind the session to the learner's most recent journey and report where they are.
   * @param actor - the learner.
   * @returns the journey view, or null when there is none.
   */
  resume(actor: Actor): JourneyView | null {
    const journey = this.store.journeys(actor.learnerId)[0]
    if (journey === undefined) return null
    if (actor.sessionId !== undefined) this.store.bindSession(actor.sessionId, actor.learnerId, journey.id, this.now().toISOString())
    return this.journeyView(journey)
  }

  /**
   * Approve the proposed path. Agent-proposed courses require the learner's own channel.
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the journey view.
   */
  approvePath(actor: Actor, journeyId?: string): JourneyView {
    const journey = this.journeyFor(actor, journeyId)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    if (actor.channel === 'agent' && (course.record.origin !== 'pack' || !this.config.agentMayApproveShippedPaths)) {
      throw new HodosError('FORBIDDEN', 'the learner must approve this learning path in the Hodos workspace')
    }
    const next = this.store.transaction(() => this.advance(journey, { type: 'PATH_APPROVED' }, actor.channel))
    return this.journeyView(next)
  }

  /**
   * Skip the diagnostic (start from scratch).
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the journey view.
   */
  skipDiagnostic(actor: Actor, journeyId?: string): JourneyView {
    const journey = this.journeyFor(actor, journeyId)
    const d = this.store.diagnosticForJourney(journey.id)
    const after = this.store.transaction(() => {
      if (d !== undefined && d.status === 'active') this.store.updateDiagnostic(d.id, 'skipped', d.observations, null, this.now().toISOString())
      return this.advance(journey, { type: 'DIAGNOSTIC_SKIPPED' }, actor.channel)
    })
    return this.journeyView(this.proposePath(after, actor.channel))
  }

  // ---------------------------------------------------------------- diagnostic

  private diagnosticSession(journey: JourneyRecord): { record: NonNullable<ReturnType<HodosStore['diagnosticForJourney']>>; session: Diagnostic } {
    const record = this.store.diagnosticForJourney(journey.id)
    if (record === undefined || record.status !== 'active') throw new HodosError('INVALID_STATE', 'no active diagnostic')
    const session = new Diagnostic(record.scope, record.config, record.observations)
    return { record, session }
  }

  private finishDiagnostic(journey: JourneyRecord, session: Diagnostic, recordId: string, channel: string): JourneyRecord {
    const estimate = session.estimate()
    const at = this.now().toISOString()
    const after = this.store.transaction(() => {
      for (const [skillId, m] of Object.entries(estimate.marginals)) {
        const asked = session.observations.some(o => o.skillId === skillId)
        if (!asked && !estimate.known.includes(skillId)) continue
        this.store.savePrior(journey.learnerId, { skillId, prior: Math.min(0.9, Math.max(0.05, m)), source: 'diagnostic', diagnosedKnown: estimate.known.includes(skillId) }, at)
      }
      this.store.updateDiagnostic(recordId, 'completed', session.observations, estimate, at)
      return this.advance(journey, { type: 'DIAGNOSTIC_COMPLETED', known: estimate.known }, channel)
    })
    return this.proposePath(after, channel)
  }

  // ---------------------------------------------------------------- lessons

  /**
   * Lessons for the active skill (or a given skill): course lessons, overlays
   * written for this learner, or a generated outline when none exists.
   * @param actor - the learner.
   * @param request - optional journey and skill.
   * @returns the projected lesson view (formative answers withheld).
   */
  lesson(actor: Actor, request: { journeyId?: string; skillId?: string } = {}): LessonView {
    const journey = this.journeyFor(actor, request.journeyId)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const skillId = request.skillId ?? journey.state.activeSkill
    if (skillId === null || !course.graph.has(skillId)) throw new HodosError('INVALID_STATE', 'there is no active skill to study')
    const blocks = blockLookup(this.registry)
    const lessons: Array<LessonView['lessons'][number]> = []
    const add = (id: string, title: string, origin: 'course' | 'overlay' | 'generated', source: string): void => {
      const parsed = parseLesson(source, blocks, id)
      if (parsed.tree === null) {
        this.logger.warn(`lesson ${id} no longer validates: ${parsed.diagnostics.map(d => d.message).join('; ')}`)
        return
      }
      const answers = this.store.checkAnswers(actor.learnerId, id)
      const tree = projectLessonForStudent(parsed.tree, blocks)
      const entry = {
        id, title, origin, tree, text: lessonPlainText(tree, blocks),
        checks: lessonChecks(parsed.tree).map(c => ({ id: c.id, answered: answers.has(c.id), correct: answers.get(c.id) === true })),
      }
      assertNoLeak(entry, lessonServerFragments(parsed.tree, blocks).filter(s => s.length >= MIN_SECRET_LENGTH), 'lesson view')
      lessons.push(entry)
    }
    for (const l of course.spec.lessons.filter(x => x.skillId === skillId)) add(l.id, l.title, 'course', l.source)
    for (const o of this.store.overlays(actor.learnerId, skillId)) add(o.id, o.title, 'overlay', o.source)
    if (lessons.length === 0) {
      const skill = course.graph.get(skillId)
      const outline = [`# ${skill.title}`, skill.description ?? '', ...(skill.objectives ?? []).map(o => `- ${o}`)].filter(Boolean).join('\n\n')
      add(`${skillId}-outline`, skill.title, 'generated', outline)
    }
    const courseChecks = lessons.filter(l => l.origin === 'course').flatMap(l => l.checks)
    const canComplete = !this.config.requireLessonChecks || courseChecks.every(c => c.answered)
    return { skillId, lessons, canComplete }
  }

  private findCheck(course: LoadedCourse, learnerId: string, lessonId: string, checkId: string): LessonNode | null {
    const source = course.spec.lessons.find(l => l.id === lessonId)?.source ?? this.store.overlay(learnerId, lessonId)?.source
    if (source === undefined) return null
    const parsed = parseLesson(source, blockLookup(this.registry), lessonId)
    return parsed.tree === null ? null : lessonChecks(parsed.tree).find(c => c.id === checkId) ?? null
  }

  /**
   * Answer a formative check inside a lesson. Formative checks give feedback
   * and gate lesson completion; they are not mastery evidence.
   * @param actor - the learner.
   * @param request - lesson, check and chosen option.
   * @returns correctness and the explanation (released after answering).
   */
  answerCheck(actor: Actor, request: { journeyId?: string; lessonId: string; checkId: string; optionId: string }): CheckAnswerView {
    const journey = this.journeyFor(actor, request.journeyId)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const check = this.findCheck(course, actor.learnerId, request.lessonId, request.checkId)
    if (check === null) throw new HodosError('NOT_FOUND', `check ${request.checkId} not found`)
    const correct = check.attributes.answer === request.optionId
    this.store.saveCheckAnswer(actor.learnerId, request.lessonId, request.checkId, correct, this.now().toISOString())
    const explain = check.attributes.explain
    return { checkId: request.checkId, correct, ...(typeof explain === 'string' ? { explanation: explain } : {}) }
  }

  /**
   * Finish the lesson (teach → practice) or the remedial step (remedial → practice).
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the journey view.
   */
  completeLesson(actor: Actor, journeyId?: string): JourneyView {
    const journey = this.journeyFor(actor, journeyId)
    if (journey.state.stage === 'teach') {
      const view = this.lesson(actor, { journeyId: journey.id })
      if (!view.canComplete) throw new HodosError('POLICY_DENIED', 'answer the lesson\'s check questions first')
      return this.journeyView(this.store.transaction(() => this.advance(journey, { type: 'LESSON_COMPLETED' }, actor.channel)))
    }
    if (journey.state.stage === 'remedial') {
      return this.journeyView(this.store.transaction(() => this.advance(journey, { type: 'REMEDIAL_COMPLETED' }, actor.channel)))
    }
    throw new HodosError('INVALID_STATE', 'there is no lesson to complete right now')
  }

  /**
   * Store a lesson written by the tutor agent for this learner (adaptive layer).
   * The source is validated like course content and never executed.
   * @param actor - the learner (usually the agent channel).
   * @param request - skill, title and Markdoc source.
   * @returns the stored lesson id and validation findings.
   */
  addLessonOverlay(actor: Actor, request: { journeyId?: string; skillId?: string; title: string; source: string; kind?: 'lesson' | 'remedial' }): { id: string; diagnostics: string[] } {
    this.limiter.take(actor.learnerId, 'generate')
    const journey = this.journeyFor(actor, request.journeyId)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const skillId = request.skillId ?? journey.state.activeSkill
    if (skillId === null || !course.graph.has(skillId)) throw new HodosError('INVALID_INPUT', 'unknown skill for this journey')
    const id = this.ids.next('lsn')
    const source = stampBlockIds(request.source, id)
    const parsed = parseLesson(source, blockLookup(this.registry), id)
    const errors = parsed.diagnostics.filter(d => d.severity === 'error').map(d => d.message)
    if (parsed.tree === null) throw new HodosError('INVALID_INPUT', `lesson rejected: ${errors.join('; ')}`)
    this.store.insertOverlay({
      id, learnerId: actor.learnerId, journeyId: journey.id, skillId, kind: request.kind ?? 'lesson',
      title: request.title.slice(0, 120), source, author: actor.channel, createdAt: this.now().toISOString(),
    })
    return { id, diagnostics: parsed.diagnostics.map(d => d.message) }
  }

  // ---------------------------------------------------------------- exercises

  private history(learnerId: string): (itemId: string) => { timesSeen: number; seenInPractice: boolean; seenInCheckpoint: boolean; lastSeenAt: Date | null } {
    const recent = this.store.recentPresentations(learnerId, 500)
    return itemId => {
      const seen = recent.filter(p => p.itemId === itemId)
      return {
        timesSeen: seen.length,
        seenInPractice: seen.some(p => p.mode === 'practice'),
        seenInCheckpoint: seen.some(p => p.mode === 'checkpoint'),
        lastSeenAt: seen[0] === undefined ? null : new Date(seen[0].presentedAt),
      }
    }
  }

  private predictor(learnerId: string, course: LoadedCourse, skillId: string): (item: ExerciseItem) => number {
    const s = this.stateOf(learnerId, course, skillId)
    const config = this.masteryConfigFor(course.spec)
    return item => {
      switch (s.est.estimator) {
        case 'elo': return expectedSuccess(s.est.theta, this.store.calibration(item.id)?.b ?? item.difficulty)
        case 'bkt': {
          const [g, sl] = itemGuessSlip(config.bkt, item.difficulty)
          return s.est.p * (1 - sl) + (1 - s.est.p) * g
        }
        default: return s.pMastered
      }
    }
  }

  private present(actor: Actor, journey: JourneyRecord | null, course: LoadedCourse, item: ExerciseItem, skillId: string, mode: ExerciseMode, extra: { checkpointId?: string; diagnosticId?: string; tutorContact?: boolean } = {}): ExerciseView {
    const kind = this.registry.kind(item.kind)
    if (kind === undefined) throw new HodosError('UNAVAILABLE', `the ${item.kind} environment is not installed; your progress is saved and resumes when it is`)
    const record: PresentationRecord = {
      id: this.ids.next('prs'), learnerId: actor.learnerId, journeyId: journey?.id ?? null, courseId: course.record.id, courseVersion: course.record.version,
      itemId: item.id, skillId, mode, status: 'open', attempts: 0, firstCorrect: null, hintLevel: 0, hintsAtLastAttempt: 0, lastHintAt: null,
      tutorContact: extra.tutorContact === true, released: false, progress: null, checkpointId: extra.checkpointId ?? null,
      diagnosticId: extra.diagnosticId ?? null, presentedAt: this.now().toISOString(), completedAt: null,
    }
    this.store.insertPresentation(record)
    if (journey !== null) this.store.touchJourney(journey.id, record.presentedAt)
    return this.exerciseView(record, course)
  }

  private exerciseView(p: PresentationRecord, course: LoadedCourse): ExerciseView {
    const item = course.items.get(p.itemId)
    if (item === undefined) throw new HodosError('NOT_FOUND', `item ${p.itemId} is no longer in the course`)
    const kind = this.registry.kind(item.kind)
    if (kind === undefined) throw new HodosError('UNAVAILABLE', `the ${item.kind} environment is not installed; your progress is saved and resumes when it is`, { kind: item.kind })
    const policy = MODE_POLICY[p.mode]
    const authored = (item.hints ?? []).length
    const ceiling = Math.min(policy.maxHintLevel, p.mode === 'practice' ? this.config.hintPacing.practiceMaxLevel : policy.maxHintLevel, authored)
    const exercise = presentExercise({
      presentationId: p.id, item, kind, mode: p.mode, attempt: p.attempts + 1,
      hintsAvailable: Math.max(0, ceiling - p.hintLevel), progress: p.progress,
    })
    const renderer = this.registry.rendererFor(kind.spec.environment)
    let checkpoint: ExerciseView['checkpoint']
    if (p.checkpointId !== null) {
      const c = this.store.checkpoint(p.checkpointId)
      if (c !== undefined) checkpoint = { id: c.id, index: c.itemIds.indexOf(p.itemId) + 1, total: c.itemIds.length }
    }
    let diagnostic: ExerciseView['diagnostic']
    if (p.diagnosticId !== null && p.journeyId !== null) {
      const d = this.store.diagnosticForJourney(p.journeyId)
      diagnostic = { asked: d?.observations.length ?? 0, max: this.config.diagnostic.maxQuestions }
    }
    const view: ExerciseView = {
      ...exercise,
      title: kind.spec.title,
      skillTitle: course.graph.has(p.skillId) ? course.graph.get(p.skillId).title : p.skillId,
      fallbackText: this.registry.fallbackText(item.kind, exercise.payload),
      renderer: renderer === undefined ? null : { pluginId: renderer.pluginId, rendererId: renderer.spec.id, entry: renderer.spec.entry },
      responseKind: kind.spec.responseKind,
      attemptsAllowed: policy.attemptsPerItem,
      hints: (item.hints ?? []).filter(h => h.level <= p.hintLevel).sort((a, b) => a.level - b.level).map(h => ({ level: h.level, text: h.text })),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    }
    assertNoLeak(view, secretFragments(item, kind, { hintLevel: p.hintLevel, answer: p.released }, [p.progress]), 'exercise view')
    return view
  }

  /**
   * The next exercise for the learner's current stage: a diagnostic question,
   * a practice item (with interleaving), a remedial item, the next checkpoint
   * item, or a review item. An open presentation is resumed rather than replaced.
   * @param actor - the learner.
   * @param request - optional journey id.
   * @returns the exercise, or null when the stage has no exercise (e.g. a lesson is due).
   */
  nextExercise(actor: Actor, request: { journeyId?: string } = {}): ExerciseView | null {
    let journey = this.journeyFor(actor, request.journeyId)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const open = this.store.openPresentations(actor.learnerId).find(p => p.journeyId === journey.id)
    const st = journey.state
    const modeNow: ExerciseMode | null = st.phase === 'diagnostic' ? 'diagnostic'
      : st.phase === 'reviewing' ? 'review'
        : st.phase === 'learning' && st.stage === 'checkpoint' ? 'checkpoint'
          : st.phase === 'learning' && (st.stage === 'practice' || st.stage === 'remedial') ? 'practice' : null
    if (open !== undefined && open.mode === modeNow && course.items.has(open.itemId)) return this.exerciseView(open, course)

    switch (modeNow) {
      case 'diagnostic': {
        const { record, session } = this.diagnosticSession(journey)
        const skillId = session.isComplete() ? null : session.nextSkill()
        if (skillId === null) {
          journey = this.finishDiagnostic(journey, session, record.id, actor.channel)
          return null
        }
        const item = selectItem({
          mode: 'diagnostic', candidates: course.spec.items.filter(i => i.skills.some(s => s.skillId === skillId)),
          history: this.history(actor.learnerId), predictedSuccess: () => 0.5, mastery: 0.5, recentItemIds: [], rng: this.rng(actor, journey),
        })
        if (item === null) {
          session.observe(skillId, 'dont-know')
          this.store.updateDiagnostic(record.id, 'active', session.observations, null, null)
          return this.nextExercise(actor, request)
        }
        return this.present(actor, journey, course, item, skillId, 'diagnostic', { diagnosticId: record.id })
      }
      case 'checkpoint': {
        const checkpoint = this.store.checkpoints(journey.id).find(c => c.status === 'active')
        if (checkpoint === undefined) throw new HodosError('INVALID_STATE', 'the checkpoint has no active session')
        const done = new Set(this.store.checkpointPresentations(checkpoint.id).map(p => p.itemId))
        const nextItemId = checkpoint.itemIds.find(id => !done.has(id))
        if (nextItemId === undefined) return null
        const item = course.items.get(nextItemId)
        if (item === undefined) throw new HodosError('NOT_FOUND', 'checkpoint item missing')
        return this.present(actor, journey, course, item, checkpoint.skillId, 'checkpoint', { checkpointId: checkpoint.id, tutorContact: checkpoint.tutorContact })
      }
      case 'review': {
        const due = this.dueReviewList(actor.learnerId).filter(d => course.graph.has(d.skillId))
        const target = due[0]
        if (target === undefined) {
          this.store.transaction(() => { this.advance(journey, { type: 'REVIEW_COMPLETED' }, actor.channel) })
          return null
        }
        const recent = this.store.recentPresentations(actor.learnerId, 20)
        const lastReview = recent.find(p => p.mode === 'review' && p.skillId === target.skillId)
        const item = selectItem({
          mode: 'review', candidates: course.spec.items.filter(i => i.skills.some(s => s.skillId === target.skillId)),
          history: this.history(actor.learnerId), predictedSuccess: this.predictor(actor.learnerId, course, target.skillId),
          mastery: 1, recentItemIds: recent.map(p => p.itemId), rng: this.rng(actor, journey),
          ...(lastReview === undefined ? {} : { lastGroup: course.items.get(lastReview.itemId)?.isomorphGroup ?? lastReview.itemId }),
        })
        if (item === null) throw new HodosError('UNAVAILABLE', `no review items for ${target.skillId}`)
        return this.present(actor, journey, course, item, target.skillId, 'review')
      }
      case 'practice': {
        const skillId = st.activeSkill
        if (skillId === null) return null
        const remedial = st.stage === 'remedial'
        const rng = this.rng(actor, journey)
        let targetSkill = skillId
        const learned = st.completed.filter(id => course.graph.has(id))
        const confusable = (course.graph.get(skillId).confusableWith ?? []).filter(id => learned.includes(id))
        if (!remedial && learned.length > 0 && rng.next() < this.config.interleaveProbability) {
          const pool = confusable.length > 0 ? confusable : learned
          targetSkill = pool[Math.floor(rng.next() * pool.length)] ?? skillId
        }
        const recent = this.store.recentPresentations(actor.learnerId, 10)
        const pick = (sid: string): ExerciseItem | null => selectItem({
          mode: 'practice', candidates: course.spec.items.filter(i => i.skills.some(s => s.skillId === sid)),
          history: this.history(actor.learnerId), predictedSuccess: this.predictor(actor.learnerId, course, sid),
          mastery: this.stateOf(actor.learnerId, course, sid).pMastered, recentItemIds: recent.map(p => p.itemId), rng, remedial,
          ...(recent[0] === undefined ? {} : { lastGroup: course.items.get(recent[0].itemId)?.isomorphGroup ?? recent[0].itemId }),
        })
        const item = pick(targetSkill) ?? pick(skillId)
        if (item === null) throw new HodosError('UNAVAILABLE', `no practice items for ${skillId}`)
        const primary = item.skills.some(s => s.skillId === skillId) ? skillId : targetSkill
        return this.present(actor, journey, course, item, primary, 'practice')
      }
      case null:
        return null
    }
  }

  private rng(actor: Actor, journey: JourneyRecord): ReturnType<typeof seededRandom> {
    const count = this.store.recentPresentations(actor.learnerId, 1000).length
    return seededRandom(hashSeed(`${this.config.seed}:${journey.id}:${count}`))
  }

  private ownedPresentation(actor: Actor, presentationId: string): PresentationRecord {
    const p = this.store.presentation(presentationId)
    if (p === undefined) throw new HodosError('NOT_FOUND', 'exercise not found')
    this.assertOwner(actor, p.learnerId, 'exercise')
    return p
  }

  /**
   * Reveal the next hint level for an open practice exercise.
   * @param actor - the learner.
   * @param presentationId - the exercise.
   * @returns the hint; the bottom-out level also releases the answer.
   * @throws {HodosError} `POLICY_DENIED` in checkpoint, diagnostic and review
   *   modes or beyond the ceiling; `RATE_LIMITED` when escalating too fast.
   */
  requestHint(actor: Actor, presentationId: string): HintView {
    const p = this.ownedPresentation(actor, presentationId)
    if (p.status !== 'open') throw new HodosError('INVALID_STATE', 'this exercise is finished')
    const course = this.loadCourse(p.courseId, p.courseVersion)
    const item = course.items.get(p.itemId)
    if (item === undefined) throw new HodosError('NOT_FOUND', 'item missing')
    const authored = (item.hints ?? []).map(h => h.level)
    const level = nextHintLevel({
      mode: p.mode, currentLevel: p.hintLevel, authoredLevels: authored.length === 0 ? 0 : Math.max(...authored),
      attemptsSoFar: p.attempts, lastHintAt: p.lastHintAt === null ? null : new Date(p.lastHintAt),
      attemptsSinceLastHint: p.lastHintAt === null ? p.attempts : p.hintsAtLastAttempt === p.hintLevel ? 1 : 0, now: this.now(),
    }, this.config.hintPacing)
    const hint = (item.hints ?? []).find(h => h.level === level)
    if (hint === undefined) throw new HodosError('POLICY_DENIED', 'no further hints are available for this exercise')
    this.limiter.take(actor.learnerId, 'hint')
    const bottomOut = level >= this.config.mastery.bkt.maxHintLevel
    const at = this.now().toISOString()
    const updated: PresentationRecord = { ...p, hintLevel: level, lastHintAt: at, released: p.released || bottomOut }
    this.store.transaction(() => {
      this.store.updatePresentation(updated)
      this.store.appendHint(actor.learnerId, p.id, level, actor.channel, at)
    })
    const kind = this.registry.kind(item.kind)
    const remaining = Math.max(0, Math.min(MODE_POLICY[p.mode].maxHintLevel, this.config.hintPacing.practiceMaxLevel, authored.length === 0 ? 0 : Math.max(...authored)) - level)
    const view: HintView = {
      presentationId: p.id, level, text: hint.text, bottomOut, hintsRemaining: remaining,
      ...(bottomOut && item.explanation !== undefined ? { explanation: item.explanation } : {}),
      ...(bottomOut ? this.revealOf(item) : {}),
    }
    assertNoLeak(view, secretFragments(item, kind, { hintLevel: level, answer: updated.released }), 'hint')
    this.emit({ type: 'hint', learnerId: actor.learnerId, skillId: p.skillId, level, channel: actor.channel })
    return view
  }

  private revealOf(item: ExerciseItem): { reveal?: JsonValue } {
    const kind = this.registry.kind(item.kind)
    if (kind === undefined || !kind.trusted || kind.spec.reveal === undefined) return {}
    try {
      return { reveal: kind.spec.reveal(item) }
    } catch (error) {
      this.logger.warn(`reveal for ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  /**
   * Submit a response (or one step of a stepwise exercise).
   * @param actor - the learner. Checkpoint and diagnostic answers must come from the `ui` channel.
   * @param request - presentation, response, optional latency and confidence.
   * @returns feedback filtered by mode policy.
   */
  async submitAttempt(actor: Actor, request: { presentationId: string; response: JsonValue; latencyMs?: number; confidence?: 'sure' | 'unsure' }): Promise<AttemptView> {
    const p = this.ownedPresentation(actor, request.presentationId)
    if (p.status !== 'open') throw new HodosError('INVALID_STATE', 'this exercise is finished')
    if ((p.mode === 'checkpoint' || p.mode === 'diagnostic') && actor.channel !== 'ui') {
      this.store.securityEvent('relayed-assessment-answer', actor.learnerId, { mode: p.mode, channel: actor.channel }, this.now().toISOString())
      throw new HodosError('POLICY_DENIED', `${p.mode} answers must be given by the learner in the workspace, not relayed by the tutor`)
    }
    this.limiter.take(actor.learnerId, 'attempt')
    const policy = MODE_POLICY[p.mode]
    if (p.attempts >= policy.attemptsPerItem) throw new HodosError('POLICY_DENIED', 'no attempts left on this exercise')
    const course = this.loadCourse(p.courseId, p.courseVersion)
    const item = course.items.get(p.itemId)
    if (item === undefined) throw new HodosError('NOT_FOUND', 'item missing')
    const kind = this.registry.kind(item.kind)
    if (kind === undefined) throw new HodosError('UNAVAILABLE', `the ${item.kind} environment is not installed; your progress is saved`)

    if (p.mode === 'diagnostic' && typeof request.response === 'object' && request.response !== null && !Array.isArray(request.response) && request.response.dontKnow === true) {
      return this.recordDiagnostic(actor, p, course, item, kind.pluginId, kind.pluginVersion, 'dont-know', null)
    }
    const shape = kind.validateResponse(request.response)
    if (shape.length > 0) throw new HodosError('INVALID_INPUT', `response rejected: ${shape.map(d => d.message).join('; ')}`)

    const input = { kind: item.kind, payload: item.payload, key: item.key, response: request.response, mode: p.mode, skills: item.skills, attempt: p.attempts + 1 }
    let grade: GradeResult
    let progress: JsonValue | null = p.progress
    try {
      if (kind.spec.interaction === 'stepwise') {
        const step = await this.registry.step({ ...input, progress: p.progress })
        if (step.status === 'continue') {
          const latest = this.ownedPresentation(actor, p.id)
          // Another step was submitted while this one was being graded.
          if (latest.status !== 'open' || latest.attempts !== p.attempts || JSON.stringify(latest.progress) !== JSON.stringify(p.progress)) {
            throw new HodosError('CONFLICT', 'this exercise changed; reload it')
          }
          this.store.updatePresentation({ ...latest, progress: step.progress })
          const secrets = secretFragments(item, kind, { hintLevel: p.hintLevel, answer: p.released }, [step.progress, request.response])
          let message = step.message
          if (message !== undefined && scanForLeaks(message, secrets).length > 0) {
            this.store.securityEvent('feedback-redacted', actor.learnerId, { kind: item.kind }, this.now().toISOString())
            message = undefined
          }
          const view: AttemptView = {
            presentationId: p.id, status: 'continue', mode: p.mode, progress: step.progress,
            ...(message === undefined ? {} : { message }),
            canRetry: true, attemptsLeft: policy.attemptsPerItem - p.attempts, hintsAvailable: this.exerciseView(latest, course).hintsAvailable, stuck: false,
          }
          assertNoLeak(view, secrets, 'step result')
          return view
        }
        grade = step.grade
        progress = step.progress
      } else {
        grade = await this.registry.grade(input)
      }
    } catch (error) {
      if (error instanceof HodosError && typeof error.details?.grader === 'string') {
        this.store.securityEvent('grader-rejected', actor.learnerId, { kind: item.kind, grader: error.details.grader, reason: String(error.details.reason ?? 'error') }, this.now().toISOString())
        this.emit({ type: 'security', learnerId: actor.learnerId, kind: 'grader-rejected' })
        throw new HodosError('UNAVAILABLE', 'grading failed for this exercise; your attempt was not counted')
      }
      throw error
    }

    if (p.mode === 'diagnostic') return this.recordDiagnostic(actor, p, course, item, kind.pluginId, kind.pluginVersion, grade.correct ? 'correct' : 'wrong', { grade, response: request.response })

    const config = this.masteryConfigFor(course.spec)
    const attempt = p.attempts + 1
    const relay = actor.channel === 'agent'
    const hintLevel = Math.max(p.hintLevel, relay ? config.relayHintLevel : 0, p.tutorContact ? config.tutorContactHintLevel : 0)
    const assisted = p.hintLevel > 0 || relay || p.tutorContact
    const exhausted = attempt >= policy.attemptsPerItem
    const completes = grade.correct || exhausted || p.mode === 'checkpoint'
    const released = p.released || (p.mode !== 'checkpoint' && (grade.correct || exhausted))
    const at = this.now().toISOString()
    const skillFacts: SkillFacts[] = item.skills.map(s => {
      const skill = course.graph.get(s.skillId)
      const ctx = this.skillContext(course, s.skillId)
      return {
        skillId: s.skillId, weight: s.weight, kind: skill.kind, loop: this.loopFor(course.spec, skill),
        ...(ctx.deckSize === undefined ? {} : { deckSize: ctx.deckSize }),
        ...(ctx.fluencyTargetSec === undefined ? {} : { fluencyTargetSec: ctx.fluencyTargetSec }),
      }
    })
    const format = { ...kind.spec.format, ...item.format }
    const itemFacts: ItemFacts = {
      skills: skillFacts, difficulty: item.difficulty, calibratedB: this.store.calibration(item.id)?.b ?? item.difficulty, guessable: format.guessable,
      ...(format.options === undefined ? {} : { options: format.options }),
      ...(item.expectedTimeSec === undefined ? {} : { expectedTimeSec: item.expectedTimeSec }),
      // Checkpoint correctness never rests on an AI judgment alone.
      ...(this.registry.graderInfo(item.kind)?.method === 'ai-rubric' ? { advisory: true } : {}),
    }
    const latency = request.latencyMs !== undefined && Number.isFinite(request.latencyMs) && request.latencyMs >= 0 ? Math.round(request.latencyMs) : null

    const states = this.store.transaction(() => {
      const latest = this.ownedPresentation(actor, p.id)
      if (latest.status !== 'open' || latest.attempts !== p.attempts) throw new HodosError('CONFLICT', 'this exercise changed; reload it')
      const seq = this.store.appendEvidence({
        id: this.ids.next('evd'), learnerId: actor.learnerId, journeyId: p.journeyId, presentationId: p.id, courseId: p.courseId,
        courseVersion: p.courseVersion, itemId: item.id, kind: item.kind, pluginId: kind.pluginId, pluginVersion: kind.pluginVersion,
        graderId: kind.spec.grader, graderTrusted: kind.trusted, mode: p.mode, attempt, countsForMastery: attempt === 1,
        response: request.response, grade, hintLevel, assisted, assistance: { hints: p.hintLevel, relay, tutorContact: p.tutorContact },
        channel: actor.channel, latencyMs: latency, confidence: request.confidence ?? null, itemFacts, createdAt: at,
      })
      const current = this.states(actor.learnerId)
      const evidence = this.store.evidence(actor.learnerId, seq - 1).find(e => e.seq === seq)
      if (evidence === undefined) throw new HodosError('INTERNAL', 'evidence was not stored')
      this.applyEvidence(current, evidence, config, false)
      this.store.saveSkillStates(actor.learnerId, item.skills.map(s => current.get(s.skillId)).filter((s): s is SkillState => s !== undefined), seq, at)
      this.store.updatePresentation({
        ...latest, attempts: attempt, firstCorrect: latest.firstCorrect ?? grade.correct, hintsAtLastAttempt: latest.hintLevel,
        status: completes ? 'completed' : 'open', released, progress: completes ? progress : null, completedAt: completes ? at : null,
      })
      return current
    })

    const skillView = p.journeyId === null ? undefined : (() => {
      const journey = this.store.journey(p.journeyId)
      return journey === undefined ? undefined : this.skillView(actor.learnerId, course, journey.state, p.skillId, states)
    })()
    const recentSameSkill = this.store.recentPresentations(actor.learnerId, STUCK_AFTER_WRONG + 1).filter(x => x.skillId === p.skillId)
    const stuck = !grade.correct && recentSameSkill.length >= STUCK_AFTER_WRONG && recentSameSkill.slice(0, STUCK_AFTER_WRONG).every(x => x.firstCorrect === false)

    let view: AttemptView
    if (p.mode === 'checkpoint') {
      const checkpointView = this.afterCheckpointAnswer(actor, p)
      view = {
        presentationId: p.id, status: 'recorded', mode: p.mode, canRetry: false, attemptsLeft: 0, hintsAvailable: 0, stuck: false,
        checkpoint: checkpointView,
        ...(skillView === undefined || checkpointView.status === 'active' ? {} : { skill: skillView }),
      }
    } else {
      const secrets = secretFragments(item, kind, { hintLevel: p.hintLevel, answer: released }, [progress, request.response])
      let feedback = policy.graderFeedback ? grade.feedback : undefined
      if (feedback !== undefined && scanForLeaks(feedback, secrets).length > 0) {
        this.store.securityEvent('feedback-redacted', actor.learnerId, { kind: item.kind }, at)
        feedback = grade.correct ? 'Correct.' : 'Not quite. Try again or ask for a hint.'
      }
      const misconceptionFeedback = grade.misconceptions
        .map(m => item.misconceptionFeedback?.[m])
        .filter((t): t is string => typeof t === 'string' && scanForLeaks(t, secrets).length === 0)
      view = {
        presentationId: p.id,
        status: grade.correct ? 'correct' : grade.score > 0 ? 'partial' : 'incorrect',
        mode: p.mode,
        score: round(grade.score),
        ...(feedback === undefined ? {} : { feedback }),
        ...(misconceptionFeedback.length === 0 ? {} : { misconceptionFeedback }),
        ...(released && item.explanation !== undefined ? { explanation: item.explanation } : {}),
        ...(released ? this.revealOf(item) : {}),
        ...(progress === null || completes ? {} : { progress }),
        canRetry: !completes,
        attemptsLeft: completes ? 0 : policy.attemptsPerItem - attempt,
        hintsAvailable: completes ? 0 : Math.max(0, Math.min(policy.maxHintLevel, (item.hints ?? []).length) - p.hintLevel),
        stuck,
        ...(skillView === undefined ? {} : { skill: skillView }),
      }
      assertNoLeak(view, secrets, 'attempt feedback')
    }
    if (p.journeyId !== null) {
      const journey = this.store.journey(p.journeyId)
      if (journey !== undefined) view = { ...view, nextAction: this.nextAction(journey, course) }
    }
    this.emit({ type: 'attempt', learnerId: actor.learnerId, journeyId: p.journeyId, skillId: p.skillId, mode: p.mode, status: view.status, hintLevel, channel: actor.channel })
    return view
  }

  private recordDiagnostic(actor: Actor, p: PresentationRecord, course: LoadedCourse, item: ExerciseItem, pluginId: string, pluginVersion: string, answer: 'correct' | 'wrong' | 'dont-know', graded: { grade: GradeResult; response: JsonValue } | null): AttemptView {
    if (p.journeyId === null) throw new HodosError('INVALID_STATE', 'diagnostic without a journey')
    const journey = this.store.journey(p.journeyId)
    if (journey === undefined) throw new HodosError('NOT_FOUND', 'journey missing')
    const { record, session } = this.diagnosticSession(journey)
    session.observe(p.skillId, answer)
    const at = this.now().toISOString()
    this.store.transaction(() => {
      this.store.appendEvidence({
        id: this.ids.next('evd'), learnerId: actor.learnerId, journeyId: p.journeyId, presentationId: p.id, courseId: p.courseId, courseVersion: p.courseVersion,
        itemId: item.id, kind: item.kind, pluginId, pluginVersion, graderId: graded === null ? 'core.dont-know' : this.registry.kind(item.kind)?.spec.grader ?? 'unknown',
        graderTrusted: true, mode: 'diagnostic', attempt: 1, countsForMastery: false, response: graded?.response ?? { dontKnow: true },
        grade: graded?.grade ?? { score: 0, correct: false, skillEvidence: item.skills.map(s => ({ skillId: s.skillId, score: 0 })), misconceptions: [] },
        hintLevel: 0, assisted: false, assistance: { hints: 0, relay: false, tutorContact: p.tutorContact }, channel: actor.channel,
        latencyMs: null, confidence: null, itemFacts: {
          skills: item.skills.map(s => ({ ...s, kind: course.graph.kindOf(s.skillId), loop: this.loopFor(course.spec, course.graph.get(s.skillId)) })),
          difficulty: item.difficulty, calibratedB: item.difficulty, guessable: item.format?.guessable ?? false,
        },
        createdAt: at,
      })
      this.store.updateDiagnostic(record.id, 'active', session.observations, null, null)
      this.store.updatePresentation({ ...p, attempts: 1, firstCorrect: answer === 'correct', status: 'completed', completedAt: at })
    })
    let after = this.store.journey(journey.id) ?? journey
    if (session.isComplete()) after = this.finishDiagnostic(after, session, record.id, actor.channel)
    return {
      presentationId: p.id, status: 'recorded', mode: 'diagnostic', canRetry: false, attemptsLeft: 0, hintsAvailable: 0, stuck: false,
      nextAction: this.nextAction(after, course),
    }
  }

  // ---------------------------------------------------------------- checkpoints

  /**
   * Start an unassisted checkpoint for the active skill: fresh items, one
   * attempt each, no hints, no tutor help, correctness withheld until the end.
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the checkpoint status.
   * @throws {HodosError} `RATE_LIMITED` during the cooldown after a failure.
   */
  startCheckpoint(actor: Actor, journeyId?: string): CheckpointView {
    const journey = this.journeyFor(actor, journeyId)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const skillId = journey.state.activeSkill
    if (journey.state.phase !== 'learning' || skillId === null || (journey.state.stage !== 'practice' && journey.state.stage !== 'teach')) {
      throw new HodosError('INVALID_STATE', 'a checkpoint can start after the lesson, during practice')
    }
    const lastFailed = this.store.checkpoints(journey.id).find(c => c.skillId === skillId && c.status === 'failed')
    if (lastFailed?.completedAt !== null && lastFailed?.completedAt !== undefined) {
      const waited = (this.now().getTime() - new Date(lastFailed.completedAt).getTime()) / 1000
      if (waited < this.config.checkpointCooldownSec) {
        throw new HodosError('RATE_LIMITED', `practice a little more first; the next checkpoint opens in ${Math.ceil(this.config.checkpointCooldownSec - waited)}s`, {
          retryAfterSec: Math.ceil(this.config.checkpointCooldownSec - waited),
        })
      }
    }
    const history = this.history(actor.learnerId)
    const rng = this.rng(actor, journey)
    const chosen: string[] = []
    const candidates = course.spec.items.filter(i => i.skills.some(s => s.skillId === skillId) && i.modes.includes('checkpoint'))
    while (chosen.length < this.config.checkpointSize) {
      const next = selectItem({
        mode: 'checkpoint', candidates, history, predictedSuccess: this.predictor(actor.learnerId, course, skillId),
        mastery: 1, recentItemIds: [], rng, exclude: new Set(chosen),
      })
      if (next === null) break
      chosen.push(next.id)
    }
    if (chosen.length === 0) throw new HodosError('UNAVAILABLE', `no checkpoint items for ${skillId}`)
    const id = this.ids.next('ckp')
    const at = this.now().toISOString()
    this.store.transaction(() => {
      for (const open of this.store.openPresentations(actor.learnerId)) {
        if (open.journeyId === journey.id) this.store.updatePresentation({ ...open, status: 'abandoned', completedAt: at })
      }
      this.store.insertCheckpoint({ id, learnerId: actor.learnerId, journeyId: journey.id, skillId, status: 'active', itemIds: chosen, tutorContact: false, result: null, startedAt: at, completedAt: null })
      this.advance(journey, { type: 'CHECKPOINT_STARTED' }, actor.channel)
    })
    return { id, skillId, status: 'active', total: chosen.length, answered: 0 }
  }

  private afterCheckpointAnswer(actor: Actor, p: PresentationRecord): CheckpointView {
    const checkpoint = p.checkpointId === null ? undefined : this.store.checkpoint(p.checkpointId)
    if (checkpoint === undefined) throw new HodosError('NOT_FOUND', 'checkpoint missing')
    const answered = this.store.checkpointPresentations(checkpoint.id).filter(x => x.status === 'completed')
    if (answered.length < checkpoint.itemIds.length) {
      return { id: checkpoint.id, skillId: checkpoint.skillId, status: 'active', total: checkpoint.itemIds.length, answered: answered.length }
    }
    return this.finishCheckpoint(actor, checkpoint.id)
  }

  private finishCheckpoint(actor: Actor, checkpointId: string): CheckpointView {
    const checkpoint = this.store.checkpoint(checkpointId)
    if (checkpoint === undefined || checkpoint.status !== 'active') throw new HodosError('INVALID_STATE', 'checkpoint is not active')
    const journey = this.store.journey(checkpoint.journeyId)
    if (journey === undefined) throw new HodosError('NOT_FOUND', 'journey missing')
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const presentations = this.store.checkpointPresentations(checkpoint.id)
    const items = presentations.map(pr => {
      const item = course.items.get(pr.itemId)
      return {
        itemId: pr.itemId,
        correct: pr.firstCorrect === true,
        ...(item?.explanation === undefined ? {} : { explanation: item.explanation }),
        ...(item === undefined ? {} : this.revealOf(item)),
      }
    })
    const state = this.stateOf(actor.learnerId, course, checkpoint.skillId)
    const passed = state.gateOpen
    const unmet = passed ? [] : evaluateGate(state, this.skillContext(course, checkpoint.skillId), this.masteryConfigFor(course.spec)).unmet
    const at = this.now().toISOString()
    let adaptation: NonNullable<CheckpointView['result']>['adaptation']
    this.store.transaction(() => {
      for (const pr of presentations) this.store.updatePresentation({ ...pr, released: true })
      if (passed) {
        this.advance(journey, { type: 'CHECKPOINT_PASSED' }, actor.channel)
      } else {
        const failedJourney = this.advance(journey, { type: 'CHECKPOINT_FAILED' }, actor.channel)
        adaptation = this.adapt(actor, failedJourney, course, checkpoint.skillId, presentations)
      }
      const result: JsonObject = {
        passed, correct: items.filter(i => i.correct).length, unmet: [...unmet],
        ...(adaptation === undefined ? {} : { adaptation: { insertedPrerequisites: [...adaptation.insertedPrerequisites], focus: [...adaptation.focus], rest: adaptation.rest } }),
      }
      this.store.finishCheckpoint(checkpoint.id, passed ? 'passed' : 'failed', result, at)
    })
    this.emit({ type: 'checkpoint', learnerId: actor.learnerId, journeyId: journey.id, skillId: checkpoint.skillId, passed })
    return {
      id: checkpoint.id, skillId: checkpoint.skillId, status: passed ? 'passed' : 'failed', total: checkpoint.itemIds.length, answered: presentations.length,
      result: { passed, correct: items.filter(i => i.correct).length, items, unmet, ...(adaptation === undefined ? {} : { adaptation }) },
    }
  }

  /** Targeted adaptation after a failed checkpoint (inside the caller's transaction). */
  private adapt(actor: Actor, journey: JourneyRecord, course: LoadedCourse, skillId: string, presentations: readonly PresentationRecord[]): { insertedPrerequisites: string[]; focus: string[]; rest: boolean } {
    // Earlier failed checkpoints today (this one is still active) = adaptations already applied today.
    const adaptationsToday = this.store.failedCheckpointsSince(actor.learnerId, skillId, startOfUtcDay(this.now()))
    const rest = adaptationsToday >= this.config.maxAdaptationsPerSkillPerDay
    const states = this.states(actor.learnerId)
    const weak = rest ? [] : course.graph.prerequisites(skillId).filter(pid => {
      if (journey.state.completed.includes(pid)) return false
      const s = states.get(pid)
      if (s?.gateOpen === true) return s.card !== null && this.scheduler.retrievability(s.card, this.now()) < this.config.mastery.refreshRetrievability
      return !journey.state.diagnosedKnown.includes(pid) || (s !== undefined && s.evidenceCount > 0 && s.pMastered < 0.5)
    })
    const focus = new Set<string>()
    for (const pr of presentations) {
      for (const e of this.store.evidenceFor(pr.id)) for (const m of e.grade.misconceptions) focus.add(m)
    }
    const after = this.advance(journey, { type: 'ADAPTATION_APPLIED', insertBefore: weak }, actor.channel)
    if (after.state.activeSkill === skillId && after.state.stage === 'remedial') {
      const notes = [...focus].map(m => course.spec.items.find(i => i.misconceptionFeedback?.[m] !== undefined)?.misconceptionFeedback?.[m]).filter((t): t is string => t !== undefined)
      const source = [
        `# Let's revisit ${course.graph.get(skillId).title}`,
        rest ? 'You have worked hard on this today. Take a break; your reviews are scheduled.' : 'The checkpoint showed a few gaps. Work through these points, then practice again.',
        ...notes.map(n => `- ${n}`),
      ].join('\n\n')
      this.store.insertOverlay({
        id: this.ids.next('lsn'), learnerId: actor.learnerId, journeyId: journey.id, skillId, kind: 'remedial',
        title: `Revisit: ${course.graph.get(skillId).title}`, source, author: 'system', createdAt: this.now().toISOString(),
      })
    }
    return { insertedPrerequisites: weak, focus: [...focus], rest }
  }

  /**
   * Current checkpoint status for the journey.
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the most recent checkpoint, or null.
   */
  checkpointStatus(actor: Actor, journeyId?: string): CheckpointView | null {
    const journey = this.journeyFor(actor, journeyId)
    const c = this.store.checkpoints(journey.id)[0]
    if (c === undefined) return null
    const answered = this.store.checkpointPresentations(c.id).filter(x => x.status === 'completed').length
    const base: CheckpointView = { id: c.id, skillId: c.skillId, status: c.status, total: c.itemIds.length, answered }
    if (c.status === 'active' || c.result === null) return base
    const passed = c.result.passed === true
    return {
      ...base,
      result: {
        passed, correct: typeof c.result.correct === 'number' ? c.result.correct : 0, items: [],
        unmet: Array.isArray(c.result.unmet) ? c.result.unmet.filter((u): u is string => typeof u === 'string') : [],
      },
    }
  }

  // ---------------------------------------------------------------- reviews and progress

  /**
   * Begin reviewing due skills (spaced repetition with fresh variants).
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the journey view.
   */
  startReview(actor: Actor, journeyId?: string): JourneyView {
    const journey = this.journeyFor(actor, journeyId)
    if (this.dueReviewList(actor.learnerId).length === 0) throw new HodosError('INVALID_STATE', 'nothing is due for review right now')
    return this.journeyView(this.store.transaction(() => this.advance(journey, { type: 'REVIEW_STARTED' }, actor.channel)))
  }

  /**
   * Due reviews.
   * @param actor - the learner.
   * @returns due skills, least retrievable first.
   */
  dueReviews(actor: Actor): ProgressView['dueReviews'] {
    return this.withTitles(this.dueReviewList(actor.learnerId))
  }

  private withTitles(list: ProgressView['dueReviews']): ProgressView['dueReviews'] {
    const titles = new Map<string, string>()
    for (const c of this.store.courses('approved')) for (const s of c.spec.skills) titles.set(s.id, s.title)
    return list.map(d => ({ ...d, title: titles.get(d.skillId) ?? d.skillId }))
  }

  /**
   * Progress across the journey's skills.
   * @param actor - the learner.
   * @param journeyId - optional journey id.
   * @returns the progress view.
   */
  progress(actor: Actor, journeyId?: string): ProgressView {
    let journey: JourneyRecord | null = null
    try {
      journey = this.journeyFor(actor, journeyId)
    } catch (error) {
      if (!(error instanceof HodosError && error.code === 'NOT_FOUND' && journeyId === undefined)) throw error
    }
    const states = this.states(actor.learnerId)
    const skills: SkillView[] = []
    if (journey !== null) {
      const course = this.loadCourse(journey.courseId, journey.courseVersion)
      for (const s of course.spec.skills) skills.push(this.skillView(actor.learnerId, course, journey.state, s.id, states))
    }
    const learnable = skills.filter(s => s.status !== 'known')
    const mastered = learnable.filter(s => s.gateOpen).length
    const recent = this.store.recentPresentations(actor.learnerId, 20).filter(p => p.firstCorrect !== null && p.mode !== 'diagnostic')
      .map(p => ({ itemId: p.itemId, skillId: p.skillId, mode: p.mode, correct: p.firstCorrect === true, at: p.completedAt ?? p.presentedAt }))
    return {
      journeyId: journey?.id ?? null, skills, mastered, total: learnable.length,
      percent: learnable.length === 0 ? 0 : Math.round((100 * mastered) / learnable.length),
      dueReviews: this.dueReviews(actor), hintsUsed: this.store.hintCount(actor.learnerId), recent,
    }
  }

  // ---------------------------------------------------------------- tutor support

  /**
   * Compact learner context for the tutor agent. Contains no answer keys,
   * no unreleased hints and no other learner's data; states what the tutor
   * may and may not do in the current mode.
   * @param actor - the learner.
   * @returns structured context plus a rendered text block.
   */
  tutorContext(actor: Actor): { text: string; data: JsonObject } {
    let journey: JourneyRecord | null = null
    try {
      journey = this.journeyFor(actor)
    } catch (error) {
      if (!(error instanceof HodosError && error.code === 'NOT_FOUND')) throw error
    }
    if (journey === null) {
      return { text: 'Hodos: no learning journey yet. Offer to start one with hodos_start_learning.', data: { journey: null } }
    }
    const view = this.journeyView(journey)
    const course = this.loadCourse(journey.courseId, journey.courseVersion)
    const open = this.store.openPresentations(actor.learnerId).find(p => p.journeyId === journey?.id)
    let exercise: ExerciseView | null = null
    let unavailable = false
    if (open !== undefined && course.items.has(open.itemId)) {
      try {
        exercise = this.exerciseView(open, course)
      } catch (error) {
        if (!(error instanceof HodosError && error.code === 'UNAVAILABLE')) throw error
        unavailable = true
      }
    }
    const mode = exercise?.mode ?? (view.stage === 'checkpoint' ? 'checkpoint' : view.phase === 'diagnostic' ? 'diagnostic' : null)
    const policy = mode === null ? null : MODE_POLICY[mode]
    const misconceptions = view.activeSkill === null ? [] : Object.entries(this.stateOf(actor.learnerId, course, view.activeSkill.id).misconceptions)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([id, m]) => `${id} (${m.count}x)`)
    const lines = [
      `Hodos learning context — goal: "${view.goalText}" (course ${view.course.title}).`,
      `Phase: ${view.phase}${view.stage === null ? '' : `, stage: ${view.stage}`}. Progress: ${view.progress.mastered}/${view.progress.total} skills mastered (${view.progress.percent}%).`,
      view.activeSkill === null ? 'No active skill.' : `Active skill: ${view.activeSkill.title} [${view.activeSkill.id}], kind ${view.activeSkill.kind}, evidence index ${view.activeSkill.pMastered}. Still needed: ${view.activeSkill.unmet.join('; ') || 'nothing'}.`,
      `Next action: ${describeAction(view.nextAction)}.`,
      misconceptions.length === 0 ? '' : `Recent misconceptions: ${misconceptions.join(', ')}.`,
      exercise === null ? '' : `Current ${exercise.mode} exercise (${exercise.title}, attempt ${exercise.attempt}, hints revealed ${exercise.hints.length}): ${exercise.fallbackText}`,
      unavailable ? 'The environment for the current exercise is not installed; the learner\'s progress is saved and resumes once it is.' : '',
      policy === null ? '' : policy.tutorMayHelp
        ? 'Tutor policy: you may explain concepts and use hodos_request_hint for graded help; never state the answer directly — the learner must produce it.'
        : `Tutor policy: the learner is in ${mode} mode. Do NOT give hints, solutions or evaluations of candidate answers until it is finished; offer encouragement only. Messages you exchange now are recorded as assistance.`,
      view.dueReviews > 0 ? `${view.dueReviews} skill(s) are due for review.` : '',
    ].filter(Boolean)
    const text = lines.join('\n')
    const data: JsonObject = {
      journey: { id: view.id, phase: view.phase, stage: view.stage, goal: view.goalText, course: view.course.id, progress: view.progress.percent },
      activeSkill: view.activeSkill === null ? null : { id: view.activeSkill.id, title: view.activeSkill.title, pMastered: view.activeSkill.pMastered, unmet: [...view.activeSkill.unmet] },
      nextAction: view.nextAction as unknown as JsonObject,
      exercise: exercise === null ? null : { id: exercise.id, mode: exercise.mode, title: exercise.title, text: exercise.fallbackText, hintsRevealed: exercise.hints.length },
      tutorMayHelp: policy?.tutorMayHelp ?? true,
    }
    if (exercise !== null && open !== undefined) {
      const item = course.items.get(open.itemId)
      if (item !== undefined) assertNoLeak({ text, data }, secretFragments(item, this.registry.kind(item.kind), { hintLevel: open.hintLevel, answer: open.released }, [open.progress]), 'tutor context')
    }
    return { text, data }
  }

  /**
   * The learner messaged the tutor: mark open exercises and an active
   * checkpoint as assisted (tutor contact). Called by the host for every
   * learner message in a bound session.
   * @param learnerId - the learner (resolved by the host from the session).
   * @returns how many open exercises or checkpoints were marked.
   */
  recordTutorContact(learnerId: LearnerId): number {
    return this.store.markTutorContact(learnerId)
  }

  /**
   * Whether the host may send another learning notice to the tutor model (bounds model usage).
   * @param learnerId - the learner.
   * @returns true when a token was available.
   */
  allowNotice(learnerId: LearnerId): boolean {
    return this.limiter.tryTake(learnerId, 'notify')
  }

  /**
   * Charge one subagent delegation against the learner's daily budget.
   * @param learnerId - the learner.
   * @throws {HodosError} `RATE_LIMITED` when the budget is spent.
   */
  chargeDelegation(learnerId: LearnerId): void {
    this.limiter.take(learnerId, 'delegate')
  }

  // ---------------------------------------------------------------- course authoring

  /**
   * Validate and store a course proposed by the tutor agent (or a subagent).
   * Proposed courses are drafts until the learner approves them in the workspace.
   * @param actor - proposer.
   * @param proposal - the proposed course (untrusted model output).
   * @returns validation findings and whether it was stored as a draft.
   */
  async proposeCourse(actor: Actor, proposal: unknown): Promise<{ stored: boolean; courseId: string; version: string; errors: string[]; warnings: string[] }> {
    this.limiter.take(actor.learnerId, 'generate')
    const shape = validateCourseShape(proposal)
    if (shape.length > 0) {
      const field = (name: string): string => {
        const v = typeof proposal === 'object' && proposal !== null && !Array.isArray(proposal) ? (proposal as Record<string, unknown>)[name] : undefined
        return typeof v === 'string' ? v.slice(0, 64) : ''
      }
      return { stored: false, courseId: field('id'), version: field('version'), errors: shape.slice(0, 20).map(d => `${d.code}: ${d.message}`), warnings: [] }
    }
    const course = proposal as CourseSpec // structure checked by validateCourseShape above
    const findings = await validateCourse(course, this.registry, { requireCoverage: false })
    const errors = findings.filter(f => f.severity === 'error').map(f => `${f.code}: ${f.message}`)
    const warnings = findings.filter(f => f.severity === 'warning').map(f => `${f.code}: ${f.message}`)
    if (errors.length > 0) return { stored: false, courseId: course.id, version: course.version, errors, warnings }
    if (this.store.course(course.id, course.version)?.status === 'approved') {
      return { stored: false, courseId: course.id, version: course.version, errors: ['course/version-exists: this course version is already approved; bump the version'], warnings }
    }
    this.store.upsertCourse({
      id: course.id, version: course.version, status: 'draft', origin: 'agent', pluginId: null, title: course.title,
      spec: { ...course, lessons: course.lessons.map(l => ({ ...l, source: stampBlockIds(l.source, l.id) })) },
      proposedBy: actor.channel, createdAt: this.now().toISOString(), approvedAt: null,
    })
    this.courseCache.delete(`${course.id}@${course.version}`)
    return { stored: true, courseId: course.id, version: course.version, errors, warnings }
  }

  /**
   * Draft courses awaiting approval.
   * @returns drafts with their skill graphs (no answer keys).
   */
  drafts(): Array<{ id: string; version: string; title: string; description: string; skills: Array<{ id: string; title: string; kind: string; requires: string[] }>; lessons: number; items: number }> {
    return this.store.courses('draft').map(c => ({
      id: c.id, version: c.version, title: c.title, description: c.spec.description,
      skills: c.spec.skills.map(s => ({ id: s.id, title: s.title, kind: s.kind, requires: [...(s.requires ?? [])] })),
      lessons: c.spec.lessons.length, items: c.spec.items.length,
    }))
  }

  /**
   * Approve or reject a draft course. Only the learner's own channel may decide.
   * @param actor - must use the `ui` channel.
   * @param request - course id, version and decision.
   */
  async decideCourse(actor: Actor, request: { courseId: string; version: string; approve: boolean }): Promise<void> {
    if (actor.channel !== 'ui') throw new HodosError('FORBIDDEN', 'only the learner can approve a proposed course, in the Hodos workspace')
    const course = this.store.course(request.courseId, request.version)
    if (course === undefined || course.status !== 'draft') throw new HodosError('NOT_FOUND', 'no such draft course')
    if (request.approve) {
      const errors = (await validateCourse(course.spec, this.registry, { requireCoverage: false })).filter(f => f.severity === 'error')
      if (errors.length > 0) throw new HodosError('INVALID_STATE', `the course no longer validates: ${errors.map(e => e.message).join('; ')}`)
    }
    this.store.setCourseStatus(request.courseId, request.version, request.approve ? 'approved' : 'rejected', this.now().toISOString())
    this.courseCache.delete(`${request.courseId}@${request.version}`)
  }

  // ---------------------------------------------------------------- data rights

  /**
   * Export the learner's own data: their responses, scores, journeys and
   * skill states. No answer keys, hints, grader feedback or grader internals.
   * @param actor - the learner.
   * @returns JSON export.
   */
  exportData(actor: Actor): JsonObject {
    const learner = this.store.learner(actor.learnerId)
    const evidence = this.store.evidence(actor.learnerId).map(e => ({
      at: e.createdAt, itemId: e.itemId, mode: e.mode, attempt: e.attempt, response: e.response,
      score: e.grade.score, correct: e.grade.correct, misconceptions: [...e.grade.misconceptions], hintLevel: e.hintLevel, assisted: e.assisted,
    }))
    // Built from an allowlist of the learner's own records: no keys, hints, feedback or grader details.
    return {
      learner: learner === undefined ? null : { id: learner.id, displayName: learner.displayName, createdAt: learner.createdAt },
      journeys: this.store.journeys(actor.learnerId).map(j => ({ id: j.id, goal: j.goalText, course: j.courseId, phase: j.state.phase, completed: [...j.state.completed] })),
      skills: [...this.states(actor.learnerId).values()].map(s => ({ skillId: s.skillId, pMastered: round(s.pMastered), gateOpen: s.gateOpen, due: s.card?.due ?? null })),
      evidence,
    }
  }
}

function startOfUtcDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function matchSkill(skills: readonly SkillSpec[], text: string): string | null {
  const wanted = new Set(tokens(text))
  if (wanted.size === 0) return null
  let best: string | null = null
  let bestScore = 0
  for (const s of skills) {
    const vocabulary = new Set([...tokens(s.title), ...tokens(s.id), ...tokens(s.description ?? '')])
    const score = [...wanted].filter(t => vocabulary.has(t) || [...vocabulary].some(v => v.startsWith(t) || t.startsWith(v))).length / wanted.size
    if (score > bestScore) {
      best = s.id
      bestScore = score
    }
  }
  return bestScore >= 0.5 ? best : null
}

function describeAction(action: NextAction): string {
  switch (action.type) {
    case 'diagnostic': return 'answer the diagnostic questions in the Hodos workspace'
    case 'approve-path': return 'review and approve the proposed learning path'
    case 'lesson': return `study the lesson for ${action.skillId}`
    case 'practice': return `practice ${action.skillId}${action.readyForCheckpoint ? ' (ready for the checkpoint)' : ''}`
    case 'checkpoint': return `complete the unassisted checkpoint for ${action.skillId}`
    case 'remedial': return `work through the remedial step for ${action.skillId}`
    case 'review': return `review ${action.due} due skill(s)`
    case 'rest': return action.reason
    case 'complete': return 'goal reached; reviews will be scheduled'
  }
}

export type { JourneyId }
