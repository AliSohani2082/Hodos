/**
 * The phases of a learning session and the probe's assessment.
 *
 *   probe  ── probe_done ──▶ plan ── first question about a plan node ──▶ teach
 *
 * The session starts with the prober, which brackets where the learner's
 * understanding ends on each strand the goal depends on, and concludes once
 * with an assessment. The teacher then writes the plan map; teaching starts
 * with the first question tagged with a plan node. The seams are events
 * (the conclusion, the first tagged question), never guesses from the
 * transcript. A closed session accepts nothing.
 * @module @hodos/core/learn/session
 */
import { unreachable } from '@hodos/plugin-sdk'
import type { QuestionRole } from './question.js'

/** Where a learning session stands. */
export type LearnPhase = 'probe' | 'plan' | 'teach' | 'closed'

/** All phases. */
export const LEARN_PHASES: readonly LearnPhase[] = ['probe', 'plan', 'teach', 'closed']

/** One dependency strand the lesson rests on, with the prober's read of the learner. */
export interface ProbeStrand {
  /** The strand, named so a plan node can hang on it (for example "the derivative as a limit"). */
  readonly strand: string
  /** Where the learner's edge sits: what they reliably get right, where it runs out, misconceptions found. */
  readonly assessment: string
}

/** The prober's conclusion. */
export interface ProbeAssessment {
  readonly strands: readonly ProbeStrand[]
  /** The learner's apparent goal and where teaching should start. */
  readonly summary?: string
}

/** Size limits on an assessment. */
export const ASSESSMENT_LIMITS = { maxStrands: 12, strandChars: 200, assessmentChars: 2000, summaryChars: 2000 } as const

/** Size limit on a session goal. */
export const GOAL_MAX_CHARS = 500

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Read a probe assessment from untrusted tool input. Models sometimes send
 * the assessment JSON-encoded as a string; that is accepted.
 * @param input - the `assessment` argument.
 * @param problems - collected problems.
 * @returns the assessment when it is well formed.
 */
export function readProbeAssessment(input: unknown, problems: string[]): ProbeAssessment | undefined {
  let raw = input
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      problems.push('assessment must be an object with strands, not text')
      return undefined
    }
  }
  const o = obj(raw)
  if (o === null) {
    problems.push('assessment must be an object: { strands: [{ strand, assessment }], summary? }')
    return undefined
  }
  if (!Array.isArray(o.strands) || o.strands.length === 0) {
    problems.push('assessment.strands must list every strand the lesson depends on (at least one)')
    return undefined
  }
  if (o.strands.length > ASSESSMENT_LIMITS.maxStrands) problems.push(`assessment.strands has ${o.strands.length} entries; keep it to ${ASSESSMENT_LIMITS.maxStrands} or fewer`)
  const strands: ProbeStrand[] = []
  o.strands.forEach((entry, i) => {
    const s = obj(entry)
    const strand = typeof s?.strand === 'string' ? s.strand.trim() : ''
    const assessment = typeof s?.assessment === 'string' ? s.assessment.trim() : ''
    if (strand === '' || assessment === '') {
      problems.push(`strand ${i + 1} needs both "strand" and "assessment" text`)
      return
    }
    if (strand.length > ASSESSMENT_LIMITS.strandChars) problems.push(`strand ${i + 1}'s name is longer than ${ASSESSMENT_LIMITS.strandChars} characters`)
    if (assessment.length > ASSESSMENT_LIMITS.assessmentChars) problems.push(`strand ${i + 1}'s assessment is longer than ${ASSESSMENT_LIMITS.assessmentChars} characters`)
    strands.push({ strand, assessment })
  })
  let summary: string | undefined
  if (o.summary !== undefined && o.summary !== null) {
    if (typeof o.summary !== 'string') problems.push('assessment.summary must be text')
    else if (o.summary.trim().length > ASSESSMENT_LIMITS.summaryChars) problems.push(`assessment.summary is longer than ${ASSESSMENT_LIMITS.summaryChars} characters`)
    else if (o.summary.trim() !== '') summary = o.summary.trim()
  }
  if (problems.length > 0) return undefined
  return { strands, ...(summary === undefined ? {} : { summary }) }
}

/**
 * The question roles a phase accepts. Probing asks untagged probe
 * questions; planning and teaching ask about plan nodes.
 * @param phase - the session phase.
 * @returns the accepted roles.
 */
export function rolesFor(phase: LearnPhase): readonly QuestionRole[] {
  switch (phase) {
    case 'probe': return ['probe']
    case 'plan':
    case 'teach': return ['predict', 'check', 'review']
    case 'closed': return []
    default: return unreachable(phase, 'learning phase')
  }
}

/**
 * The phase after a question is asked: the first question about a plan
 * node starts teaching.
 * @param phase - the phase before.
 * @param nodeId - the node the question is about.
 * @returns the phase after.
 */
export function phaseAfterQuestion(phase: LearnPhase, nodeId: string | undefined): LearnPhase {
  return phase === 'plan' && nodeId !== undefined ? 'teach' : phase
}

/**
 * Plain text of an assessment, for the teacher's context.
 * @param assessment - the prober's conclusion.
 * @returns one line per strand, then the summary.
 */
export function assessmentText(assessment: ProbeAssessment): string {
  const lines = assessment.strands.map(s => `- ${s.strand}: ${s.assessment}`)
  if (assessment.summary !== undefined) lines.push(`Summary: ${assessment.summary}`)
  return lines.join('\n')
}
