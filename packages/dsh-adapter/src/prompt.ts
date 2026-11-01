/**
 * Prompt integration: a short static section describing Hodos to every
 * agent, and for chats that are Hodos sessions, the tutor's method for the
 * session's kind and phase plus the session's state (goal, assessment, plan,
 * open question, recent answers, due reviews). Both opt out of
 * `{{variable}}` interpolation: goals and answers are user text.
 * @module @hodos/dsh/prompt
 */
import type { Context } from '@deepseek-ai/cordis'
import { PRACTICE, PROBE, SHARED, TEACH } from './doctrine.js'
import type { HodosService } from './service.js'

/** Section order: after the goal tool section (2400), before workflow tools (2600). */
export const SECTION_ORDER = 2450
/** Context order: after DSH's own runtime contexts (100–210). */
export const CONTEXT_ORDER = 300

/** The static Hodos section. */
export const HODOS_SECTION = `# Hodos learning
Hodos is the learning system installed in this harness. When the user wants to learn or understand something, call hodos_start_learning with their goal: this chat becomes a learning session where you probe what they know, plan, and teach with questions shown in the Hodos panel (right sidebar). To practise what they have learned, call hodos_start_practice. Their knowledge graph, built from what was taught, is in the "Knowledge graph" sidebar tab.`

/**
 * The tutor's context for a chat, or an empty string for ordinary chats.
 * @param hodos - the Hodos service.
 * @param chatId - DSH session id.
 * @returns prompt text.
 */
export function tutorPrompt(hodos: HodosService, chatId: string): string {
  const binding = hodos.binding(chatId)
  if (binding === null) return ''
  if (binding.kind === 'practice') {
    if (binding.closed) return ''
    return [SHARED, PRACTICE, '## This practice session', hodos.practice.tutorContext(binding.sessionId)].join('\n\n')
  }
  if (binding.phase === 'closed') return ''
  const parts = [SHARED, binding.phase === 'probe' ? PROBE : TEACH, '## This learning session', hodos.learn.tutorContext(binding.sessionId)]
  const session = hodos.learnRepo.session(binding.sessionId)
  const due = session === undefined ? [] : hodos.learn.dueReviews(session.learnerId).filter(d => d.sessionId === session.id)
  if (due.length > 0) parts.push(`Due for review (ask a review question on these when it fits): ${due.map(d => `${d.nodeId} (${d.title})`).join(', ')}`)
  return parts.join('\n\n')
}

/**
 * Register the section and the session context.
 * @param ctx - plugin context with `systemPrompt`.
 * @param hodos - the Hodos service.
 */
export function registerPrompt(ctx: Context, hodos: HodosService): void {
  ctx.effect(() => ctx.systemPrompt.section({ name: 'hodos', order: SECTION_ORDER, text: HODOS_SECTION, interpolate: false }), 'hodos prompt section')
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'hodos-learner',
    order: CONTEXT_ORDER,
    interpolate: false,
    // The tutor's rules must survive "minimal runtime context" settings.
    required: true,
    text: assembly => {
      if (assembly.agent === undefined) return ''
      try {
        return tutorPrompt(hodos, String(assembly.agent.id))
      } catch (error) {
        // Prompt assembly must never fail because of Hodos.
        hodos.logger.warn(`tutor context unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'hodos tutor context')
}
