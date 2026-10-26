/**
 * Plain-text renderings of engine views for the tutor model. Every view has
 * already passed the student-view projection and leak guard; these functions
 * only choose what the model needs to read.
 * @module @hodos/dsh/describe
 */
import type { AttemptView, CheckpointView, ExerciseView, HintView, JourneyView, LessonView, NextAction, ProgressView, SkillView } from '@hodos/core'
import { unreachable } from '@hodos/plugin-sdk'

const WORKSPACE_HINT = 'The learner works in the Hodos workspace: right sidebar → "Hodos learning".'

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

/**
 * @param action - next action.
 * @returns what the learner should do next.
 */
export function describeNext(action: NextAction): string {
  switch (action.type) {
    case 'diagnostic': return `Next: the learner answers up to ${action.remaining} short diagnostic questions in the workspace ("I don't know" is fine). Do not answer them for the learner.`
    case 'approve-path': return 'Next: review the proposed path with the learner and approve it (hodos_approve_path) or let them approve it in the workspace.'
    case 'lesson': return `Next: the lesson for ${action.skillId}. Use hodos_lesson to read it and teach it conversationally; the learner answers its check questions.`
    case 'practice': return action.readyForCheckpoint
      ? `Next: practice on ${action.skillId} is enough for a checkpoint. Suggest the unassisted checkpoint (hodos_start_checkpoint).`
      : `Next: practice on ${action.skillId} (hodos_next_exercise shows the current exercise).`
    case 'checkpoint': return `Next: the learner completes the unassisted checkpoint for ${action.skillId} in the workspace. Do not help with checkpoint items.`
    case 'remedial': return `Next: a short remedial step for ${action.skillId}; use hodos_lesson, then hodos_complete_lesson when done.`
    case 'review': return `Next: ${action.due} skill(s) are due for review (hodos_start_review).`
    case 'rest': return `Next: ${action.reason}.`
    case 'complete': return 'The goal is reached. Reviews will be scheduled to keep it fresh.'
    default: return unreachable(action, 'next action')
  }
}

function skillLine(s: SkillView): string {
  return `- ${s.title} [${s.id}] — ${s.status}, evidence ${pct(s.pMastered)}${s.unmet.length > 0 && s.status === 'active' ? `; still needed: ${s.unmet.join('; ')}` : ''}`
}

/**
 * @param view - journey view.
 * @returns a compact description.
 */
export function describeJourney(view: JourneyView): string {
  const lines = [
    `Journey ${view.id}: "${view.goalText}" — course "${view.course.title}" (${view.course.id}@${view.course.version}).`,
    `Phase ${view.phase}${view.stage === null ? '' : `, stage ${view.stage}`}. Progress ${view.progress.mastered}/${view.progress.total} skills (${view.progress.percent}%).`,
  ]
  if (view.diagnosedKnown.length > 0) lines.push(`Already known (from the diagnostic): ${view.diagnosedKnown.join(', ')}.`)
  if (view.path.length > 0) lines.push(`Path${view.pathApproved ? '' : ' (proposed, not yet approved)'}:`, ...view.path.map(skillLine))
  const missing = view.environments.filter(e => !e.available).map(e => e.id)
  if (missing.length > 0) lines.push(`Not installed: ${missing.join(', ')} — exercises for it are unavailable; progress is kept.`)
  if (view.dueReviews > 0) lines.push(`${view.dueReviews} skill(s) due for review.`)
  lines.push(describeNext(view.nextAction), WORKSPACE_HINT)
  return lines.join('\n')
}

/**
 * @param view - exercise view.
 * @returns the exercise as the tutor may see it (no key).
 */
export function describeExercise(view: ExerciseView): string {
  const lines = [
    `Exercise ${view.id} (${view.mode}, ${view.title}, skill: ${view.skillTitle}, attempt ${view.attempt} of ${view.attemptsAllowed}).`,
    view.fallbackText,
  ]
  if (view.hints.length > 0) lines.push('Hints already revealed:', ...view.hints.map(h => `  L${h.level}: ${h.text}`))
  if (view.mode === 'practice') lines.push(`${view.hintsAvailable} more hint level(s) available through hodos_hint.`)
  if (view.mode === 'checkpoint' || view.mode === 'diagnostic') lines.push('Assessment item: the learner answers alone in the workspace. Do not hint, solve or evaluate candidate answers.')
  if (view.checkpoint !== undefined) lines.push(`Checkpoint item ${view.checkpoint.index} of ${view.checkpoint.total}.`)
  return lines.join('\n')
}

