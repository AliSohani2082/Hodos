/**
 * The global Hodos tools, offered in every chat: start a learning or
 * practice session in this chat, and list or propose courses (installed
 * courses serve as question banks). The tools of a session itself are in
 * `learn-tools.ts`.
 *
 * Identity comes from the calling chat (`exec.agent`), never from arguments.
 * @module @hodos/dsh/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HodosError, resolveProposition, type LearnerId } from '@hodos/core'
import { safeError } from './learn-tools.js'
import type { HodosService } from './service.js'

/** Tools every chat sees. */
export const GLOBAL_TOOL_NAMES = ['hodos_start_learning', 'hodos_start_practice', 'hodos_list_courses', 'hodos_propose_course'] as const

const OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', required: true, description: 'What the tutor needs to know.' },
    ref: { type: 'string', description: 'Id of the session or course the result is about.' },
  },
  additionalProperties: false,
} as const

function render(_args: unknown, value: { text: string }): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value.text }]
}

async function inChat<T>(hodos: HodosService, exec: ToolRunContext, work: (chatId: string, learnerId: LearnerId) => T | Promise<T>): Promise<T> {
  const agent = exec.agent
  if (agent === undefined) throw new Error('FORBIDDEN: Hodos tools can only be used from an agent session.')
  try {
    return await work(String(agent.id), hodos.ownerLearner())
  } catch (error) {
    throw safeError(hodos, error)
  }
}

const COURSE_FORMAT = `A Hodos course as JSON: { id, version (semver), title, description, keywords[], goal (skill id), environments[] (installed environment ids), skills[] { id, title, kind: fact|concept|procedure|pattern|performance|judgment, requires?[], description?, objectives?[] }, lessons[] { id, skillId, title, source (Markdoc; core blocks: step, callout, worked-example, check) }, items[] { id, kind (installed exercise kind), skills[] { skillId, weight }, difficulty (-4..4), modes[] (practice|checkpoint|review|diagnostic), payload, key, hints?[] { level 1-5, text }, explanation? } }. Skill and item ids are lowercase, e.g. "spanish.greetings". The course is validated (graph, lessons, every item against its exercise kind) and stored as a draft the learner must approve; approved courses serve as question banks.`

/**
 * The global tools.
 * @param hodos - the Hodos service.
 * @returns tool definitions.
 */
export function globalTools(hodos: HodosService): ToolDefinition[] {
  return [
    defineTool({
      name: 'hodos_start_learning',
      description: 'Turn this chat into a Hodos learning session when the user wants to learn or understand something (any topic). You then probe what they already understand with graded questions, write a plan map from there to their goal, and teach it step by step with questions shown in the Hodos panel. Call it once, with the goal in the learner\'s words.',
      parameters: { goal: { type: 'string', required: true, description: 'What the learner wants to learn, in their words.' } },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => inChat(hodos, exec, (chatId, learnerId) => {
        const binding = hodos.binding(chatId)
        if (binding !== null) throw new HodosError('CONFLICT', binding.kind === 'learn' ? 'this chat is already a learning session' : 'this chat is a practice session; start learning in a new chat')
        const session = hodos.learn.start(learnerId, args.goal, chatId)
        hodos.notifyChanged(chatId)
        return { text: `Learning session started for "${session.goal}". You are now the prober: find where the learner's understanding ends on each strand the goal depends on, with hodos_probe / hodos_recall questions, then conclude with hodos_probe_done. Tell the learner their questions appear in the Hodos panel (right sidebar).`, ref: session.id }
      }),
    }),
    defineTool({
      name: 'hodos_start_practice',
      description: 'Turn this chat into a Hodos practice session: you pose one problem at a time and the learner works it in the Hodos panel. Optionally name propositions from the learner\'s knowledge graph (by name) to practise; otherwise give a topic.',
      parameters: {
        topic: { type: 'string', required: true, description: 'What to practise, in the learner\'s words.' },
        propositions: { type: 'array', items: { type: 'string' }, description: 'Names of propositions from the knowledge graph to practise.' },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => inChat(hodos, exec, (chatId, learnerId) => {
        if (hodos.binding(chatId) !== null) throw new HodosError('CONFLICT', 'this chat is already a Hodos session; practise in a new chat')
        const graph = hodos.graph.propositions(learnerId)
        const targets: string[] = []
        const unknown: string[] = []
        for (const name of args.propositions ?? []) {
          const id = resolveProposition(name, graph)
          if (id === null) unknown.push(name)
          else targets.push(id)
        }
        const session = hodos.practice.start(learnerId, { targets, title: args.topic, hostSessionId: chatId })
        hodos.notifyChanged(chatId)
        return { text: `Practice session "${session.title}" started with ${targets.length} picked proposition(s).${unknown.length > 0 ? ` Not in the graph: ${unknown.join(', ')}.` : ''} Pose the first problem with hodos_problem.`, ref: session.id }
      }),
    }),
    defineTool({
      name: 'hodos_list_courses',
      description: 'List the Hodos courses installed and approved on this machine. Their exercises serve as verified question banks.',
      parameters: {},
      output: { schema: OUTPUT, render },
      execute: (_args, exec) => inChat(hodos, exec, () => {
        const catalog = hodos.engine.catalog()
        if (catalog.length === 0) return { text: 'No courses are installed.' }
        return { text: catalog.map(c => `- ${c.title} [${c.id}@${c.version}]${c.available ? '' : ' (environment not installed)'}: ${c.description}`).join('\n') }
      }),
    }),
    defineTool({
      name: 'hodos_propose_course',
      description: `Propose a course (a verified question bank) for the learner to approve. ${COURSE_FORMAT}`,
      parameters: { course: { type: 'json', required: true, description: 'The course JSON.' } },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => inChat(hodos, exec, async chatId => {
        const result = await hodos.engine.proposeCourse(hodos.agentActor(chatId), args.course)
        if (!result.stored) return { text: `The course was not stored. Fix these problems and propose it again:\n${result.errors.map(e => `- ${e}`).join('\n')}`, ref: result.courseId }
        return {
          text: [`Stored as a draft: ${result.courseId}@${result.version}. The learner reviews and approves it in the Hodos panel; it is not independently verified.`, ...result.warnings.map(w => `Warning: ${w}`)].join('\n'),
          ref: result.courseId,
        }
      }),
    }),
  ]
}
