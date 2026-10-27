/**
 * The Hodos DSH plugin on a real Cordis root context with fake DSH services
 * (tools, agents, system prompt, web server, connection). The real-host
 * journey runs in `e2e/` against an installed DeepSeek Harness.
 */
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ModelPort, ModelRequest } from '@hodos/core'
import { createCodePlugin } from '@hodos/code'
import { createQuizPlugin, quizCourse } from '@hodos/testing'
import * as plugin from '../src/index.js'
import { GLOBAL_TOOL_NAMES, RENDERER_CSP, RUN_CODE_RENDERER_CSP } from '../src/index.js'
import type { HodosService } from '../src/service.js'

/** What a DSH tool guard sees of a call (the part these tests use). */
type FakeGuard = (execution: { readonly name: string }) => string | undefined

interface FakeAgent {
  readonly id: string
  readonly scoped: Map<string, ToolDefinition>
  readonly restrictions: Array<{ allow?: readonly string[] }>
  readonly guards: FakeGuard[]
  readonly injected: unknown[]
  readonly followups: unknown[]
  readonly ctx: {
    tools: {
      register(def: ToolDefinition): () => void
      restrict(filter: { allow?: readonly string[] }): () => void
      guard(guard: FakeGuard): () => void
    }
  }
  inject(message: unknown): void
  followup(message: unknown): void
}

function fakeAgent(id: string): FakeAgent {
  const scoped = new Map<string, ToolDefinition>()
  const restrictions: Array<{ allow?: readonly string[] }> = []
  const guards: FakeGuard[] = []
  const injected: unknown[] = []
  const followups: unknown[] = []
  return {
    id, scoped, restrictions, guards, injected, followups,
    ctx: {
      tools: {
        register(def) { scoped.set(def.name, def); return () => { scoped.delete(def.name) } },
        restrict(filter) { restrictions.push(filter); return () => { restrictions.splice(restrictions.indexOf(filter), 1) } },
        guard(guard) { guards.push(guard); return () => { guards.splice(guards.indexOf(guard), 1) } },
      },
    },
    inject(message) { injected.push(message) },
    followup(message) { followups.push(message) },
  }
}

interface Harness {
  readonly root: Context
  readonly hodos: HodosService
  readonly globals: Map<string, ToolDefinition>
  readonly agents: FakeAgent[]
  readonly contexts: Array<{ name: string; text: string | ((ctx: { agent?: { id: string } }) => string) }>
  readonly sections: Array<{ name: string; text: string }>
  readonly url: string
  close(): Promise<void>
}

