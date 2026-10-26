/**
 * Optional course drafting through DSH's subagent abstraction. Mounted only
 * when the `subagents` service exists. A delegation costs one unit of a small
 * per-learner daily budget, the subagent gets no Hodos tools, and its output
 * goes through the same validation as any proposed course and stays a draft
 * until the learner approves it.
 * @module @hodos/dsh/delegate
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { HodosService } from './service.js'

/**
 * Prompt for the drafting subagent.
 * @param topic - the learning goal.
 * @param guide - the authoring guide for the installed environments.
 * @param notes - what the learner already knows or wants to focus on.
 */
export function draftingPrompt(topic: string, guide: string, notes: string): string {
  return [
    `Draft a Hodos course for this learning goal: ${topic}`,
    notes === '' ? '' : `Learner notes: ${notes}`,
    'Follow the authoring guide below. Use only the environments and exercise kinds it lists, check every answer key carefully, and do not claim the material was verified.',
    'Answer with exactly one JSON object (the course, version "0.1.0") in a ```json code block and nothing else.',
    guide,
  ].filter(Boolean).join('\n\n')
}

/**
 * Pull the first JSON object out of a model answer (fenced or bare).
 * @param text - the answer text.
 * @returns the parsed value, or undefined.
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (candidate.trim() === '') return undefined
  try {
    return JSON.parse(candidate)
  } catch (_invalid) {
    // Not JSON: the caller reports that no course came back.
    return undefined
  }
}

/** The subset of DSH's subagent service this tool uses. */
export interface SubagentRuntime {
  list(): string[]
  startActivation(spec: Parameters<Context['subagents']['startActivation']>[0]): ReturnType<Context['subagents']['startActivation']>
}

/**
 * The `hodos_draft_course` tool.
 * @param hodos - the Hodos service.
 * @param subagents - DSH's subagent service.
 * @returns the tool (it reports when no provider is registered).
 */
export function draftCourseTool(hodos: HodosService, subagents: SubagentRuntime): ToolDefinition {
  return defineTool({
    name: 'hodos_draft_course',
    description: 'Ask a subagent to research and draft a Hodos course when no installed course fits the goal. Uses one of a few delegations per day; the draft is validated and needs the learner\'s approval in the workspace.',
    parameters: {
      topic: { type: 'string', required: true, description: 'The learning goal to cover.' },
      notes: { type: 'string', description: 'What the learner already knows or wants to focus on.' },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string', required: true }, ref: { type: 'string' } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('FORBIDDEN: Hodos tools can only be used from an agent session.')
      const actor = hodos.agentActor(String(agent.id))
      try {
        hodos.engine.chargeDelegation(actor.learnerId)
      } catch (error) {
        throw new Error(`RATE_LIMITED: ${error instanceof Error ? error.message : 'delegation budget spent'}`)
      }
      const provider = hodos.config.delegateProvider !== '' ? hodos.config.delegateProvider : subagents.list()[0]
      if (provider === undefined) return { text: 'No subagent provider is configured in this harness; propose the course yourself with hodos_propose_course.' }
      const activation = await subagents.startActivation({
        provider,
        label: 'Hodos course draft',
        signal: exec.signal,
        delivery: 'caller',
        request: {
          prompt: [{ type: 'text', text: draftingPrompt(args.topic, hodos.engine.authoringGuide(), args.notes ?? '') }],
          parent: agent,
        },
      })
      try {
        const result = await activation.result
        const text = result.output.map(block => (block.type === 'text' ? block.text : '')).join('\n')
        const course = result.structured ?? extractJson(text)
        if (course === undefined) return { text: `The subagent did not return a course (${result.stopReason}).` }
        const stored = await hodos.engine.proposeCourse(actor, course)
        if (!stored.stored) return { text: `The drafted course did not validate:\n${stored.errors.map(e => `- ${e}`).join('\n')}`, ref: stored.courseId }
        return { text: `Draft ${stored.courseId}@${stored.version} is ready for the learner to review and approve in the Hodos workspace. It was written by a model and is not independently verified.`, ref: stored.courseId }
      } finally {
        await activation.dispose().catch((error: unknown) => hodos.logger.warn(`subagent cleanup failed: ${error instanceof Error ? error.message : String(error)}`))
      }
    },
  })
}
