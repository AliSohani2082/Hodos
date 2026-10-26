/**
 * The learning protocol as an explicit, pure state machine.
 *
 *   goal → diagnostic → planning → learning ⟲ → complete
 *   learning, per active skill:
 *     teach → practice → checkpoint ─pass→ next skill (teach) | complete
 *                           └fail→ adapt → remedial → practice → checkpoint …
 *   learning | complete → reviewing → (back)
 *
 * Every change is an event; `transition` validates it against the current
 * state and returns the next state or throws `INVALID_STATE`. The engine
 * persists each event, so a journey can be replayed and resumed.
 * @module @hodos/core/protocol/journey
 */
import { unreachable } from '@hodos/plugin-sdk'
import { HodosError } from '../errors.js'

/** Journey phase. */
export type JourneyPhase = 'diagnostic' | 'planning' | 'learning' | 'reviewing' | 'complete'

/** Stage of the active skill while learning. */
export type SkillStage = 'teach' | 'practice' | 'checkpoint' | 'adapt' | 'remedial'

/** Journey protocol state (the persisted part the state machine owns). */
export interface JourneyState {
  readonly phase: JourneyPhase
  /** Skills still to learn, in order. Mastered skills are removed from the head. */
  readonly path: readonly string[]
  readonly pathApproved: boolean
  readonly activeSkill: string | null
  readonly stage: SkillStage | null
  /** Skills mastered during this journey, in order. */
  readonly completed: readonly string[]
  /** Skills the diagnostic classified as already known. */
  readonly diagnosedKnown: readonly string[]
  /** Adaptations applied per skill (bounded by policy). */
  readonly adaptations: Readonly<Record<string, number>>
  /** Phase to return to when a review session ends. */
  readonly resumePhase: 'learning' | 'complete' | null
}

/** Events that move a journey. */
export type JourneyEvent =
  | { readonly type: 'DIAGNOSTIC_COMPLETED'; readonly known: readonly string[] }
  | { readonly type: 'DIAGNOSTIC_SKIPPED' }
  | { readonly type: 'PATH_PROPOSED'; readonly path: readonly string[] }
  | { readonly type: 'PATH_APPROVED' }
  | { readonly type: 'LESSON_COMPLETED' }
  | { readonly type: 'CHECKPOINT_STARTED' }
  | { readonly type: 'CHECKPOINT_ABANDONED' }
  | { readonly type: 'CHECKPOINT_PASSED' }
  | { readonly type: 'CHECKPOINT_FAILED' }
  | { readonly type: 'ADAPTATION_APPLIED'; readonly insertBefore?: readonly string[] }
  | { readonly type: 'REMEDIAL_COMPLETED' }
  | { readonly type: 'SKILL_ALREADY_MASTERED'; readonly skillId: string }
  | { readonly type: 'REVIEW_STARTED' }
  | { readonly type: 'REVIEW_COMPLETED' }

/** Every event type, for persistence validation. */
export const JOURNEY_EVENT_TYPES: readonly JourneyEvent['type'][] = [
  'DIAGNOSTIC_COMPLETED', 'DIAGNOSTIC_SKIPPED', 'PATH_PROPOSED', 'PATH_APPROVED', 'LESSON_COMPLETED',
  'CHECKPOINT_STARTED', 'CHECKPOINT_ABANDONED', 'CHECKPOINT_PASSED', 'CHECKPOINT_FAILED', 'ADAPTATION_APPLIED',
  'REMEDIAL_COMPLETED', 'SKILL_ALREADY_MASTERED', 'REVIEW_STARTED', 'REVIEW_COMPLETED',
]

/**
 * The state of a newly created journey.
 * @param withDiagnostic - start with a diagnostic (true) or go straight to planning.
 * @returns the initial state.
 */
export function initialJourneyState(withDiagnostic: boolean): JourneyState {
  return {
    phase: withDiagnostic ? 'diagnostic' : 'planning',
    path: [],
    pathApproved: false,
    activeSkill: null,
    stage: null,
    completed: [],
    diagnosedKnown: [],
    adaptations: {},
    resumePhase: null,
  }
}

function invalid(state: JourneyState, event: JourneyEvent): never {
  throw new HodosError(
    'INVALID_STATE',
    `cannot apply ${event.type} in phase ${state.phase}${state.stage === null ? '' : ` (stage ${state.stage})`}`,
    { phase: state.phase, stage: state.stage, event: event.type },
  )
}

function startNextSkill(state: JourneyState, path: readonly string[]): JourneyState {
  const next = path[0]
  return next === undefined
    ? { ...state, path: [], phase: 'complete', activeSkill: null, stage: null }
    : { ...state, path, phase: 'learning', activeSkill: next, stage: 'teach' }
}