const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function harness(config: Record<string, unknown> = {}, services: Record<string, unknown> = {}, options: { environment?: boolean } = {}): Promise<Harness> {
  const root = new Context()
  for (const [name, service] of Object.entries(services)) root.provide(name, service)
  const globals = new Map<string, ToolDefinition>()
  const agents: FakeAgent[] = []
  const contexts: Harness['contexts'] = []
  const sections: Harness['sections'] = []
  let route: ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void) | undefined
  root.provide('tools', { register(def: ToolDefinition) { globals.set(def.name, def); return () => { globals.delete(def.name) } } })
  root.provide('agents', { list: () => agents })
  root.provide('systemPrompt', {
    section(s: { name: string; text: string }) { sections.push(s); return () => {} },
    context(c: Harness['contexts'][number]) { contexts.push(c); return () => {} },
  })
  root.provide('webServer', { register(r: { handler: typeof route }) { route = r.handler; return () => { route = undefined } } })
  root.provide('connection', { requestRejection: (req: { headers: Record<string, unknown> }) => (req.headers.cookie === 'dsh=ok' ? undefined : 401) })
  const fiber = root.plugin(plugin, { dataDir: mkdtempSync(join(tmpdir(), 'hodos-dsh-')), trustedPlugins: ['hodos-quiz'], ...config })
  await fiber
  await waitFor(() => root.get('hodos') !== undefined && globals.has('hodos_start_learning') && route !== undefined && contexts.length > 0, 'the Hodos plugin')
  const hodos: HodosService | undefined = root.get('hodos')
  if (hodos === undefined) throw new Error('the hodos service is not available')
  if (options.environment !== false) await hodos.registerEnvironment(createQuizPlugin())
  const server: Server = createServer((req, res) => { void route?.(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const h: Harness = {
    root, hodos, globals, agents, contexts, sections, url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await fiber.dispose()
    },
  }
  open.push(h)
  return h
}

/** Calls whose turn a tool ended (concludeTurn), by session. */
const concluded: string[] = []

/** Tests drive tool bodies directly; only the fields Hodos reads are populated. */
function exec(sessionId: string | undefined): ToolRunContext {
  const fake = {
    callId: 'call-1', name: 'test', arguments: {}, signal: new AbortController().signal,
    concludeTurn: () => { concluded.push(sessionId ?? '') },
    ...(sessionId === undefined ? {} : { agent: { id: sessionId } }),
  }
  return fake as unknown as ToolRunContext
}

async function call(h: Harness, name: string, args: Record<string, unknown>, sessionId: string | undefined = 'sess-1'): Promise<{ text: string; ref?: string }> {
  const agent = h.agents.find(a => a.id === sessionId)
  const tool = agent?.scoped.get(name) ?? h.globals.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not visible in ${sessionId ?? 'a session-less call'}`)
  const value = await tool.execute(args, exec(sessionId))
  return value as { text: string; ref?: string }
}

/** The text of the tutor context for a session. */
function contextText(h: Harness, sessionId: string): string {
  const context = h.contexts[0]
  return typeof context?.text === 'function' ? context.text({ agent: { id: sessionId } }) : ''
}

/** Text of the follow-up messages an agent received. */
function followupTexts(agent: FakeAgent): string[] {
  return agent.followups.map(m => (m as { content: Array<{ text: string }> }).content[0]?.text ?? '')
}

const PROBE_TOOLS = ['hodos_bank', 'hodos_probe', 'hodos_probe_done', 'hodos_probe_exercise', 'hodos_recall']
const TEACH_TOOLS = ['hodos_bank', 'hodos_exercise', 'hodos_explain', 'hodos_plan', 'hodos_quiz']

/** A chat that has become a learning session in its teaching phase. */
async function teaching(h: Harness, agent: FakeAgent): Promise<void> {
  await call(h, 'hodos_start_learning', { goal: 'Understand the chain rule' }, agent.id)
  await call(h, 'hodos_probe_done', { assessment: { strands: [{ strand: 'derivatives', assessment: 'knows the power rule' }] } }, agent.id)
  await call(h, 'hodos_plan', { mermaid: 'graph TD\n  power[Power rule] --> chain[Chain rule]' }, agent.id)
}

/** The open question of a chat's learning session, as the workspace sees it. */
async function openQuestion(h: Harness, sessionId: string): Promise<{ id: string; form: { type: string; options?: Array<{ value: string; label: string }> } }> {
  const state = dataOf(await api(h, 'GET', 'state', undefined, { session: sessionId })) as { learn: { openQuestion: { id: string; form: { type: string; options?: Array<{ value: string; label: string }> } } | null } | null }
  const q = state.learn?.openQuestion
  if (q === null || q === undefined) throw new Error('no open question')
  return q
}

/** A session event carrying an assistant message with reasoning and text. */
function assistant(text: string): unknown {
  return { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { id: 'm', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'secret reasoning' }, { type: 'text', text }] } } }
}

/** A model that answers background calls from a queue. */
function fakeModel(replies: string[]): ModelPort & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    complete: req => {
      requests.push(req)
      const next = replies.shift()
      return next === undefined ? Promise.reject(new Error('no scripted reply')) : Promise.resolve({ text: next })
    },
  }
}

/** The sample declarative plugin, which has a renderer. */
const EXAMPLE_PLUGIN = fileURLToPath(new URL('../../../examples/binary-numbers', import.meta.url))

/** GET (or another method) with the path sent exactly as written, as a browser or attacker may send it. */
function rawRequest(url: string, path: string, method = 'GET'): Promise<{ status: number; csp: string | undefined }> {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers: { cookie: 'dsh=ok' } }, res => {
      res.resume()
      res.on('end', () => {
        const csp = res.headers['content-security-policy']
        resolve({ status: res.statusCode ?? 0, csp: typeof csp === 'string' ? csp : undefined })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function api(h: Harness, method: 'GET' | 'POST', path: string, body?: unknown, options: { session?: string; cookie?: string; type?: string } = {}): Promise<{ status: number; json: { data?: unknown; error?: { code: string; message: string } } | null; headers: Headers }> {
  const session = options.session ?? 'sess-1'
  const response = await fetch(`${h.url}/hodos/api/v1/${path}${session === '' ? '' : `?session=${session}`}`, {
    method,
    headers: { cookie: options.cookie ?? 'dsh=ok', ...(method === 'POST' ? { 'content-type': options.type ?? 'application/json' } : {}) },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) } : {}),
  })
  const text = await response.text()
  let json: { data?: unknown; error?: { code: string; message: string } } | null = null
  try {
    json = JSON.parse(text) as typeof json
  } catch {
    json = null
  }
  return { status: response.status, json, headers: response.headers }
}

/** The `data` of a successful API response (fails the test when the body is not JSON). */
function dataOf(response: { json: { data?: unknown } | null }): unknown {
  if (response.json === null) throw new Error('the response body is not JSON')
  return response.json.data
}

interface FakeActivationSpec {
  readonly provider: string
  readonly request: { readonly prompt: ReadonlyArray<{ readonly type: string; readonly text: string }> }
}

describe('Hodos DSH plugin', () => {
  it('security: drafts a course through the configured subagent provider, and never offers drafting in a Hodos session', async () => {
    const requests: FakeActivationSpec[] = []
    const drafted = { ...quizCourse(), id: 'quiz-drafted', version: '0.1.0', items: quizCourse().items.map(i => ({ ...i, provenance: { source: 'authored', verifiedBy: ['human'] } })) }
    const subagents = {
      list: () => ['codex', 'claude-code'],
      startActivation: (spec: FakeActivationSpec) => {
        requests.push(spec)
        return Promise.resolve({
          result: Promise.resolve({ output: [{ type: 'text', text: `Here it is.\n\`\`\`json\n${JSON.stringify(drafted)}\n\`\`\`` }], stopReason: 'end_turn' }),
          dispose: () => Promise.resolve(),
        })
      },
    }
    const h = await harness({ delegateProvider: 'claude-code' }, { subagents })
    await waitFor(() => h.globals.has('hodos_draft_course'), 'the drafting tool')
    h.agents.push(fakeAgent('sess-1'))
    const result = await call(h, 'hodos_draft_course', { topic: 'arithmetic for beginners' })
    expect(result.text).toContain('Draft quiz-drafted@0.1.0 is ready for the learner to review')
    expect(requests.map(r => r.provider)).toEqual(['claude-code'])
    expect(h.hodos.courses.drafts()).toEqual([expect.objectContaining({ id: 'quiz-drafted', origin: 'agent' })])

    const tutor = fakeAgent('sess-2')
    h.agents.push(tutor)
    await call(h, 'hodos_start_learning', { goal: 'arithmetic' }, 'sess-2')
    expect(tutor.restrictions[0]?.allow).not.toContain('hodos_draft_course')
    expect(tutor.guards.map(guard => guard({ name: 'hodos_draft_course' })).find(reason => reason !== undefined)).toContain('not available in a Hodos session')
  })

  it('registers the global tools, the prompt section and the tutor context', async () => {
    const h = await harness()
    expect([...h.globals.keys()].toSorted()).toEqual([...GLOBAL_TOOL_NAMES].toSorted())
    expect(h.sections.map(s => s.name)).toEqual(['hodos'])
    expect(h.sections[0]?.text).toContain('hodos_start_learning')
    expect(h.contexts.map(c => c.name)).toEqual(['hodos-learner'])
    expect(contextText(h, 'sess-unbound')).toBe('')
  })

  it('security: turns a chat into a restricted learning session and swaps tools by phase', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    const started = await call(h, 'hodos_start_learning', { goal: 'Understand the chain rule' })
    expect(started.text).toContain('You are now the prober')
    expect([...agent.scoped.keys()].toSorted()).toEqual(PROBE_TOOLS)
    expect(agent.restrictions).toEqual([{ allow: expect.arrayContaining([...GLOBAL_TOOL_NAMES, 'ask_user_question']) as unknown as string[] }])
    const refused = (name: string): string | undefined => agent.guards.map(guard => guard({ name })).find(reason => reason !== undefined)
    for (const name of [...PROBE_TOOLS, ...GLOBAL_TOOL_NAMES, 'ask_user_question']) expect(refused(name), name).toBeUndefined()
    for (const name of ['subagent', 'bash', 'web_fetch', 'read_file']) expect(refused(name), name).toContain('not available in a Hodos session')
    expect(contextText(h, 'sess-1')).toContain('## You are probing')
    expect((await call(h, 'hodos_start_learning', { goal: 'again' }).catch((e: unknown) => e)) as Error).toHaveProperty('message', 'CONFLICT: this chat is already a learning session')

    await call(h, 'hodos_probe_done', { assessment: '{"strands": [{"strand": "derivatives", "assessment": "knows the power rule"}]}' })
    expect([...agent.scoped.keys()].toSorted()).toEqual(TEACH_TOOLS)
    expect(agent.guards).toHaveLength(1)
    expect(contextText(h, 'sess-1')).toContain('## You are the teacher')
    expect(contextText(h, 'sess-1')).toContain('- derivatives: knows the power rule')
    const planned = await call(h, 'hodos_plan', { mermaid: 'graph TD\n  power[Power rule] --> chain[Chain rule]' })
    expect(planned.text).toContain('Plan version 1 saved')
    await expect(call(h, 'hodos_plan', { mermaid: 'a --> b\nb --> a' })).rejects.toThrow(/INVALID_INPUT: the plan was not saved: the plan has a cycle/)
  })

  it('teaches without any environment plugin, and offers exercise tools once one is installed', async () => {
    const h = await harness({}, {}, { environment: false })
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await call(h, 'hodos_start_learning', { goal: 'Understand the chain rule' })
    expect([...agent.scoped.keys()].toSorted()).toEqual(['hodos_probe', 'hodos_probe_done', 'hodos_recall'])
    await call(h, 'hodos_probe_done', { assessment: '{"strands": [{"strand": "derivatives", "assessment": "knows the power rule"}]}' })
    expect([...agent.scoped.keys()].toSorted()).toEqual(['hodos_explain', 'hodos_plan', 'hodos_quiz'])
    await call(h, 'hodos_plan', { mermaid: 'graph TD\n  power[Power rule] --> chain[Chain rule]' })
    await call(h, 'hodos_quiz', { role: 'predict', nodeId: 'chain', question: 'What is the derivative of sin(x^2)?', options: ['2x cos(x^2)', 'cos(x^2)'], correct: '2x cos(x^2)' })
    expect(h.hodos.learn.openQuestion(h.hodos.learn.sessionForHost('sess-1')?.id ?? '')?.form.type).toBe('choice')
    // Installing a plugin mid-session offers its interfaces to the open session.
    await h.hodos.registerEnvironment(createQuizPlugin())
    await waitFor(() => agent.scoped.has('hodos_exercise'), 'the exercise tool')
    expect([...agent.scoped.keys()].toSorted()).toEqual(TEACH_TOOLS)
  })

  it('lists the session\'s plan nodes due for review in the tutor\'s context', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await teaching(h, agent)
    await call(h, 'hodos_quiz', { role: 'check', nodeId: 'chain', question: 'Derivative of sin(x^2)?', options: ['2x cos(x^2)', 'cos(x^2)'], correct: '2x cos(x^2)' })
    const pending = await openQuestion(h, 'sess-1')
    const right = pending.form.options?.find(o => o.label === '2x cos(x^2)')?.value
    await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { selected: [right] } })
    expect(contextText(h, 'sess-1')).not.toContain('Due for review')
    const sessionId = h.hodos.learn.sessionForHost('sess-1')?.id ?? ''
    const state = h.hodos.learnRepo.nodeState(sessionId, 'chain')
    if (state === undefined) throw new Error('the check did not update the node')
    h.hodos.learnRepo.saveNodeState({ ...state, dueAt: '2000-01-01T00:00:00.000Z' })
    expect(contextText(h, 'sess-1')).toContain('Due for review (ask a review question on these when it fits): chain (Chain rule)')
  })

  it('asks questions that end the turn, grades the answer on the server and sends it back as the next turn', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await teaching(h, agent)
    concluded.length = 0
    const asked = await call(h, 'hodos_quiz', { role: 'check', nodeId: 'chain', question: 'd/dx sin(3x)?', options: ['3cos(3x)', 'cos(3x)', '3sin(3x)'], correct: '3cos(3x)', explanation: 'Outer derivative times inner derivative.' })
    expect(asked.text).toContain('End your turn now')
    expect(concluded).toEqual(['sess-1'])
    expect(contextText(h, 'sess-1')).toContain('Waiting for the learner\'s answer to: check on chain')

    const pending = await openQuestion(h, 'sess-1')
    const state = await api(h, 'GET', 'state', undefined, { session: 'sess-1' })
    expect(JSON.stringify(state.json)).not.toMatch(/Outer derivative|"correct"/)
    const wrong = pending.form.options?.find(o => o.label === 'cos(3x)')?.value
    const answered = await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { selected: [wrong] }, thinking: 'chain rule means differentiate the outside' }, { session: 'sess-1' })
    expect(dataOf(answered)).toMatchObject({ status: 'answered', question: { answer: { verdict: { outcome: 'incorrect' }, reveal: { correct: ['3cos-3x'], explanation: 'Outer derivative times inner derivative.' } } } })
    const [report] = followupTexts(agent)
    expect(report).toContain(`[Hodos] Answer to question ${pending.id} (check on chain)`)
    expect(report).toContain('The learner answered "cos(3x)". Incorrect.')
    expect(report).toContain('Their thinking out loud: «chain rule means differentiate the outside»')
    expect((await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { selected: [wrong] } }, { session: 'sess-1' })).json?.error?.code).toBe('INVALID_STATE')
  })

  it('validates exercise questions with their plugin before the learner sees them', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await teaching(h, agent)
    const payload = { prompt: 'Pick the chain rule', options: [{ id: 'a', text: "f'(g(x))g'(x)" }, { id: 'b', text: "f'(x)g'(x)" }], authorNote: 'b is the product mistake' }
    await expect(call(h, 'hodos_exercise', { role: 'check', nodeId: 'chain', question: 'Which?', kind: 'quiz.choice', payload, key: { correct: 'z' } })).rejects.toThrow(/quiz\/key: the correct option is not one of the options/)
    await call(h, 'hodos_exercise', { role: 'check', nodeId: 'chain', question: 'Which?', kind: 'quiz.choice', payload, key: { correct: 'a' } })
    const pending = await openQuestion(h, 'sess-1')
    expect(pending.form).toMatchObject({ type: 'interface', kind: 'quiz.choice', environment: 'quiz.card' })
    expect(JSON.stringify(await api(h, 'GET', 'state', undefined, { session: 'sess-1' }))).not.toContain('product mistake')
    const answered = await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { choice: 'a' } }, { session: 'sess-1' })
    expect(dataOf(answered)).toMatchObject({ question: { answer: { verdict: { outcome: 'correct', countsAsEvidence: true }, reveal: { solution: { correct: 'a' } } } } })
    const view = dataOf(await api(h, 'GET', 'state', undefined, { session: 'sess-1' })) as { learn: { mastery: Array<{ nodeId: string }>; plan: { statuses: Record<string, string> } } }
    expect(view.learn.mastery.map(m => m.nodeId)).toEqual(['chain'])
    expect(view.learn.plan.statuses).toEqual({ power: 'upcoming', chain: 'current' })
  })

  it('security: asks verified exercises from the question banks without showing the tutor their keys', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await teaching(h, agent)
    const listing = await call(h, 'hodos_bank', { query: 'steps' })
    expect(listing.text).toContain('quiz-arithmetic/mixed-s1 (quiz.sequence; Quiz arithmetic: Order of operations)')
    const keys = quizCourse().items.flatMap(i => JSON.stringify(i.key).match(/"[a-z]{4,}"/gu) ?? []).map(k => k.slice(1, -1)).filter(k => !['steps', 'answer', 'correct', 'accept', 'misconceptions'].includes(k))
    for (const k of keys) expect(listing.text, k).not.toContain(k)
    await expect(call(h, 'hodos_exercise', { role: 'check', nodeId: 'chain', question: 'Try this one.', bank: 'quiz-arithmetic/nope' })).rejects.toThrow(/no bank exercise is called "quiz-arithmetic\/nope"/)
    const asked = await call(h, 'hodos_exercise', { role: 'check', nodeId: 'chain', question: 'Name the steps.', bank: 'quiz-arithmetic/mixed-s1' })
    expect(asked.text).not.toMatch(/twelve|fourteen/)
    const pending = await openQuestion(h, 'sess-1')
    const state = dataOf(await api(h, 'GET', 'state', undefined, { session: 'sess-1' })) as { learn: { openQuestion: { origin: string } } }
    expect(state.learn.openQuestion.origin).toBe('bank')
    expect(JSON.stringify(state)).not.toMatch(/twelve|fourteen/)
    for (const token of ['multiply', 'twelve']) await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { token } }, { session: 'sess-1' })
    const done = await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { token: 'fourteen' } }, { session: 'sess-1' })
    expect(dataOf(done)).toMatchObject({ status: 'answered', question: { origin: 'bank', answer: { verdict: { outcome: 'correct', countsAsEvidence: true } } } })
  })

  it('security: takes the session from the calling chat, never from arguments', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'), fakeAgent('sess-2'))
    await call(h, 'hodos_start_learning', { goal: 'chess tactics' }, 'sess-1')
    await expect(h.globals.get('hodos_start_learning')?.execute({ goal: 'x' }, exec(undefined))).rejects.toThrow(/FORBIDDEN/)
    // A probe tool registered for sess-1, called from a chat that is not a learning session, has nothing to act on.
    const probe = h.agents[0]?.scoped.get('hodos_probe')
    await expect(probe?.execute({ question: 'q', options: ['a', 'b'], correct: 'a', sessionId: 'sess-1' }, exec('sess-2'))).rejects.toThrow(/INVALID_STATE: this chat is not a Hodos learning session/)
  })

  it("holds a graded answer until the chat's agent runs again, and restores the session tools", async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await teaching(h, agent)
    await call(h, 'hodos_explain', { role: 'check', nodeId: 'chain', question: 'Why multiply?', answer: 'Rates of change compose multiplicatively.' })
    const pending = await openQuestion(h, 'sess-1')
    h.agents.splice(0, 1)
    h.root.events.emit('agent/disposed', { agent: { id: 'sess-1' } })
    await api(h, 'POST', 'learn/answer', { questionId: pending.id, response: { text: 'because the slopes stack' } }, { session: 'sess-1' })
    expect(agent.followups).toEqual([])
    const again = fakeAgent('sess-1')
    h.agents.push(again)
    h.root.events.emit('agent/created', { agent: again, source: 'resume' })
    expect([...again.scoped.keys()].toSorted()).toEqual(TEACH_TOOLS)
    expect(followupTexts(again)[0]).toContain('Your committed answer: «Rates of change compose multiplicatively.»')
  })

  it("records the tutor's prose and extracts the knowledge graph after a turn, within budget", async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await teaching(h, agent)
    const model = fakeModel([JSON.stringify({
      propositions: [
        { id: 'p1', name: 'Chain rule', statement: 'The derivative of f(g(x)) is f\'(g(x))·g\'(x).', passage: 'T1' },
        { id: 'p2', name: 'Rates compose', statement: 'Rates of change of composed functions multiply.', passage: 'T1' },
      ],
      chains: [{ premises: ['p2'], conclusion: 'p1' }],
    })])
    const unset = h.hodos.setModel(model)
    h.root.events.emit('session/event', { id: 'sess-1' }, assistant(`When functions are composed, their rates of change multiply. ${'That is the chain rule. '.repeat(80)}`))
    h.root.events.emit('session/event', { id: 'sess-other' }, assistant('Unrelated chat text.'))
    h.root.events.emit('session/event', { id: 'sess-1' }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    await waitFor(() => h.hodos.knowledge.snapshot(h.hodos.ownerLearner()).propositions.length === 2, 'the extraction')
    expect(model.requests[0]?.prompt).toContain('[T1]\nWhen functions are composed')
    expect(model.requests[0]?.prompt).not.toContain('secret reasoning')
    const graph = dataOf(await api(h, 'GET', 'graph')) as { propositions: Array<{ name: string }>; edges: unknown[]; clusters: unknown[] }
    expect(graph.propositions.map(p => p.name)).toEqual(['Chain rule', 'Rates compose'])
    expect(graph.edges).toHaveLength(1)
    unset()
    expect((await api(h, 'POST', 'graph/import', { title: 'notes', text: 'x' })).json?.error?.code).toBe('UNAVAILABLE')
  })

  it('runs a practice session: hidden solution, thinking sent to the tutor, reveal on conclusion', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-p')
    h.agents.push(agent)
    const started = await api(h, 'POST', 'practice/start', { targets: [], title: 'Derivatives' }, { session: 'sess-p' })
    expect(dataOf(started)).toMatchObject({ title: 'Derivatives', status: 'active' })
    expect([...agent.scoped.keys()].toSorted()).toEqual(['hodos_conclude', 'hodos_problem'])
    expect(followupTexts(agent)[0]).toContain('started a practice session')
    expect(contextText(h, 'sess-p')).toContain('## You are running a practice session')
    await call(h, 'hodos_problem', { statement: 'Differentiate sin(x^2).', mode: 'recall', modelSolution: 'Outer cos(x^2), inner 2x: 2x cos(x^2).' }, 'sess-p')
    const view = dataOf(await api(h, 'GET', 'state', undefined, { session: 'sess-p' })) as { practice: { problems: Array<{ id: string }> } }
    expect(JSON.stringify(view)).not.toContain('Outer cos')
    const problemId = view.practice.problems[0]?.id ?? ''
    await api(h, 'POST', 'practice/thinking', { problemId, text: 'cos(x^2)?' }, { session: 'sess-p' })
    expect(followupTexts(agent).at(-1)).toBe(`Your thinking (problem ${problemId}):\ncos(x^2)?`)
    await call(h, 'hodos_conclude', { outcome: 'solvedWithHints', verdict: 'Missed the inner factor at first.', rung: 'R1', missClass: 'execution', retest: true }, 'sess-p')
    const after = dataOf(await api(h, 'GET', 'state', undefined, { session: 'sess-p' })) as { practice: { problems: Array<{ modelSolution?: string }> } }
    expect(after.practice.problems[0]?.modelSolution).toBe('Outer cos(x^2), inner 2x: 2x cos(x^2).')
    expect((await api(h, 'POST', 'learn/start', { goal: 'x' }, { session: 'sess-p' })).json?.error?.code).toBe('CONFLICT')
  })

  it('security: trusts environment code only through the host allowlist', async () => {
    const h = await harness()
    await expect(h.hodos.registerEnvironment(createQuizPlugin({ id: 'not-allowlisted' }))).rejects.toThrow(/must ship a sandboxed source/)
  })

  it('keeps tools unrestricted when configured', async () => {
    const h = await harness({ tutorTools: 'unrestricted' })
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await call(h, 'hodos_start_learning', { goal: 'arithmetic' })
    expect([...agent.scoped.keys()].toSorted()).toEqual(PROBE_TOOLS)
    expect(agent.restrictions).toEqual([])
    expect(agent.guards).toEqual([])
  })

  it('closes a session from the workspace and gives the chat its tools back', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await call(h, 'hodos_start_learning', { goal: 'arithmetic' })
    const state = dataOf(await api(h, 'GET', 'state', undefined, { session: 'sess-1' })) as { learn: { id: string } }
    await api(h, 'POST', 'learn/close', { sessionId: state.learn.id }, { session: 'sess-1' })
    expect(agent.scoped.size).toBe(0)
    expect(agent.restrictions).toEqual([])
    expect(h.hodos.isTutorSession('sess-1')).toBe(false)
    expect(contextText(h, 'sess-1')).toBe('')
  })
})

