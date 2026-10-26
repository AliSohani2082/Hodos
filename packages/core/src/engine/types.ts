/**
 * Engine configuration, the trusted actor, events and the student-view data
 * transfer objects returned to hosts. Every DTO is plain JSON and has passed
 * the student-view projection and leak guard.
 * @module @hodos/core/engine/types
 */
import type { Exercise, JsonValue, LearningLoop, LessonNode, SkillKind } from '@hodos/plugin-sdk'
import type { DiagnosticAnswer } from '../diagnostic/diagnostic.js'
import type { LearnerId } from '../ids.js'
import type { BucketName, BucketSpec } from '../limits/rate-limiter.js'
import type { MasteryConfig } from '../mastery/config.js'
import type { JourneyPhase, SkillStage } from '../protocol/journey.js'
import type { HintPacing } from '../tutor/policy.js'

/** Where a request came from. Identity always comes from the host, never from arguments. */
export type Channel = 'ui' | 'agent' | 'system'

/** The authenticated caller of an engine operation. */
export interface Actor {
  readonly learnerId: LearnerId
  readonly channel: Channel
  /** Host session (e.g. a DeepSeek Harness session) the request came from. */
  readonly sessionId?: string
}

/** Engine configuration (host-tunable; plugins cannot change it). */
export interface EngineConfig {
  readonly mastery: MasteryConfig
  readonly hintPacing: HintPacing
  readonly limits: Readonly<Record<BucketName, BucketSpec>>
  /** Items per checkpoint session. */
  readonly checkpointSize: number
  /** Wait after a failed checkpoint before the next one, seconds. */
  readonly checkpointCooldownSec: number
  /** Adaptations per skill per day before the learner is asked to take a break. */
  readonly maxAdaptationsPerSkillPerDay: number
  /** Probability that a practice item comes from an earlier skill. */
  readonly interleaveProbability: number
  /** Require every formative check of a lesson to be answered before practice. */
  readonly requireLessonChecks: boolean
  /** Let the tutor agent approve paths of approved (shipped) courses on the learner's behalf. */
  readonly agentMayApproveShippedPaths: boolean
  readonly diagnostic: { readonly particles: number; readonly minQuestions: number; readonly maxQuestions: number }
  /** Base seed for reproducible selection (per learner and journey). */
  readonly seed: number
}

/** Learner self-report level (weak prior; never verified mastery). */
export type SelfReportLevel = 'never' | 'heard-of' | 'used-it'

/** One self-reported skill, by id or by free text matched against skill titles. */
export interface SelfReport {
  readonly skillId?: string
  readonly skill?: string
  readonly level: SelfReportLevel
}

/** Status of a skill in a journey view. */
export type SkillStatus = 'locked' | 'available' | 'active' | 'mastered' | 'known' | 'review-due'

/** A skill as the learner sees it. */
export interface SkillView {
  readonly id: string
  readonly title: string
  readonly kind: SkillKind
  readonly loop: LearningLoop
  readonly status: SkillStatus
  readonly pMastered: number
  /** pMastered × R(now) for graduated skills. */
  readonly effective: number
  readonly confidence: number
  readonly gateOpen: boolean
  /** Unmet gate conditions in plain language. */
  readonly unmet: readonly string[]
  readonly evidenceCount: number
  readonly dueAt: string | null
}

/** What the learner should do next. */
export type NextAction =
  | { readonly type: 'diagnostic'; readonly remaining: number }
  | { readonly type: 'approve-path' }
  | { readonly type: 'lesson'; readonly skillId: string }
  | { readonly type: 'practice'; readonly skillId: string; readonly readyForCheckpoint: boolean }
  | { readonly type: 'checkpoint'; readonly skillId: string; readonly checkpointId: string }
  | { readonly type: 'remedial'; readonly skillId: string }
  | { readonly type: 'review'; readonly due: number }
  | { readonly type: 'rest'; readonly reason: string }
  | { readonly type: 'complete' }

/** Journey overview. */
export interface JourneyView {
  readonly id: string
  readonly goalText: string
  readonly course: { readonly id: string; readonly version: string; readonly title: string; readonly origin: string }
  readonly phase: JourneyPhase
  readonly stage: SkillStage | null
  readonly activeSkill: SkillView | null
  /** Skills still to learn, in order (the active one first). */
  readonly path: readonly SkillView[]
  readonly completed: readonly string[]
  /** Skills finished on this journey, in the order they were completed. */
  readonly completedSkills: readonly SkillView[]
  /** Skill ids the diagnostic placed out. */
  readonly diagnosedKnown: readonly string[]
  /** The same skills with their titles, for display. */
  readonly knownSkills: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly pathApproved: boolean
  readonly progress: { readonly mastered: number; readonly total: number; readonly percent: number }
  readonly environments: ReadonlyArray<{ readonly id: string; readonly available: boolean }>
  readonly dueReviews: number
  readonly nextAction: NextAction
}