/**
 * Apply one event.
 * @param state - current state.
 * @param event - the event.
 * @returns the next state.
 * @throws {HodosError} `INVALID_STATE` when the event is not allowed now, or
 *   `INVALID_INPUT` when its data is inconsistent (e.g. an empty proposed path).
 */
export function transition(state: JourneyState, event: JourneyEvent): JourneyState {
  switch (event.type) {
    case 'DIAGNOSTIC_COMPLETED':
      if (state.phase !== 'diagnostic') invalid(state, event)
      return { ...state, phase: 'planning', diagnosedKnown: [...new Set(event.known)] }
    case 'DIAGNOSTIC_SKIPPED':
      if (state.phase !== 'diagnostic') invalid(state, event)
      return { ...state, phase: 'planning' }
    case 'PATH_PROPOSED': {
      if (state.phase !== 'planning') invalid(state, event)
      const unique = [...new Set(event.path)]
      if (unique.length !== event.path.length) throw new HodosError('INVALID_INPUT', 'the proposed path repeats a skill')
      return { ...state, path: unique, pathApproved: false }
    }
    case 'PATH_APPROVED':
      if (state.phase !== 'planning') invalid(state, event)
      return startNextSkill({ ...state, pathApproved: true }, state.path)
    case 'LESSON_COMPLETED':
      if (state.phase !== 'learning' || state.stage !== 'teach') invalid(state, event)
      return { ...state, stage: 'practice' }
    case 'CHECKPOINT_STARTED':
      // Test-out is allowed from teach (PRD DG-6); remedial work must finish first.
      if (state.phase !== 'learning' || (state.stage !== 'practice' && state.stage !== 'teach')) invalid(state, event)
      return { ...state, stage: 'checkpoint' }
    case 'CHECKPOINT_ABANDONED':
      if (state.phase !== 'learning' || state.stage !== 'checkpoint') invalid(state, event)
      return { ...state, stage: 'practice' }
    case 'CHECKPOINT_PASSED': {
      if (state.phase !== 'learning' || state.stage !== 'checkpoint' || state.activeSkill === null) invalid(state, event)
      const done = state.activeSkill
      return startNextSkill({ ...state, completed: [...state.completed, done] }, state.path.filter(s => s !== done))
    }
    case 'CHECKPOINT_FAILED':
      if (state.phase !== 'learning' || state.stage !== 'checkpoint') invalid(state, event)
      return { ...state, stage: 'adapt' }
    case 'ADAPTATION_APPLIED': {
      if (state.phase !== 'learning' || state.stage !== 'adapt' || state.activeSkill === null) invalid(state, event)
      const skill = state.activeSkill
      const adaptations = { ...state.adaptations, [skill]: (state.adaptations[skill] ?? 0) + 1 }
      const insert = (event.insertBefore ?? []).filter(s => !state.path.includes(s) && !state.completed.includes(s))
      if (insert.length === 0) return { ...state, stage: 'remedial', adaptations }
      // A weak prerequisite becomes the active skill; the current one waits behind it.
      return startNextSkill({ ...state, adaptations }, [...insert, ...state.path])
    }
    case 'REMEDIAL_COMPLETED':
      if (state.phase !== 'learning' || state.stage !== 'remedial') invalid(state, event)
      return { ...state, stage: 'practice' }
    case 'SKILL_ALREADY_MASTERED': {
      if (state.phase !== 'learning' && state.phase !== 'planning') invalid(state, event)
      const path = state.path.filter(s => s !== event.skillId)
      const completed = state.completed.includes(event.skillId) ? state.completed : [...state.completed, event.skillId]
      if (state.phase === 'planning') return { ...state, path, completed }
      return state.activeSkill === event.skillId ? startNextSkill({ ...state, completed }, path) : { ...state, path, completed }
    }
    case 'REVIEW_STARTED':
      if (state.phase !== 'learning' && state.phase !== 'complete') invalid(state, event)
      if (state.phase === 'learning' && state.stage === 'checkpoint') invalid(state, event)
      return { ...state, phase: 'reviewing', resumePhase: state.phase }
    case 'REVIEW_COMPLETED':
      if (state.phase !== 'reviewing' || state.resumePhase === null) invalid(state, event)
      return { ...state, phase: state.resumePhase, resumePhase: null }
    default: return unreachable(event, 'journey event')
  }
}

/**
 * Replay a sequence of events from an initial state.
 * @param initial - the starting state.
 * @param events - events in order.
 * @returns the final state.
 */
export function replayJourney(initial: JourneyState, events: readonly JourneyEvent[]): JourneyState {
  return events.reduce(transition, initial)
}