/**
 * @param view - attempt result.
 * @returns the outcome for the tutor.
 */
export function describeAttempt(view: AttemptView): string {
  const lines: string[] = []
  switch (view.status) {
    case 'continue': lines.push(`Step accepted.${view.message === undefined ? '' : ` ${view.message}`}`); break
    case 'recorded': lines.push('Answer recorded (assessment answers are scored at the end).'); break
    default: lines.push(`Result: ${view.status}${view.score === undefined ? '' : ` (score ${pct(view.score)})`}.`)
  }
  if (view.feedback !== undefined) lines.push(`Feedback: ${view.feedback}`)
  for (const m of view.misconceptionFeedback ?? []) lines.push(`Misconception: ${m}`)
  if (view.explanation !== undefined) lines.push(`Explanation (released): ${view.explanation}`)
  if (view.canRetry) lines.push(`${view.attemptsLeft} attempt(s) left; ${view.hintsAvailable} hint level(s) available.`)
  if (view.stuck) lines.push('The learner has missed several items in a row: offer a worked example or a hint.')
  if (view.checkpoint !== undefined) lines.push(describeCheckpoint(view.checkpoint))
  if (view.skill !== undefined) lines.push(`Skill ${view.skill.title}: evidence ${pct(view.skill.pMastered)}, ${view.skill.gateOpen ? 'mastered' : `still needed: ${view.skill.unmet.join('; ') || 'more practice'}`}.`)
  if (view.nextAction !== undefined) lines.push(describeNext(view.nextAction))
  return lines.join('\n')
}

/**
 * @param view - hint.
 * @returns the hint text for the tutor.
 */
export function describeHint(view: HintView): string {
  return [
    `Hint level ${view.level}${view.bottomOut ? ' (bottom-out: the answer is now released)' : ''}: ${view.text}`,
    view.explanation === undefined ? '' : `Explanation: ${view.explanation}`,
    `${view.hintsRemaining} more level(s) available. Hints you relay count as assistance on this exercise.`,
  ].filter(Boolean).join('\n')
}

/**
 * @param view - checkpoint status.
 * @returns a description.
 */
export function describeCheckpoint(view: CheckpointView): string {
  if (view.result === undefined) return `Checkpoint ${view.id} for ${view.skillId}: ${view.status}, ${view.answered}/${view.total} answered.`
  const r = view.result
  const lines = [`Checkpoint for ${view.skillId}: ${r.passed ? 'PASSED' : 'not passed'} (${r.correct}/${view.total} correct).`]
  if (!r.passed && r.unmet.length > 0) lines.push(`Still needed: ${r.unmet.join('; ')}.`)
  if (r.adaptation !== undefined) {
    if (r.adaptation.rest) lines.push('Adaptation: suggest a break; the remedial step stays available.')
    if (r.adaptation.insertedPrerequisites.length > 0) lines.push(`Adaptation: prerequisites inserted first: ${r.adaptation.insertedPrerequisites.join(', ')}.`)
    if (r.adaptation.focus.length > 0) lines.push(`Focus on: ${r.adaptation.focus.join(', ')}.`)
  }
  return lines.join('\n')
}

/**
 * @param view - lesson view.
 * @returns the lesson text and its formative checks.
 */
export function describeLesson(view: LessonView): string {
  const parts = view.lessons.map(l => {
    const checks = l.checks.map(c => `  check ${c.id}: ${c.answered ? (c.correct ? 'answered correctly' : 'answered, not yet correct') : 'not answered'}`)
    return [`## ${l.title} (${l.origin}, lesson ${l.id})`, l.text, ...(checks.length > 0 ? ['Formative checks:', ...checks] : [])].join('\n')
  })
  parts.push(view.canComplete ? 'The lesson can be marked complete (hodos_complete_lesson).' : 'The learner still has to answer the lesson\'s check questions.')
  return parts.join('\n\n')
}

/**
 * @param view - progress.
 * @returns a progress summary.
 */
export function describeProgress(view: ProgressView): string {
  const lines = [`Mastered ${view.mastered}/${view.total} (${view.percent}%). Hints used: ${view.hintsUsed}.`, ...view.skills.map(skillLine)]
  if (view.dueReviews.length > 0) lines.push('Due for review:', ...view.dueReviews.map(d => `- ${d.title} (recall ${pct(d.retrievability)})`))
  return lines.join('\n')
}