/** A renderer the workspace can load in a sandboxed iframe. */
export interface RendererRef {
  readonly pluginId: string
  readonly rendererId: string
  readonly entry: string
}

/** A presented exercise with what the workspace needs to render it. */
export interface ExerciseView extends Exercise {
  readonly title: string
  readonly skillTitle: string
  /** Plain-text projection (no key), for agents and missing renderers. */
  readonly fallbackText: string
  /** Renderer to load, when installed. */
  readonly renderer: RendererRef | null
  readonly responseKind: string
  readonly attemptsAllowed: number
  /** Hints already revealed (released levels only). */
  readonly hints: ReadonlyArray<{ readonly level: number; readonly text: string }>
  readonly checkpoint?: { readonly id: string; readonly index: number; readonly total: number }
  readonly diagnostic?: { readonly asked: number; readonly max: number }
}

/** Outcome of submitting a response. */
export interface AttemptView {
  readonly presentationId: string
  /** `recorded`: assessment modes withhold correctness; `continue`: a stepwise exercise advanced. */
  readonly status: 'correct' | 'incorrect' | 'partial' | 'recorded' | 'continue'
  readonly mode: string
  readonly score?: number
  readonly feedback?: string
  readonly misconceptionFeedback?: readonly string[]
  readonly explanation?: string
  readonly reveal?: JsonValue
  readonly progress?: JsonValue
  readonly message?: string
  readonly canRetry: boolean
  readonly attemptsLeft: number
  readonly hintsAvailable: number
  /** Several wrong answers: help is offered proactively. */
  readonly stuck: boolean
  readonly skill?: SkillView
  readonly checkpoint?: CheckpointView
  readonly nextAction?: NextAction
}

/** One revealed hint. */
export interface HintView {
  readonly presentationId: string
  readonly level: number
  readonly text: string
  readonly bottomOut: boolean
  readonly hintsRemaining: number
  readonly explanation?: string
  readonly reveal?: JsonValue
}

/** Checkpoint status and, once finished, its result. */
export interface CheckpointView {
  readonly id: string
  readonly skillId: string
  readonly status: 'active' | 'passed' | 'failed' | 'abandoned'
  readonly total: number
  readonly answered: number
  readonly result?: {
    readonly passed: boolean
    readonly correct: number
    readonly items: ReadonlyArray<{ readonly itemId: string; readonly correct: boolean; readonly explanation?: string; readonly reveal?: JsonValue }>
    readonly unmet: readonly string[]
    readonly adaptation?: { readonly insertedPrerequisites: readonly string[]; readonly focus: readonly string[]; readonly rest: boolean }
  }
}

/** A lesson for the learner (projected; formative answers withheld until answered). */
export interface LessonView {
  readonly skillId: string
  readonly lessons: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly origin: 'course' | 'overlay' | 'generated'
    readonly tree: LessonNode
    readonly text: string
    readonly checks: ReadonlyArray<{ readonly id: string; readonly answered: boolean; readonly correct: boolean }>
    /** Plugin blocks by node id: their plain-text meaning and the renderer that can draw them. */
    readonly blocks: Readonly<Record<string, { readonly type: string; readonly text: string; readonly renderer: RendererRef | null }>>
  }>
  readonly canComplete: boolean
}

/** Answer to a formative lesson check. */
export interface CheckAnswerView {
  readonly checkId: string
  readonly correct: boolean
  readonly explanation?: string
}

/** Learner progress across a journey's skills. */
export interface ProgressView {
  readonly journeyId: string | null
  readonly skills: readonly SkillView[]
  readonly mastered: number
  readonly total: number
  readonly percent: number
  readonly dueReviews: ReadonlyArray<{ readonly skillId: string; readonly title: string; readonly dueAt: string; readonly retrievability: number }>
  readonly hintsUsed: number
  readonly recent: ReadonlyArray<{ readonly itemId: string; readonly skillId: string; readonly mode: string; readonly correct: boolean; readonly at: string }>
}

/** Diagnostic answer submitted directly (the "I don't know" button). */
export type DiagnosticResponse = { readonly dontKnow: true } | { readonly answer: DiagnosticAnswer }

/** Events the engine emits for hosts (e.g. to notify the tutor agent). */
export type EngineEvent =
  | { readonly type: 'attempt'; readonly learnerId: LearnerId; readonly journeyId: string | null; readonly skillId: string; readonly mode: string; readonly status: AttemptView['status']; readonly hintLevel: number; readonly channel: Channel }
  | { readonly type: 'hint'; readonly learnerId: LearnerId; readonly skillId: string; readonly level: number; readonly channel: Channel }
  | { readonly type: 'checkpoint'; readonly learnerId: LearnerId; readonly journeyId: string; readonly skillId: string; readonly passed: boolean }
  | { readonly type: 'journey'; readonly learnerId: LearnerId; readonly journeyId: string; readonly phase: JourneyPhase; readonly stage: SkillStage | null; readonly activeSkill: string | null }
  | { readonly type: 'security'; readonly learnerId: LearnerId | null; readonly kind: string }
