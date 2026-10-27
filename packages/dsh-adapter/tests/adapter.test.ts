/**
 * The Hodos DSH plugin on a real Cordis root context with fake DSH services
 * (tools, agents, system prompt, web server, connection). The real-host
 * journey runs in `e2e/` against an installed DeepSeek Harness.
 */
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { correctResponse, createQuizPlugin, quizCourse, wrongResponse } from '@hodos/testing'
import * as plugin from '../src/index.js'
import { GLOBAL_TOOL_NAMES, SESSION_TOOL_NAMES } from '../src/index.js'
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

async function harness(config: Record<string, unknown> = {}, services: Record<string, unknown> = {}): Promise<Harness> {
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
  await hodos.registerEnvironment(createQuizPlugin())
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

/** Tests drive tool bodies directly; only the fields Hodos reads are populated. */
function exec(sessionId: string | undefined): ToolRunContext {
  const fake = { callId: 'call-1', name: 'test', arguments: {}, signal: new AbortController().signal, ...(sessionId === undefined ? {} : { agent: { id: sessionId } }) }
  return fake as unknown as ToolRunContext
}

async function call(h: Harness, name: string, args: Record<string, unknown>, sessionId: string | undefined = 'sess-1'): Promise<{ text: string; ref?: string }> {
  const agent = h.agents.find(a => a.id === sessionId)
  const tool = agent?.scoped.get(name) ?? h.globals.get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not visible in ${sessionId ?? 'a session-less call'}`)
  const value = await tool.execute(args, exec(sessionId))
  return value as { text: string; ref?: string }
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
  it('drafts a course through the configured subagent provider, as a draft with generated provenance', async () => {
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
    expect(requests[0]?.request.prompt[0]?.text).toContain('# Hodos course authoring guide')
    expect(h.hodos.engine.drafts()).toEqual([expect.objectContaining({ id: 'quiz-drafted', origin: 'agent' })])
    for (const item of h.hodos.store.course('quiz-drafted', '0.1.0')?.spec.items ?? []) expect(item.provenance).toEqual({ source: 'generated' })

    // Once the session becomes a restricted tutoring session, drafting (a subagent) is neither offered nor run.
    const tutor = fakeAgent('sess-2')
    h.agents.push(tutor)
    await call(h, 'hodos_start_learning', { goal: 'arithmetic', skip_diagnostic: true }, 'sess-2')
    expect(tutor.restrictions[0]?.allow).not.toContain('hodos_draft_course')
    expect(tutor.guards.map(guard => guard({ name: 'hodos_draft_course' })).find(reason => reason !== undefined)).toContain('not available in a learning session')
  })

  it('registers the global tools, the prompt section and the learner context', async () => {
    const h = await harness()
    expect([...h.globals.keys()].toSorted()).toEqual([...GLOBAL_TOOL_NAMES].toSorted())
    expect(h.sections.map(s => s.name)).toEqual(['hodos'])
    expect(h.sections[0]?.text).toContain('never state the answer')
    expect(h.contexts.map(c => c.name)).toEqual(['hodos-learner'])
  })

  it('starts a journey from the agent, binds the session and turns it into a restricted tutor session', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    const started = await call(h, 'hodos_start_learning', { goal: 'Teach me arithmetic, I struggle with multiplication', self_report: [{ skill: 'addition', level: 'used-it' }] })
    expect(started.text).toContain('Quiz arithmetic')
    expect(started.text).toContain('Hodos learning')
    expect([...agent.scoped.keys()].toSorted()).toEqual([...SESSION_TOOL_NAMES].toSorted())
    expect(agent.restrictions).toEqual([{ allow: expect.arrayContaining([...GLOBAL_TOOL_NAMES]) as unknown as string[] }])
    // Tools that other plugins put in the agent's own scope (DSH's `subagent`) cannot be hidden: the guard refuses them.
    const refused = (name: string): string | undefined => agent.guards.map(guard => guard({ name })).find(reason => reason !== undefined)
    expect(agent.guards).toHaveLength(1)
    for (const name of [...SESSION_TOOL_NAMES, ...GLOBAL_TOOL_NAMES]) expect(refused(name), name).toBeUndefined()
    for (const name of ['subagent', 'subagent_fork', 'bash', 'web_fetch']) expect(refused(name), name).toContain('not available in a learning session')
    expect(h.hodos.isTutorSession('sess-1')).toBe(true)
    // The learner context now appears in the prompt of this session only.
    const context = h.contexts[0]
    const text = (s: string): string => (typeof context?.text === 'function' ? context.text({ agent: { id: s } }) : '')
    expect(text('sess-1')).toContain('Hodos learning context')
    expect(text('sess-other')).toBe('')
  })

  it('trusts environment code only through the host allowlist', async () => {
    const h = await harness()
    await expect(h.hodos.registerEnvironment(createQuizPlugin({ id: 'not-allowlisted' }))).rejects.toThrow(/must ship a sandboxed source/)
  })

  it('keeps tools unrestricted when configured', async () => {
    const h = await harness({ tutorTools: 'unrestricted' })
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await call(h, 'hodos_start_learning', { goal: 'arithmetic', skip_diagnostic: true })
    expect(agent.scoped.size).toBe(SESSION_TOOL_NAMES.length)
    expect(agent.restrictions).toEqual([])
    expect(agent.guards).toEqual([])
  })

  it('takes identity from the calling session, never from arguments', async () => {
    const h = await harness()
    const start = h.globals.get('hodos_start_learning')
    await expect(start?.execute({ goal: 'arithmetic' }, exec(undefined))).rejects.toThrow(/FORBIDDEN/)
    // A model-supplied learner id is just an ignored argument: the session decides.
    const result = await start?.execute({ goal: 'arithmetic', learner_id: 'lrn_someone_else' }, exec('sess-1')) as { ref: string }
    expect(h.hodos.store.journey(result.ref)?.learnerId).toBe(h.hodos.ownerLearner())
  })

  it('keeps the journey readable while its environment is missing', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'))
    await call(h, 'hodos_start_learning', { goal: 'arithmetic multiplication', skip_diagnostic: true })
    await call(h, 'hodos_approve_path', {})
    const ui = h.hodos.uiActor('sess-1')
    for (const l of h.hodos.engine.lesson(ui).lessons) for (const c of l.checks) h.hodos.engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    await call(h, 'hodos_complete_lesson', {})
    await h.hodos.registry.unregister('hodos-quiz')
    const missing = await api(h, 'GET', 'state')
    expect(missing.status).toBe(200)
    const data = dataOf(missing) as { journey: { environments: unknown[] } | null; exercise: unknown }
    expect(data.journey?.environments).toEqual([{ id: 'quiz.card', available: false }])
    expect(data.exercise).toBeNull()
    const next = await api(h, 'POST', 'exercise/next', {})
    expect(next.json?.error?.code).toBe('UNAVAILABLE')
    expect(next.json?.error?.message).toContain('your progress is saved')
  })

  it('relays practice answers as assisted and refuses relayed checkpoint answers', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'))
    await call(h, 'hodos_start_learning', { goal: 'arithmetic multiplication', skip_diagnostic: true })
    await call(h, 'hodos_approve_path', {})
    const lesson = await call(h, 'hodos_lesson', {})
    expect(lesson.text).toContain('Formative checks')
    const ui = h.hodos.uiActor('sess-1')
    const view = h.hodos.engine.lesson(ui)
    for (const l of view.lessons) for (const c of l.checks) h.hodos.engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    await call(h, 'hodos_complete_lesson', {})
    const exercise = await call(h, 'hodos_next_exercise', {})
    const presentationId = exercise.ref ?? ''
    expect(exercise.text).toContain('What is')
    const item = quizCourse().items.find(i => exercise.text.includes((i.payload as { prompt?: string }).prompt ?? '\u0000'))
    if (item === undefined) throw new Error('item not found')
    const relayed = await call(h, 'hodos_submit_answer', { presentation_id: presentationId, response: correctResponse(item) })
    expect(relayed.text).toMatch(/Result: correct/)
    expect(h.hodos.store.evidenceFor(presentationId)[0]).toMatchObject({ assisted: true, channel: 'agent' })
    const hint = call(h, 'hodos_hint', { presentation_id: presentationId })
    await expect(hint).rejects.toThrow(/INVALID_STATE/)
    // A relayed checkpoint answer is refused.
    h.hodos.engine.startCheckpoint(ui)
    const cp = await call(h, 'hodos_next_exercise', {})
    expect(cp.text).toContain('Assessment item')
    await expect(call(h, 'hodos_submit_answer', { presentation_id: cp.ref ?? '', response: wrongResponse(item) })).rejects.toThrow(/POLICY_DENIED/)
  })

  it('resumes tutor sessions when a bound session\'s agent is created again', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'))
    await call(h, 'hodos_start_learning', { goal: 'arithmetic', skip_diagnostic: true })
    h.agents.splice(0)
    h.root.events.emit('agent/disposed', { agent: { id: 'sess-1' } })
    const again = fakeAgent('sess-1')
    h.agents.push(again)
    h.root.events.emit('agent/created', { agent: again, source: 'resume' })
    expect(again.scoped.size).toBe(SESSION_TOOL_NAMES.length)
    expect(again.restrictions).toHaveLength(1)
  })

  it('records tutor contact for learner messages in bound sessions only', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'))
    await call(h, 'hodos_start_learning', { goal: 'arithmetic', skip_diagnostic: true })
    const ui = h.hodos.uiActor('sess-1')
    h.hodos.engine.approvePath(ui)
    for (const l of h.hodos.engine.lesson(ui).lessons) for (const c of l.checks) h.hodos.engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    h.hodos.engine.completeLesson(ui)
    const ex = h.hodos.engine.nextExercise(ui)
    const userMessage = { type: 'user/message', seq: 1, time: 0, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'help?' }], source: { kind: 'user' } } }
    h.root.events.emit('session/event', { id: 'sess-other' }, userMessage)
    expect(h.hodos.store.presentation(ex?.id ?? '')?.tutorContact).toBe(false)
    h.root.events.emit('session/event', { id: 'sess-1' }, { ...userMessage, data: { ...userMessage.data, source: { kind: 'hodos' } } })
    expect(h.hodos.store.presentation(ex?.id ?? '')?.tutorContact).toBe(false)
    h.root.events.emit('session/event', { id: 'sess-1' }, userMessage)
    expect(h.hodos.store.presentation(ex?.id ?? '')?.tutorContact).toBe(true)
  })

  it('tells the tutor about workspace activity with bounded notices', async () => {
    const h = await harness({ notices: 'proactive' })
    const agent = fakeAgent('sess-1')
    h.agents.push(agent)
    await call(h, 'hodos_start_learning', { goal: 'arithmetic', skip_diagnostic: true })
    const ui = h.hodos.uiActor('sess-1')
    h.hodos.engine.approvePath(ui)
    for (const l of h.hodos.engine.lesson(ui).lessons) for (const c of l.checks) h.hodos.engine.answerCheck(ui, { lessonId: l.id, checkId: c.id, optionId: 'a' })
    h.hodos.engine.completeLesson(ui)
    for (let i = 0; i < 10; i++) {
      const ex = h.hodos.engine.nextExercise(ui)
      if (ex === null) break
      const item = quizCourse().items.find(entry => entry.id === ex.itemId)
      if (item === undefined) break
      await h.hodos.engine.submitAttempt(ui, { presentationId: ex.id, response: correctResponse(item) })
    }
    // A token bucket (6 per learner, slow refill) caps notices, so a busy learner cannot drive unbounded model calls.
    expect(agent.injected.length).toBe(6)
    const first = agent.injected[0] as { source: { kind: string; form: string; summary: string }; content: Array<{ text: string }> }
    expect(first.source).toMatchObject({ kind: 'hodos', form: 'notice' })
    expect(first.source.summary.length).toBeLessThanOrEqual(120)
    expect(first.content[0]?.text).toContain('[Hodos] The learner answered a practice exercise')
  })
})

describe('Hodos workspace API', () => {
  it('rejects unauthenticated requests through DSH\'s own check', async () => {
    const h = await harness()
    expect((await api(h, 'GET', 'state', undefined, { cookie: 'nope' })).status).toBe(401)
    const app = await fetch(`${h.url}/hodos/app/`, { headers: { cookie: 'nope' } })
    expect(app.status).toBe(401)
  })

  it('requires JSON bodies, bounds their size and validates fields', async () => {
    const h = await harness()
    expect((await api(h, 'POST', 'journeys', 'goal=x', { type: 'application/x-www-form-urlencoded' })).status).toBe(400)
    expect((await api(h, 'POST', 'journeys', { goal: 'x'.repeat(70 * 1024) })).json?.error?.message).toContain('too large')
    expect((await api(h, 'POST', 'journeys', { goal: 42 })).json?.error?.code).toBe('INVALID_INPUT')
    expect((await api(h, 'POST', 'journeys', '{not json')).status).toBe(400)
    expect((await api(h, 'GET', 'state', undefined, { session: 'bad id!' })).status).toBe(400)
    expect((await api(h, 'GET', 'nope')).status).toBe(404)
  })

  it('runs a learner journey from the workspace and binds the session', async () => {
    const h = await harness()
    const agent = fakeAgent('sess-9')
    h.agents.push(agent)
    const start = await api(h, 'POST', 'journeys', { goal: 'quiz arithmetic', skipDiagnostic: true }, { session: 'sess-9' })
    expect(start.status).toBe(200)
    expect(agent.scoped.size).toBe(SESSION_TOOL_NAMES.length)
    expect((await api(h, 'POST', 'journey/approve', {}, { session: 'sess-9' })).status).toBe(200)
    const lesson = await api(h, 'GET', 'lesson', undefined, { session: 'sess-9' })
    const lessons = (dataOf(lesson) as { lessons: Array<{ id: string; checks: Array<{ id: string }> }> }).lessons
    expect(JSON.stringify(lesson.json)).not.toContain('because that is the rule')
    for (const l of lessons) for (const c of l.checks) await api(h, 'POST', 'lesson/check', { lessonId: l.id, checkId: c.id, optionId: 'a' }, { session: 'sess-9' })
    expect((await api(h, 'POST', 'lesson/complete', {}, { session: 'sess-9' })).status).toBe(200)
    const next = await api(h, 'POST', 'exercise/next', {}, { session: 'sess-9' })
    const exercise = dataOf(next) as { id: string; itemId: string; payload: unknown }
    expect(JSON.stringify(exercise)).not.toContain('"key"')
    expect(JSON.stringify(exercise)).not.toContain('internal-note')
    const item = quizCourse().items.find(i => i.id === exercise.itemId)
    if (item === undefined) throw new Error('item')
    const hint = await api(h, 'POST', 'exercise/hint', { presentationId: exercise.id }, { session: 'sess-9' })
    expect((dataOf(hint) as { level: number }).level).toBe(1)
    const wrong = await api(h, 'POST', 'exercise/submit', { presentationId: exercise.id, response: wrongResponse(item), latencyMs: 3000 }, { session: 'sess-9' })
    expect((dataOf(wrong) as { status: string }).status).toBe('incorrect')
    const state = await api(h, 'GET', 'state', undefined, { session: 'sess-9' })
    expect((dataOf(state) as { exercise: { id: string } }).exercise.id).toBe(exercise.id)
    expect(state.headers.get('cache-control')).toBe('no-store')
  })

  it('only lets the learner approve agent-proposed courses', async () => {
    const h = await harness()
    h.agents.push(fakeAgent('sess-1'))
    const course = { ...quizCourse(), id: 'quiz-proposed', title: 'Proposed quiz', keywords: ['proposed'] }
    const proposed = await call(h, 'hodos_propose_course', { course })
    expect(proposed.text).toContain('Stored as a draft')
    expect(proposed.text).toContain('not independently verified')
    const drafts = await api(h, 'GET', 'drafts')
    expect((dataOf(drafts) as Array<{ id: string }>).map(d => d.id)).toEqual(['quiz-proposed'])
    expect((await api(h, 'POST', 'drafts/decide', { courseId: 'quiz-proposed', version: '1.0.0', approve: true })).status).toBe(200)
    expect(h.hodos.engine.catalog().map(c => c.id)).toContain('quiz-proposed')
  })

  it('reports errors with stable codes and no internals', async () => {
    const h = await harness()
    const missing = await api(h, 'POST', 'journey/approve', {})
    expect(missing.status).toBe(404)
    expect(missing.json?.error).toEqual({ code: 'NOT_FOUND', message: 'no learning journey yet; start one with a goal' })
  })
})