describe('Hodos workspace API', () => {
  it('security: rejects unauthenticated requests through DSH\'s own check', async () => {
    const h = await harness()
    expect((await api(h, 'GET', 'state', undefined, { cookie: 'nope' })).status).toBe(401)
    const app = await fetch(`${h.url}/hodos/app/`, { headers: { cookie: 'nope' } })
    expect(app.status).toBe(401)
  })

  it('security: serves renderer files only from inside the renderer folder', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hodos-renderer-'))
    const dir = join(base, 'plugin')
    cpSync(EXAMPLE_PLUGIN, dir, { recursive: true })
    writeFileSync(join(base, 'secret.js'), 'learner data')
    symlinkSync(join(base, 'secret.js'), join(dir, 'renderer', 'leak.js'))
    const h = await harness({ pluginDirs: [dir] })
    await waitFor(() => h.hodos.registry.renderer('binary-bits') !== undefined, 'the example renderer')
    const at = '/hodos/env/example-binary/binary-bits'
    const served = await rawRequest(h.url, `${at}/bits.js`)
    expect(served).toEqual({ status: 200, csp: RENDERER_CSP })
    for (const path of [
      `${at}/%2e%2e%2fgrader.js`, // the plugin folder above the renderer root
      `${at}/..%2f..%2fsecret.js`, // outside the plugin
      `${at}/leak.js`, // a symbolic link out of the renderer root
      `${at}/bits.js%00.css`,
      `${at}/`,
      '/hodos/env/another-plugin/binary-bits/bits.js', // a renderer id under someone else's plugin id
    ]) expect((await rawRequest(h.url, path)).status, path).toBe(404)
    expect((await rawRequest(h.url, `${at}/bits.js`, 'POST')).status).toBe(404)
  })

  it('security: serves only the code sandbox renderer with the policy that lets it run Python', async () => {
    const h = await harness({ trustedPlugins: ['hodos-quiz', 'hodos-code'] })
    await h.hodos.registerEnvironment(createCodePlugin())
    expect(await rawRequest(h.url, '/hodos/env/hodos-code/code-sandbox/sandbox.html')).toEqual({ status: 200, csp: RUN_CODE_RENDERER_CSP })
    expect(await rawRequest(h.url, '/hodos/env/hodos-code/code-view/index.html')).toEqual({ status: 200, csp: RENDERER_CSP })
    expect(RUN_CODE_RENDERER_CSP).toMatch(/^sandbox allow-scripts;/)
    expect(RUN_CODE_RENDERER_CSP).not.toContain('allow-same-origin')
    expect(RUN_CODE_RENDERER_CSP).not.toContain("'unsafe-eval'")
  })

  it('security: requires JSON bodies, bounds their size and validates fields', async () => {
    const h = await harness()
    expect((await api(h, 'POST', 'learn/start', 'goal=x', { type: 'application/x-www-form-urlencoded' })).status).toBe(400)
    expect((await api(h, 'POST', 'learn/start', { goal: 'x'.repeat(70 * 1024) })).json?.error?.message).toContain('too large')
    expect((await api(h, 'POST', 'learn/start', { goal: 42 })).json?.error?.code).toBe('INVALID_INPUT')
    expect((await api(h, 'POST', 'learn/start', '{not json')).status).toBe(400)
    expect((await api(h, 'POST', 'learn/start', { goal: 'x' }, { session: '' })).json?.error?.message).toContain('open the Hodos panel from a chat')
    expect((await api(h, 'GET', 'state', undefined, { session: 'bad id!' })).status).toBe(400)
    expect((await api(h, 'GET', 'nope')).status).toBe(404)
  })

  it('security: only lets the learner approve agent-proposed courses', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'))
    const course = { ...quizCourse(), id: 'quiz-proposed', title: 'Proposed quiz', keywords: ['proposed'] }
    const proposed = await call(h, 'hodos_propose_course', { course })
    expect(proposed.text).toContain('Stored as a draft')
    expect(proposed.text).toContain('not independently verified')
    const drafts = await api(h, 'GET', 'drafts')
    expect((dataOf(drafts) as Array<{ id: string }>).map(d => d.id)).toEqual(['quiz-proposed'])
    expect((await api(h, 'POST', 'drafts/decide', { courseId: 'quiz-proposed', version: '1.0.0', approve: true })).status).toBe(200)
    expect(h.hodos.courses.catalog().map(c => c.id)).toContain('quiz-proposed')
  })

  it('security: reports errors with stable codes and no internals', async () => {
    const h = await harness()
    const missing = await api(h, 'POST', 'learn/answer', { questionId: 'q_nope', response: { selected: ['a'] } })
    expect(missing.status).toBe(404)
    expect(missing.json?.error).toEqual({ code: 'NOT_FOUND', message: 'no such question' })
  })
})
