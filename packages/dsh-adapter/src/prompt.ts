/**
 * Prompt integration: a short static section describing Hodos to every
 * agent, and a per-session learner context for sessions bound to a journey.
 * Both opt out of `{{variable}}` interpolation: learner goals are user text.
 * @module @hodos/dsh/prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HodosService } from './service.js'

/** Section order: after the goal tool section (2400), before workflow tools (2600). */
export const SECTION_ORDER = 2450
/** Context order: after DSH's own runtime contexts (100–210). */
export const CONTEXT_ORDER = 300

/** The static Hodos section. */
export const HODOS_SECTION = `# Hodos learning
Hodos is the adaptive learning system installed in this harness. When the user wants to learn or practise a subject, call hodos_start_learning with their goal (or hodos_resume_learning to continue). The learner then works in the Hodos workspace (right sidebar → "Hodos learning"); you act as their tutor.

Tutoring rules while a journey is active:
- Teach through questions and explanations; never state the answer to an open exercise. Use hodos_hint for graded help.
- Diagnostic and checkpoint items are answered by the learner alone in the workspace. Do not hint, solve or judge candidate answers while one is open; offer encouragement only.
- Mastery comes only from Hodos evidence (practice, checkpoints, reviews). Never tell the learner they have mastered a skill unless Hodos reports it.
- Material you write (hodos_write_lesson, hodos_propose_course) is validated for structure but not independently verified; say so when it matters.`

/**
 * Register the section and the learner context.
 * @param ctx - plugin context with `systemPrompt`.
 * @param hodos - the Hodos service.
 */
export function registerPrompt(ctx: Context, hodos: HodosService): void {
  ctx.effect(() => ctx.systemPrompt.section({ name: 'hodos', order: SECTION_ORDER, text: HODOS_SECTION, interpolate: false }), 'hodos prompt section')
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'hodos-learner',
    order: CONTEXT_ORDER,
    interpolate: false,
    // Checkpoint policy must survive "minimal runtime context" settings.
    required: true,
    text: assembly => {
      const sessionId = assembly.agent === undefined ? undefined : String(assembly.agent.id)
      if (sessionId === undefined || !hodos.isTutorSession(sessionId)) return ''
      try {
        return hodos.engine.tutorContext(hodos.agentActor(sessionId)).text
      } catch (error) {
        // Prompt assembly must never fail because of Hodos.
        hodos.logger.warn(`learner context unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'hodos learner context')
}
