/**
 * The tutor agent's Hodos tools. Identity always comes from the calling
 * agent's session (`exec.agent.id`), never from arguments; answers relayed
 * through these tools count as assisted; checkpoint and diagnostic answers
 * are refused here and must come from the learner in the workspace.
 *
 * Four tools are global (start, resume, list and propose courses). The rest
 * exist only in sessions bound to a learning journey (see `tutor-sessions.ts`).
 * @module @hodos/dsh/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HodosError, type Actor } from '@hodos/core'
import { describeAttempt, describeCheckpoint, describeExercise, describeHint, describeJourney, describeLesson, describeNext, describeProgress } from './describe.js'
import type { HodosService } from './service.js'

/** Tools every session sees. */
export const GLOBAL_TOOL_NAMES = ['hodos_start_learning', 'hodos_resume_learning', 'hodos_list_courses', 'hodos_propose_course'] as const

const OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', required: true, description: 'What the tutor needs to know.' },
    ref: { type: 'string', description: 'Id of the journey, exercise or course the result is about.' },
  },
  additionalProperties: false,
} as const

/** Callbacks the tools need from the plugin. */
export interface ToolHooks {
  /** A session became bound to a journey: give it the session tools. */
  onBound(sessionId: string): void
}

function safeError(hodos: HodosService, error: unknown): Error {
  if (error instanceof HodosError) {
    const retry = error.details?.retryAfterSec
    return new Error(`${error.code}: ${error.message}${typeof retry === 'number' ? ` (try again in ${retry}s)` : ''}`)
  }
  // Unexpected failures are logged for the operator; the model gets no internals.
  hodos.logger.error(`tool failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  return new Error('INTERNAL: Hodos could not complete this request; details are in the DSH log.')
}

async function asLearner<T>(hodos: HodosService, exec: ToolRunContext, work: (actor: Actor) => T | Promise<T>): Promise<T> {
  const agent = exec.agent
  if (agent === undefined) throw new Error('FORBIDDEN: Hodos tools can only be used from an agent session.')
  try {
    return await work(hodos.agentActor(String(agent.id)))
  } catch (error) {
    throw safeError(hodos, error)
  }
}

function render(_args: unknown, value: { text: string }): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value.text }]
}

const COURSE_FORMAT = `A Hodos course as JSON: { id, version (semver), title, description, keywords[], goal (skill id), environments[] (installed environment ids), skills[] { id, title, kind: fact|concept|procedure|pattern|performance|judgment, requires?[], description?, objectives?[] }, lessons[] { id, skillId, title, source (Markdoc; core blocks: step, callout, worked-example, check) }, items[] { id, kind (installed exercise kind), skills[] { skillId, weight }, difficulty (-4..4), modes[] (practice|checkpoint|review|diagnostic), payload, key, hints?[] { level 1-5, text }, explanation? } }. Skill and item ids are lowercase, e.g. "spanish.greetings". The course is validated (graph, lessons, every item against its exercise kind) and stored as a draft the learner must approve.`

/**
 * The global tools.
 * @param hodos - the Hodos service.
 * @param hooks - plugin callbacks.
 * @returns tool definitions.
 */
export function globalTools(hodos: HodosService, hooks: ToolHooks): ToolDefinition[] {
  return [
    defineTool({
      name: 'hodos_start_learning',
      description: 'Start an adaptive learning journey in Hodos when the user wants to learn or practise a subject (e.g. chess tactics, Spanish). Hodos picks an installed course, may run a short diagnostic, and proposes a path of skills. Pass what the learner says they know as self_report (a weak prior; never treated as mastery).',
      parameters: {
        goal: { type: 'string', required: true, description: 'The learning goal in the learner\'s words.' },
        environment: { type: 'string', description: 'Subject or environment hint, e.g. "chess" or "spanish".' },
        course_id: { type: 'string', description: 'Exact course id from hodos_list_courses, when known.' },
        self_report: {
          type: 'array',
          description: 'What the learner says about their prior knowledge.',
          items: {
            type: 'object',
            properties: {
              skill: { type: 'string', required: true, description: 'Skill named in the learner\'s words, e.g. "knight forks".' },
              level: { type: 'string', enum: ['never', 'heard-of', 'used-it'], required: true },
            },
            additionalProperties: false,
          },
        },
        skip_diagnostic: { type: 'boolean', description: 'Skip the placement diagnostic (start from scratch).' },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.startJourney(actor, {
          goal: args.goal,
          ...(args.environment === undefined ? {} : { environment: args.environment }),
          ...(args.course_id === undefined ? {} : { courseId: args.course_id }),
          ...(args.self_report === undefined ? {} : { selfReport: args.self_report.map(r => ({ skill: r.skill, level: r.level })) }),
          ...(args.skip_diagnostic === undefined ? {} : { skipDiagnostic: args.skip_diagnostic }),
        })
        if (actor.sessionId !== undefined) hooks.onBound(actor.sessionId)
        return { text: `Started.\n${describeJourney(view)}`, ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_resume_learning',
      description: 'Resume the learner\'s most recent Hodos learning journey in this session (after a restart or in a new session).',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.resume(actor)
        if (view === null) return { text: 'No learning journey yet. Use hodos_start_learning with the learner\'s goal.' }
        if (actor.sessionId !== undefined) hooks.onBound(actor.sessionId)
        return { text: `Resumed.\n${describeJourney(view)}`, ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_list_courses',
      description: 'List the Hodos courses installed and approved on this machine, with whether their environment is available.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, () => {
        const catalog = hodos.engine.catalog()
        if (catalog.length === 0) return { text: 'No courses are installed. Install a Hodos environment (for example @hodos/chess) or propose a course with hodos_propose_course.' }
        return {
          text: catalog.map(c => `- ${c.title} [${c.id}@${c.version}]${c.available ? '' : ' (environment not installed)'}: ${c.description} Skills: ${c.skills.map(s => s.title).join(', ')}.`).join('\n'),
        }
      }),
    }),
    defineTool({
      name: 'hodos_propose_course',
      description: `Propose a new course when no installed course fits the learner's goal. ${COURSE_FORMAT}`,
      parameters: {
        course: { type: 'json', required: true, description: 'The course JSON.' },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, async actor => {
        const result = await hodos.engine.proposeCourse(actor, args.course)
        if (!result.stored) return { text: `The course was not stored. Fix these problems and propose it again:\n${result.errors.map(e => `- ${e}`).join('\n')}`, ref: result.courseId }
        return {
          text: [
            `Stored as a draft: ${result.courseId}@${result.version}. The learner reviews and approves it in the Hodos workspace before it can be used; it is not independently verified.`,
            ...result.warnings.map(w => `Warning: ${w}`),
          ].join('\n'),
          ref: result.courseId,
        }
      }),
    }),
  ]
}

