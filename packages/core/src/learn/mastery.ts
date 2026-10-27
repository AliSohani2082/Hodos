/**
 * The mastery layer of a learning session: a BKT-lite estimate and an FSRS
 * review schedule per plan node.
 *
 * LearnHarness itself keeps no mastery model; Hodos adds this layer on top of
 * the same process. Only check and review answers that were graded by a
 * deterministic, engine or oracle grader move it. Predict questions come
 * before the teaching, probe questions before the plan, and free-recall
 * answers are judged by the model, so none of those count. Nothing in the
 * session's flow depends on this layer; it informs the learner's view and
 * the reviews the tutor offers.
 * @module @hodos/core/learn/mastery
 */
import { bktUpdate, DEFAULT_BKT_PARAMS, type BktParams } from '../mastery/bkt.js'
import { DEFAULT_THETA } from '../mastery/config.js'
import { gradeRetrieval, type FsrsScheduler } from '../mastery/fsrs.js'
import type { NodeStateRecord } from './repository.js'
import type { QuestionRole, QuestionVerdict } from './question.js'

/** One graded answer about a plan node. */
export interface NodeObservation {
  readonly sessionId: string
  readonly nodeId: string
  readonly learnerId: NodeStateRecord['learnerId']
  readonly role: QuestionRole
  readonly verdict: QuestionVerdict
  /** Options of a choice question; raises the guess floor. */
  readonly options?: number
}

/**
 * Whether an answer moves the node's estimate.
 * @param observation - the answer.
 * @returns true for graded check and review answers that count as evidence.
 */
export function movesMastery(observation: NodeObservation): boolean {
  return (observation.role === 'check' || observation.role === 'review') && observation.verdict.countsAsEvidence && observation.verdict.score !== null
}

/**
 * Apply one answer to a node's state.
 * @param prev - the node's state, or undefined before its first observation.
 * @param observation - the answer; must satisfy {@link movesMastery}.
 * @param now - the answer time.
 * @param scheduler - the FSRS scheduler.
 * @param params - BKT parameters.
 * @returns the next state.
 */
export function observeNode(prev: NodeStateRecord | undefined, observation: NodeObservation, now: Date, scheduler: FsrsScheduler, params: BktParams = DEFAULT_BKT_PARAMS): NodeStateRecord {
  const score = observation.verdict.score ?? 0
  const pMastered = bktUpdate(prev?.pMastered ?? params.p0, {
    x: score,
    hintLevel: 0,
    b: 0,
    mode: observation.role === 'review' ? 'review' : 'practice',
    ...(observation.options === undefined ? {} : { options: observation.options }),
  }, params)
  const card = scheduler.review(prev?.card ?? null, gradeRetrieval({ evidence: score, assisted: false, bottomOut: false }), now)
  return {
    sessionId: observation.sessionId,
    nodeId: observation.nodeId,
    learnerId: observation.learnerId,
    pMastered,
    card,
    dueAt: card.due,
    observations: (prev?.observations ?? 0) + 1,
    updatedAt: now.toISOString(),
  }
}

/** A node's mastery as the learner and the teacher see it. */
export interface NodeMasteryView {
  readonly nodeId: string
  readonly pMastered: number
  /** The estimate is at or above the mastery threshold. */
  readonly mastered: boolean
  readonly observations: number
  readonly dueAt: string | null
}

/**
 * The view of a node state.
 * @param state - the stored state.
 * @param theta - mastery threshold.
 * @returns the view.
 */
export function nodeMasteryView(state: NodeStateRecord, theta: number = DEFAULT_THETA): NodeMasteryView {
  return { nodeId: state.nodeId, pMastered: state.pMastered, mastered: state.pMastered >= theta, observations: state.observations, dueAt: state.dueAt }
}
