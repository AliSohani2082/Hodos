/**
 * The tools of Hodos learning and practice sessions. Which tools a session
 * has depends on what it is and where it stands:
 *
 * - probing: `hodos_probe` (choice), `hodos_recall` (own words),
 *   `hodos_probe_exercise` (an installed plugin's exercise), `hodos_probe_done`;
 * - planning and teaching: `hodos_plan`, `hodos_quiz`, `hodos_explain`,
 *   `hodos_exercise` (each tagged with a plan node);
 * - practice: `hodos_problem`, `hodos_conclude`.
 *
 * The probe and teaching tools have different names on purpose: their
 * arguments differ (teaching questions name a plan node), and a shared name
 * invites the model to carry the probe's call shape into teaching.
 *
 * The session is always the one the calling chat is bound to, resolved from
 * `exec.agent`, never from arguments. Question tools end the tutor's turn;
 * the learner answers in the Hodos panel and the graded answer arrives as
 * the next message.
 * @module @hodos/dsh/learn-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HodosError, type AskRequest, type LearnPhase, type QuestionFormType, type QuestionRole } from '@hodos/core'
import type { HodosService } from './service.js'

const OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string', required: true, description: 'What the tutor needs to know.' },
    ref: { type: 'string', description: 'Id of the question, problem or session the result is about.' },
  },
  additionalProperties: false,
} as const

function render(_args: unknown, value: { text: string }): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value.text }]
}

/** Turn any failure into a model-safe error. */
export function safeError(hodos: HodosService, error: unknown): Error {
  if (error instanceof HodosError) {
    const retry = error.details?.retryAfterSec
    return new Error(`${error.code}: ${error.message}${typeof retry === 'number' ? ` (try again in ${retry}s)` : ''}`)
  }
  // Unexpected failures are logged for the operator; the model gets no internals.
  hodos.logger.error(`tool failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  return new Error('INTERNAL: Hodos could not complete this request; details are in the DSH log.')
}

function hostSession(exec: ToolRunContext): string {
  const agent = exec.agent
  if (agent === undefined) throw new Error('FORBIDDEN: Hodos tools can only be used from an agent session.')
  return String(agent.id)
}

async function inLearning<T>(hodos: HodosService, exec: ToolRunContext, work: (sessionId: string) => T | Promise<T>): Promise<T> {
  const host = hostSession(exec)
  try {
    const session = hodos.learn.sessionForHost(host)
    if (session === undefined) throw new HodosError('INVALID_STATE', 'this chat is not a Hodos learning session')
    return await work(session.id)
  } catch (error) {
    throw safeError(hodos, error)
  }
}

async function inPractice<T>(hodos: HodosService, exec: ToolRunContext, work: (sessionId: string) => T | Promise<T>): Promise<T> {
  const host = hostSession(exec)
  try {
    const session = hodos.practice.sessionForHost(host)
    if (session === undefined) throw new HodosError('INVALID_STATE', 'this chat is not a Hodos practice session')
    return await work(session.id)
  } catch (error) {
    throw safeError(hodos, error)
  }
}

const SHOWN = 'It is shown to the learner in the Hodos panel. End your turn now: their answer, graded by Hodos, arrives as the next message.'

/** Ask a question and end the turn; a phase change re-registers the tools. */
async function ask(hodos: HodosService, exec: ToolRunContext, form: QuestionFormType, role: QuestionRole, args: { nodeId?: string; question: string; details?: string }, input: Record<string, unknown>): Promise<{ text: string; ref: string }> {
  return inLearning(hodos, exec, async sessionId => {
    const before = hodos.learn.sessionForHost(hostSession(exec))?.phase
    const request: AskRequest = {
      form, role, prompt: args.question, input,
      ...(args.nodeId === undefined ? {} : { nodeId: args.nodeId }),
      ...(args.details === undefined ? {} : { details: args.details }),
    }
    const q = await hodos.learn.ask(sessionId, request)
    exec.concludeTurn()
    const after = hodos.learn.sessionForHost(hostSession(exec))?.phase
    if (before !== after) hodos.notifyChanged(hostSession(exec))
    return { text: `Question ${q.id} asked${after === 'teach' && before === 'plan' ? '; teaching has started' : ''}. ${SHOWN}`, ref: q.id }
  })
}

const QUESTION = { type: 'string', required: true, description: 'The question as the learner sees it. Markdown; LaTeX between $…$ or $$…$$ (escape backslashes in JSON).' } as const
const DETAILS = { type: 'string', description: 'Optional context shown under the question.' } as const
const OPTIONS = {
  type: 'json',
  required: true,
  description: 'The options: 2 to 8, each a string or { "label": "…", "value": "a" }. Values are short stable tokens; when absent they are derived from the labels. Hodos shuffles the order shown, and adds "I don\'t know".',
} as const
const CORRECT = { type: 'json', required: true, description: 'The correct option value (or exact label), or a list of them when multi is true. Commit it before asking.' } as const
const EXPLANATION = { type: 'string', description: 'Shown after the learner answers.' } as const
const COMMITTED = { type: 'string', required: true, description: 'Your full correct answer in your own words, reasoning included, committed before the learner sees the question. Shown to the learner after they answer.' } as const
const ROLE = {
  type: 'string', enum: ['predict', 'check', 'review'], required: true,
  description: 'predict: before teaching a step, the learner commits to what they expect; check: after teaching it, one reasoning step at a time; review: revisiting a node taught earlier.',
} as const
const NODE = { type: 'string', required: true, description: 'The id of the plan node this question is about, copied exactly from your plan.' } as const
const EXERCISE = {
  bank: { type: 'string', description: 'A verified exercise from a question bank, by its reference from hodos_bank (for example "chess-tactics/fork-3"). Give either bank, or kind + payload + key.' },
  kind: { type: 'string', description: 'One of the installed kinds listed above.' },
  payload: { type: 'json', description: 'What the learner sees, in the kind\'s format.' },
  key: { type: 'json', description: 'The answer key, in the kind\'s format. Never shown before the answer.' },
  explanation: EXPLANATION,
} as const

/** The tool's exercise fields as untrusted input for the learning service. */
function exerciseInput(args: { bank?: string; kind?: string; payload?: unknown; key?: unknown; explanation?: string }): Record<string, unknown> {
  return args.bank !== undefined && args.bank.trim() !== ''
    ? { bank: args.bank }
    : { kind: args.kind, payload: args.payload, key: args.key, explanation: args.explanation }
}

/** The question-bank listing, offered in every phase when banks exist. */
function bankTool(hodos: HodosService): ToolDefinition {
  return defineTool({
    name: 'hodos_bank',
    description: 'Search the question banks: exercises from installed courses, checked when the course was made (for example chess positions verified with chess.js). Each entry shows what the learner would see, never the answer. Ask one with the exercise tool\'s `bank` field.',
    parameters: { query: { type: 'string', description: 'Words to look for (a topic, a skill, a kind); empty lists some of everything.' } },
    output: { schema: OUTPUT, render },
    execute: (args, exec) => inLearning(hodos, exec, () => {
      const entries = hodos.learn.bankEntries(args.query ?? '', 15)
      if (entries.length === 0) return { text: 'No bank exercises match. Write your own question instead.' }
      return { text: entries.map(e => `- ${e.ref} (${e.kind}; ${e.course}: ${e.skill}${e.verifiedBy.length > 0 ? `; verified by ${e.verifiedBy.join(', ')}` : ''}): ${e.text}`).join('\n') }
    }),
  })
}

function exerciseDescription(hodos: HodosService, teach: boolean): string {
  const kinds = [...hodos.learn.interfaceKinds().entries()].map(([id, k]) => {
    const spec = hodos.registry.kind(id)?.spec
    const example = spec?.guidance?.example === undefined ? '' : ` Example payload ${JSON.stringify(spec.guidance.example.payload)}, key ${JSON.stringify(spec.guidance.example.key)}.`
    const rules = spec?.guidance?.rules === undefined ? '' : ` Rules: ${spec.guidance.rules.join(' ')}`
    return `- ${id} (${k.title}): ${spec?.guidance?.when ?? ''}${rules}${example}`
  })
  return [
    `Ask the learner an exercise in an installed environment instead of a multiple-choice question: the environment shows it (a board, an editor, an expression field), validates it before the learner sees it, and grades the answer. ${teach ? 'Tag it with the plan node and role like hodos_quiz.' : 'This is a probe question: no plan node.'} The key stays hidden from the learner until they answer. Write it yourself (kind + payload + key), or ask a verified one from the question banks by reference (bank; see hodos_bank).`,
    'Installed kinds:',
    ...kinds,
    'ONE question per turn: the call ends your turn.',
  ].join('\n')
}

/**
 * The tools of a learning session in a phase.
 * @param hodos - the Hodos service.
 * @param phase - the session's phase.
 * @returns tool definitions.
 */
export function learningTools(hodos: HodosService, phase: LearnPhase): ToolDefinition[] {
  const hasKinds = hodos.learn.interfaceKinds().size > 0
  // Offered with the interfaces (installed plugins ship their courses); it says so when nothing matches.
  const banks = hasKinds ? [bankTool(hodos)] : []
  if (phase === 'closed') return []
  if (phase === 'probe') {
    return [
      defineTool({
        name: 'hodos_probe',
        description: 'Ask the learner a graded multiple-choice question while probing what they understand. Commit the correct answer before asking; Hodos grades the choice and reports it back. Probe questions are not about plan nodes. ONE question per turn: the call ends your turn.',
        parameters: { question: QUESTION, details: DETAILS, options: OPTIONS, correct: CORRECT, multi: { type: 'boolean', description: 'Several options are correct.' }, explanation: EXPLANATION },
        output: { schema: OUTPUT, render },
        execute: (args, exec) => ask(hodos, exec, 'choice', 'probe', args, { options: args.options, correct: args.correct, multi: args.multi, explanation: args.explanation }),
      }),
      defineTool({
        name: 'hodos_recall',
        description: 'Ask the learner to explain something in their own words while probing. Commit your full correct answer first; when their answer returns, judge it strictly against your commitment and never revise it to fit their words. ONE question per turn: the call ends your turn.',
        parameters: { question: QUESTION, details: DETAILS, answer: COMMITTED },
        output: { schema: OUTPUT, render },
        execute: (args, exec) => ask(hodos, exec, 'explain', 'probe', args, { answer: args.answer }),
      }),
      ...(hasKinds ? [defineTool({
        name: 'hodos_probe_exercise',
        description: exerciseDescription(hodos, false),
        parameters: { question: QUESTION, details: DETAILS, ...EXERCISE },
        output: { schema: OUTPUT, render },
        execute: (args, exec) => ask(hodos, exec, 'interface', 'probe', args, exerciseInput(args)),
      })] : []),
      ...banks,
      defineTool({
        name: 'hodos_probe_done',
        description: 'Conclude the probe with your assessment of the learner: every dependency strand the goal rests on, with where their understanding ends on it. The assessment is shown to the learner, and the session moves on to planning. Call it once, when no question is waiting.',
        parameters: {
          assessment: {
            type: 'json', required: true,
            description: '{ "strands": [{ "strand": "the derivative as a limit", "assessment": "what they reliably get right, where it runs out, misconceptions found, what to build from" }], "summary": "optional: their apparent goal and where teaching should start" }',
          },
        },
        output: { schema: OUTPUT, render },
        execute: (args, exec) => inLearning(hodos, exec, sessionId => {
          const assessment = hodos.learn.concludeProbe(sessionId, args.assessment)
          hodos.notifyChanged(hostSession(exec))
          return { text: `Assessment recorded (${assessment.strands.length} strands) and shown to the learner. The probe is over: write the plan map with hodos_plan next.`, ref: sessionId }
        }),
      }),
    ]
  }
  return [
    defineTool({
      name: 'hodos_plan',
      description: 'Write (or rewrite) the plan map: the dependencies from what the learner understands now to their goal, as a small mermaid graph. It is checked to be a DAG and shown live to the learner; where the lesson stands is derived from the plan node your questions are about. Syntax: `graph TD`, then `id[Title] --> other[Title]` lines; ids are lowercase slugs such as chain-rule; at most 30 nodes; no subgraphs or styling.',
      parameters: { mermaid: { type: 'string', required: true, description: 'The plan map.' } },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => inLearning(hodos, exec, sessionId => {
        const view = hodos.learn.setPlan(sessionId, args.mermaid)
        hodos.notifyChanged(hostSession(exec))
        return { text: `Plan version ${view.version} saved and shown to the learner: ${view.nodes.length} nodes (${view.nodes.map(n => n.id).join(', ')}). Present it in a sentence or two and end your turn; the learner may ask for changes.`, ref: sessionId }
      }),
    }),
    defineTool({
      name: 'hodos_quiz',
      description: 'Ask the learner a graded multiple-choice question about a plan node. Commit the correct answer (and an explanation) before asking; Hodos grades the choice, shows the reveal, and reports the result to you. ONE question per turn: the call ends your turn.',
      parameters: { role: ROLE, nodeId: NODE, question: QUESTION, details: DETAILS, options: OPTIONS, correct: CORRECT, multi: { type: 'boolean', description: 'Several options are correct.' }, explanation: EXPLANATION },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => ask(hodos, exec, 'choice', args.role, args, { options: args.options, correct: args.correct, multi: args.multi, explanation: args.explanation }),
    }),
    defineTool({
      name: 'hodos_explain',
      description: 'Ask the learner to explain something about a plan node in their own words. Commit your full correct answer first; when their answer returns, judge it strictly against your commitment and never revise it to fit their words. ONE question per turn: the call ends your turn.',
      parameters: { role: ROLE, nodeId: NODE, question: QUESTION, details: DETAILS, answer: COMMITTED },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => ask(hodos, exec, 'explain', args.role, args, { answer: args.answer }),
    }),
    ...(hasKinds ? [defineTool({
      name: 'hodos_exercise',
      description: exerciseDescription(hodos, true),
      parameters: { role: ROLE, nodeId: NODE, question: QUESTION, details: DETAILS, ...EXERCISE },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => ask(hodos, exec, 'interface', args.role, args, exerciseInput(args)),
    })] : []),
    ...banks,
  ]
}

/**
 * The tools of a practice session.
 * @param hodos - the Hodos service.
 * @returns tool definitions.
 */
export function practiceTools(hodos: HodosService): ToolDefinition[] {
  return [
    defineTool({
      name: 'hodos_problem',
      description: 'Pose one practice problem. Solve it yourself first: modelSolution is your full solution, moves in order, committed before the learner sees the problem and shown to them only when you conclude. The learner works in a thinking field; each submission arrives as a "Your thinking" message. Only one problem may be active. The call ends your turn.',
      parameters: {
        statement: { type: 'string', required: true, description: 'The problem as the learner sees it (Markdown, LaTeX). Self-contained; never announces the proposition it exercises.' },
        mode: { type: 'string', enum: ['recall', 'discrimination', 'composition'], required: true, description: 'recall: one or two decision points in a fresh situation; discrimination: the right proposition against a live confusable; composition: a chain run as a whole.' },
        target: { type: 'array', items: { type: 'string' }, description: 'Proposition ids from the session context that the problem exercises; leave out when practising a free topic.' },
        modelSolution: { type: 'string', required: true, description: 'Your full solution, committed now.' },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => inPractice(hodos, exec, sessionId => {
        const problem = hodos.practice.pose(sessionId, { statement: args.statement, mode: args.mode, modelSolution: args.modelSolution, ...(args.target === undefined ? {} : { target: args.target }) })
        exec.concludeTurn()
        return { text: `Problem ${problem.id} posed and shown to the learner. End your turn; their thinking arrives as the next message.`, ref: problem.id }
      }),
    }),
    defineTool({
      name: 'hodos_conclude',
      description: 'Conclude the active problem: records the outcome and your verdict, and shows the learner your committed solution. Then say your closing words and end your turn; pose the next problem only when the learner asks for it.',
      parameters: {
        outcome: { type: 'string', enum: ['solved', 'solvedWithHints', 'movedOn', 'surrendered'], required: true },
        verdict: { type: 'string', required: true, description: 'What was credited and where it broke. On a wrong answer, localize the break without giving the correction.' },
        rung: { type: 'string', enum: ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'none'], required: true, description: 'The highest hint rung the problem needed, or none.' },
        missClass: { type: 'string', enum: ['cue', 'discrimination', 'execution', 'careless', 'structural', 'none'], required: true },
        retest: { type: 'boolean', required: true, description: 'Mark the problem for a fresh-surface retest later in the session.' },
      },
      output: { schema: OUTPUT, render },
      execute: (args, exec) => inPractice(hodos, exec, sessionId => {
        const problem = hodos.practice.conclude(sessionId, { ...args, rung: args.rung === 'none' ? null : args.rung, missClass: args.missClass === 'none' ? null : args.missClass })
        return { text: `Problem ${problem.id} concluded (${args.outcome}); the learner now sees your solution.`, ref: problem.id }
      }),
    }),
  ]
}