/**
 * The tools of a session bound to a journey.
 * @param hodos - the Hodos service.
 * @returns tool definitions.
 */
export function sessionTools(hodos: HodosService): ToolDefinition[] {
  const presentation = { type: 'string', required: true, description: 'The exercise id shown by hodos_next_exercise.' } as const
  return [
    defineTool({
      name: 'hodos_status',
      description: 'Show the learning journey: phase, path, progress, the open exercise and what to do next.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.journey(actor)
        return { text: `${describeJourney(view)}\n\n${hodos.engine.tutorContext(actor).text}`, ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_lesson',
      description: 'Read the lesson for the active skill (or another skill of the journey) as text, with its formative check questions.',
      parameters: { skill_id: { type: 'string', description: 'Skill id; defaults to the active skill.' } },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.lesson(actor, args.skill_id === undefined ? {} : { skillId: args.skill_id })
        return { text: describeLesson(view), ref: view.skillId }
      }),
    }),
    defineTool({
      name: 'hodos_answer_check',
      description: 'Record the learner\'s answer to a formative lesson check (by option id) and get the explanation.',
      parameters: {
        lesson_id: { type: 'string', required: true },
        check_id: { type: 'string', required: true },
        option_id: { type: 'string', required: true },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, actor => {
        const result = hodos.engine.answerCheck(actor, { lessonId: args.lesson_id, checkId: args.check_id, optionId: args.option_id })
        return { text: `${result.correct ? 'Correct' : 'Not correct'}.${result.explanation === undefined ? '' : ` ${result.explanation}`}`, ref: result.checkId }
      }),
    }),
    defineTool({
      name: 'hodos_complete_lesson',
      description: 'Mark the current lesson (or remedial step) complete and move on to practice.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.completeLesson(actor)
        return { text: describeJourney(view), ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_next_exercise',
      description: 'Show the learner\'s current exercise (presenting the next one if none is open). The learner answers on the board or form in the workspace.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.nextExercise(actor)
        if (view === null) return { text: describeNext(hodos.engine.journey(actor).nextAction) }
        return { text: describeExercise(view), ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_submit_answer',
      description: 'Submit an answer the learner gave in chat for a practice or review exercise. Relayed answers count as assisted. Checkpoint and diagnostic answers cannot be relayed.',
      parameters: {
        presentation_id: presentation,
        response: { type: 'json', required: true, description: 'The response in the exercise kind\'s format, e.g. {"move":"Nf7+"} or {"text":"hola"}.' },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, async actor => {
        const view = await hodos.engine.submitAttempt(actor, { presentationId: args.presentation_id, response: args.response })
        return { text: describeAttempt(view), ref: view.presentationId }
      }),
    }),
    defineTool({
      name: 'hodos_hint',
      description: 'Reveal the next hint level for a practice exercise (graded: orient → point → example → partial → answer). Paced: stronger hints need an attempt or a short wait.',
      parameters: { presentation_id: presentation },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.requestHint(actor, args.presentation_id)
        return { text: describeHint(view), ref: view.presentationId }
      }),
    }),
    defineTool({
      name: 'hodos_start_checkpoint',
      description: 'Start the unassisted checkpoint for the active skill: fresh items, one attempt each, no hints. The learner answers in the workspace.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.startCheckpoint(actor)
        return { text: `${describeCheckpoint(view)}\nThe learner now answers ${view.total} item(s) alone in the workspace. Do not help with them.`, ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_start_review',
      description: 'Start a spaced-repetition review of skills that are due.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.startReview(actor)
        return { text: describeJourney(view), ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_progress',
      description: 'Show mastery evidence per skill, reviews due and recent results.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.progress(actor)
        return { text: describeProgress(view), ...(view.journeyId === null ? {} : { ref: view.journeyId }) }
      }),
    }),
    defineTool({
      name: 'hodos_approve_path',
      description: 'Approve the proposed learning path after discussing it with the learner (shipped courses only; agent-proposed courses need the learner\'s approval in the workspace).',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.approvePath(actor)
        return { text: describeJourney(view), ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_skip_diagnostic',
      description: 'Skip the placement diagnostic when the learner prefers to start from the beginning.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => asLearner(hodos, exec, actor => {
        const view = hodos.engine.skipDiagnostic(actor)
        return { text: describeJourney(view), ref: view.id }
      }),
    }),
    defineTool({
      name: 'hodos_write_lesson',
      description: 'Write an extra lesson or remedial explanation for this learner (Markdoc text; blocks: step, callout, worked-example, check, plus installed environment blocks). It is validated and shown in the workspace; it is not independently verified.',
      parameters: {
        title: { type: 'string', required: true },
        source: { type: 'string', required: true, description: 'Markdoc source. No HTML, images or variables.' },
        skill_id: { type: 'string', description: 'Skill id; defaults to the active skill.' },
        kind: { type: 'string', enum: ['lesson', 'remedial'] },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => asLearner(hodos, exec, actor => {
        const result = hodos.engine.addLessonOverlay(actor, {
          title: args.title, source: args.source,
          ...(args.skill_id === undefined ? {} : { skillId: args.skill_id }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        })
        return { text: `Lesson ${result.id} saved.${result.diagnostics.length > 0 ? ` Notes: ${result.diagnostics.join('; ')}` : ''}`, ref: result.id }
      }),
    }),
  ]
}

/** Names of the session tools, for documentation and tests. */
export const SESSION_TOOL_NAMES = [
  'hodos_status', 'hodos_lesson', 'hodos_answer_check', 'hodos_complete_lesson', 'hodos_next_exercise', 'hodos_submit_answer',
  'hodos_hint', 'hodos_start_checkpoint', 'hodos_start_review', 'hodos_progress', 'hodos_approve_path', 'hodos_skip_diagnostic', 'hodos_write_lesson',
] as const
