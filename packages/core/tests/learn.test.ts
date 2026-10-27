import { afterAll, describe, expect, it } from 'vitest'
import {
  brandId,
  findCycle,
  gradeChoice,
  HodosError,
  HodosStore,
  LearnRepository,
  LearnService,
  manualClock,
  parsePlan,
  planStatuses,
  planToMermaid,
  PluginRegistry,
  readChoiceBody,
  readProbeAssessment,
  SandboxRunner,
  sequentialIds,
  shuffledOptions,
  topologicalOrder,
  type ChoiceBody,
  type LearnerId,
  type ManualClock,
  type PlanTree,
} from '../src/index.js'
import { createQuizPlugin, type QuizOptions } from '@hodos/testing'

const sandbox = new SandboxRunner()
afterAll(() => sandbox.dispose())
const silent = { info: () => {}, warn: () => {}, error: () => {} }

function plan(source: string): PlanTree {
  const parsed = parsePlan(source)
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'))
  return parsed.plan
}

function problemsOf(source: string): readonly string[] {
  const parsed = parsePlan(source)
  return parsed.ok ? [] : parsed.problems
}

describe('plan maps', () => {
  it('parses nodes, labels, chains and arrow styles', () => {
    const p = plan(`graph TD
      %% the map
      limits[Limits] --> derivative("The derivative")
      derivative ==> chain-rule(Chain rule) -.-> related_rates
      limits --> derivative;`)
    expect(p.nodes).toEqual([
      { id: 'limits', title: 'Limits' },
      { id: 'derivative', title: 'The derivative' },
      { id: 'chain-rule', title: 'Chain rule' },
      { id: 'related_rates', title: 'related_rates' },
    ])
    expect(p.edges).toEqual([
      { from: 'limits', to: 'derivative' },
      { from: 'derivative', to: 'chain-rule' },
      { from: 'chain-rule', to: 'related_rates' },
    ])
  })

  it('strips a mermaid fence and accepts a map without a header', () => {
    expect(plan('```mermaid\na[A] --> b[B]\n```').nodes.map(n => n.id)).toEqual(['a', 'b'])
    expect(plan('solo[Just one idea]').nodes).toEqual([{ id: 'solo', title: 'Just one idea' }])
  })

  it('keeps the first title a node was given', () => {
    expect(plan('a[First] --> b\nb --> a2\na[Second] --> a2').nodes[0]).toEqual({ id: 'a', title: 'First' })
  })

  it('reports every problem with its line number', () => {
    const problems = problemsOf('graph LR\nA --> b\nsubgraph x\nc --> c\nd -->\n')
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^line 2: node id "A" must be lowercase/),
      expect.stringMatching(/^line 3: "subgraph" is not supported/),
      expect.stringMatching(/^line 4: "c" cannot depend on itself/),
      expect.stringMatching(/^line 5: an arrow needs a node on both sides/),
    ]))
  })

  it('rejects cycles, empty maps and oversized maps', () => {
    expect(problemsOf('a --> b\nb --> c\nc --> a')[0]).toMatch(/cycle: a --> b --> c --> a/)
    expect(problemsOf('%% nothing\n')).toEqual(['the plan has no nodes'])
    const many = Array.from({ length: 31 }, (_, i) => `n${i}`).join('\n')
    expect(problemsOf(many)[0]).toMatch(/31 nodes/)
    expect(problemsOf('x'.repeat(9000))[0]).toMatch(/longer than 8000/)
  })

  it('orders prerequisites first and finds no cycle in a DAG', () => {
    const p = plan('c --> d\na --> b\nb --> d\na --> c')
    expect(findCycle(p)).toBeNull()
    expect(topologicalOrder(p)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('derives statuses from tagged questions: latest current, earlier visited', () => {
    const p = plan('a --> b --> c')
    expect(planStatuses(p, [])).toEqual({ a: 'upcoming', b: 'upcoming', c: 'upcoming' })
    expect(planStatuses(p, ['a', 'b', 'a', 'gone'])).toEqual({ a: 'current', b: 'visited', c: 'upcoming' })
  })

  it('round-trips through mermaid', () => {
    const p = plan('a[Alpha] --> b("Beta [x]")\nc(x) --> b')
    expect(planToMermaid(p)).toBe('graph TD\n  a["Alpha"]\n  b["Beta [x]"]\n  c["x"]\n  a --> b\n  c --> b')
    expect(plan(planToMermaid(p))).toEqual(p)
  })
})

describe('choice questions', () => {
  it('reads options as strings or objects and resolves correct by value or label', () => {
    const problems: string[] = []
    const body = readChoiceBody({ options: ['Six', { label: 'Two', value: 'b' }, 'Three'], correct: 'Six' }, problems)
    expect(problems).toEqual([])
    expect(body).toEqual({ type: 'choice', options: [{ value: 'six', label: 'Six' }, { value: 'b', label: 'Two' }, { value: 'three', label: 'Three' }], correct: ['six'], multi: false })
  })

  it('collects every authoring problem', () => {
    const problems: string[] = []
    expect(readChoiceBody({ options: ['A', 'A', { value: 'x' }], correct: ['zzz'] }, problems)).toBeUndefined()
    expect(problems).toEqual(expect.arrayContaining([
      'option 3 needs a label',
      'two options share the value "a"; values must be unique',
      'correct names "zzz", which is not one of the options; use an option\'s value',
      'correct is required: commit to the right answer before asking',
    ]))
    const more: string[] = []
    readChoiceBody({ options: ['A', 'B'], correct: ['A', 'B'] }, more)
    expect(more).toContain('a single-answer question has exactly one correct option; set multi to true for several')
    const all: string[] = []
    readChoiceBody({ options: ['A', 'B'], correct: ['A', 'B'], multi: true }, all)
    expect(all).toContain('every option is correct; a question needs at least one wrong option')
  })

  it('shuffles options deterministically per question', () => {
    const options = 'abcdefgh'.split('').map(v => ({ value: v, label: v.toUpperCase() }))
    const first = shuffledOptions('q_1', options)
    expect(shuffledOptions('q_1', options)).toEqual(first)
    expect(first.map(o => o.value).toSorted()).toEqual(options.map(o => o.value))
    const orders = new Set(['q_1', 'q_2', 'q_3', 'q_4'].map(id => shuffledOptions(id, options).map(o => o.value).join('')))
    expect(orders.size).toBeGreaterThan(1)
  })

  it('grades exact sets as correct and gives partial credit on multi-select', () => {
    const multi: ChoiceBody = { type: 'choice', options: ['a', 'b', 'c', 'd'].map(v => ({ value: v, label: v })), correct: ['a', 'b'], multi: true }
    expect(gradeChoice(multi, { selected: ['b', 'a'] })).toMatchObject({ outcome: 'correct', score: 1 })
    expect(gradeChoice(multi, { selected: ['a'] })).toMatchObject({ outcome: 'partial', score: 0.5 })
    expect(gradeChoice(multi, { selected: ['a', 'c'] })).toMatchObject({ outcome: 'incorrect', score: 0 })
    const single: ChoiceBody = { ...multi, correct: ['c'], multi: false }
    expect(gradeChoice(single, { selected: ['d'] })).toMatchObject({ outcome: 'incorrect', countsAsEvidence: true })
  })
})

describe('probe assessments', () => {
  it('accepts an object or its JSON text', () => {
    const value = { strands: [{ strand: 'Limits', assessment: 'Solid on epsilon-delta' }], summary: 'Ready for derivatives' }
    expect(readProbeAssessment(value, [])).toEqual(value)
    expect(readProbeAssessment(JSON.stringify(value), [])).toEqual(value)
  })

  it('rejects missing strands and incomplete entries', () => {
    const problems: string[] = []
    expect(readProbeAssessment({ strands: [] }, problems)).toBeUndefined()
    expect(problems[0]).toMatch(/at least one/)
    const more: string[] = []
    readProbeAssessment({ strands: [{ strand: 'x' }] }, more)
    expect(more).toEqual(['strand 1 needs both "strand" and "assessment" text'])
  })
})

interface Env {
  readonly clock: ManualClock
  readonly learn: LearnService
  readonly learner: LearnerId
  readonly other: LearnerId
}

async function setup(quiz: QuizOptions = {}): Promise<Env> {
  const clock = manualClock(new Date('2026-10-28T09:00:00.000Z'))
  const store = new HodosStore(':memory:')
  const registry = new PluginRegistry({ sandbox, logger: silent })
  await registry.register(createQuizPlugin(quiz), { trusted: true })
  const learner = brandId<'LearnerId'>('lrn_me')
  const other = brandId<'LearnerId'>('lrn_other')
  for (const id of [learner, other]) store.insertLearner({ id, displayName: id, settings: {}, createdAt: clock.now().toISOString() })
  const learn = new LearnService({ repository: new LearnRepository(store), registry, logger: silent, clock, ids: sequentialIds() })
  return { clock, learn, learner, other }
}

const PLAN = 'graph TD\n  limits[Limits] --> derivative[The derivative]\n  derivative --> chain-rule[Chain rule]'

async function toTeaching(env: Env): Promise<string> {
  const session = env.learn.start(env.learner, 'Understand the chain rule', 'chat-1')
  env.learn.concludeProbe(session.id, { strands: [{ strand: 'derivatives', assessment: 'knows the power rule' }] })
  env.learn.setPlan(session.id, PLAN)
  return session.id
}

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<HodosError> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    if (error instanceof HodosError) return error
    throw error
  }
  throw new Error('expected a HodosError')
}

describe('learning sessions', () => {
  it('runs probe → plan → teach, keeping keys out of the learner view until answered', async () => {
    const env = await setup()
    const session = env.learn.start(env.learner, '  Understand the chain rule ', 'chat-1')
    expect(session).toMatchObject({ phase: 'probe', goal: 'Understand the chain rule', hostSessionId: 'chat-1' })
    expect(env.learn.sessionForHost('chat-1')?.id).toBe(session.id)

    const probe = await env.learn.ask(session.id, {
      form: 'choice', role: 'probe', prompt: 'What is the derivative of x^2?',
      input: { options: ['2x', 'x', 'x^2 / 2'], correct: '2x', explanation: 'Power rule: bring the exponent down.' },
    })
    const open = env.learn.view(env.learner, session.id).openQuestion
    expect(open?.form.type === 'choice' ? open.form.options.map(o => o.value).toSorted() : []).toEqual(['2x', 'x', 'x-2-2'])
    expect(JSON.stringify(open)).not.toMatch(/Power rule|correct/)

    const answered = await env.learn.answer(env.learner, probe.id, { response: { selected: ['x'] }, thinking: 'I think it halves' })
    expect(answered.status).toBe('answered')
    if (answered.status !== 'answered') return
    expect(answered.question.answer?.verdict).toMatchObject({ outcome: 'incorrect', score: 0 })
    expect(answered.question.answer?.reveal).toEqual({ correct: ['2x'], explanation: 'Power rule: bring the exponent down.' })
    expect(answered.report).toContain('The learner answered "x". Incorrect.')
    expect(answered.report).toContain('The correct answer: "2x".')
    expect(answered.report).toContain('Their thinking out loud: «I think it halves»')

    expect((await rejection(() => env.learn.setPlan(session.id, PLAN))).code).toBe('INVALID_STATE')
    expect((await rejection(env.learn.ask(session.id, { form: 'explain', role: 'check', nodeId: 'x', prompt: 'p', input: { answer: 'a' } }))).code).toBe('INVALID_STATE')

    env.learn.concludeProbe(session.id, { strands: [{ strand: 'derivatives', assessment: 'confuses the power rule' }], summary: 'start at the power rule' })
    expect((await rejection(() => env.learn.concludeProbe(session.id, { strands: [{ strand: 'a', assessment: 'b' }] }))).message).toMatch(/already concluded/)
    expect((await rejection(env.learn.ask(session.id, { form: 'explain', role: 'check', nodeId: 'limits', prompt: 'p', input: { answer: 'a' } }))).message).toMatch(/no plan map yet/)

    const bad = await rejection(() => env.learn.setPlan(session.id, 'a --> b\nb --> a'))
    expect(bad.code).toBe('INVALID_INPUT')
    expect(bad.message).toMatch(/cycle/)
    const view = env.learn.setPlan(session.id, PLAN)
    expect(view.version).toBe(1)
    expect(env.learn.view(env.learner, session.id).phase).toBe('plan')

    const unknown = await rejection(env.learn.ask(session.id, { form: 'explain', role: 'predict', nodeId: 'integrals', prompt: 'p', input: { answer: 'a' } }))
    expect(unknown.message).toMatch(/"integrals" is not a node of the plan; use one of limits, derivative, chain-rule/)
    await env.learn.ask(session.id, { form: 'explain', role: 'predict', nodeId: 'derivative', prompt: 'What does a derivative measure?', input: { answer: 'The instantaneous rate of change.' } })
    const teaching = env.learn.view(env.learner, session.id)
    expect(teaching.phase).toBe('teach')
    expect(teaching.plan?.statuses).toEqual({ limits: 'upcoming', derivative: 'current', 'chain-rule': 'upcoming' })
    expect(JSON.stringify(teaching.openQuestion)).not.toContain('instantaneous')
    expect(env.learn.tutorContext(session.id)).toContain('Waiting for the learner\'s answer to: predict on derivative: What does a derivative measure? (answered in their own words)')
  })

  it('reports free-recall answers against the committed answer and never grades them', async () => {
    const env = await setup()
    const sessionId = await toTeaching(env)
    const q = await env.learn.ask(sessionId, { form: 'explain', role: 'check', nodeId: 'chain-rule', prompt: 'Why multiply the derivatives?', input: { answer: 'Rates of change compose multiplicatively.' } })
    expect((await rejection(env.learn.answer(env.learner, q.id, { response: { text: '  ' } }))).code).toBe('INVALID_INPUT')
    const result = await env.learn.answer(env.learner, q.id, { response: { text: 'because the slopes stack' } })
    if (result.status !== 'answered') throw new Error('expected an answer')
    expect(result.question.answer?.verdict).toEqual({ outcome: 'ungraded', score: null, countsAsEvidence: false })
    expect(result.question.answer?.reveal).toEqual({ committedAnswer: 'Rates of change compose multiplicatively.' })
    expect(result.report).toContain('Your committed answer: «Rates of change compose multiplicatively.»')
    expect(result.report).toContain('do not revise the commitment')
    expect(env.learn.view(env.learner, sessionId).mastery).toEqual([])
  })

  it('updates mastery and schedules review from graded checks only', async () => {
    const env = await setup()
    const sessionId = await toTeaching(env)
    const ask = (role: 'predict' | 'check') => env.learn.ask(sessionId, { form: 'choice', role, nodeId: 'limits', prompt: `${role}: limit of 1/x at infinity?`, input: { options: ['0', '1', 'infinity'], correct: '0' } })
    const predicted = await ask('predict')
    await env.learn.answer(env.learner, predicted.id, { response: { selected: ['0'] } })
    expect(env.learn.view(env.learner, sessionId).mastery).toEqual([])

    for (let i = 0; i < 3; i += 1) {
      const q = await ask('check')
      await env.learn.answer(env.learner, q.id, { response: { selected: ['0'] } })
    }
    const mastery = env.learn.view(env.learner, sessionId).mastery
    expect(mastery).toHaveLength(1)
    expect(mastery[0]).toMatchObject({ nodeId: 'limits', observations: 3 })
    expect(mastery[0]?.pMastered).toBeGreaterThan(0.5)
    expect(mastery[0]?.dueAt).not.toBeNull()
    expect(env.learn.dueReviews(env.learner)).toEqual([])
    env.clock.advance(400 * 86_400_000)
    expect(env.learn.dueReviews(env.learner)).toEqual([expect.objectContaining({ nodeId: 'limits', title: 'Limits', goal: 'Understand the chain rule' })])

    const dontKnow = await ask('check')
    await env.learn.answer(env.learner, dontKnow.id, { dontKnow: true })
    const after = env.learn.view(env.learner, sessionId).mastery[0]
    expect(after?.observations).toBe(4)
    expect(after?.pMastered).toBeLessThan(mastery[0]?.pMastered ?? 0)
  })

  it('validates interface questions with their plugin and grades them with its grader', async () => {
    const env = await setup()
    const sessionId = await toTeaching(env)
    const payload = { prompt: 'Which is the chain rule?', options: [{ id: 'a', text: "f'(g(x)) g'(x)" }, { id: 'b', text: "f'(x) g'(x)" }], authorNote: 'b is the product mistake' }
    const missing = await rejection(env.learn.ask(sessionId, { form: 'interface', role: 'check', nodeId: 'chain-rule', prompt: 'Pick one', input: { kind: 'chess.puzzle', payload, key: { correct: 'a' } } }))
    expect(missing.message).toMatch(/no installed interface is called "chess.puzzle"; installed: quiz.choice, quiz.text, quiz.sequence/)
    const invalid = await rejection(env.learn.ask(sessionId, { form: 'interface', role: 'check', nodeId: 'chain-rule', prompt: 'Pick one', input: { kind: 'quiz.choice', payload, key: { correct: 'z' } } }))
    expect(invalid.message).toMatch(/quiz\/key: the correct option is not one of the options/)
    const leaky = await rejection(env.learn.ask(sessionId, { form: 'interface', role: 'check', nodeId: 'chain-rule', prompt: 'Hint: the product mistake is tempting', input: { kind: 'quiz.text', payload: { prompt: 'Name the rule' }, key: { answer: 'the product mistake' } } }))
    expect(leaky.message).toMatch(/gives away the key/)

    const q = await env.learn.ask(sessionId, { form: 'interface', role: 'check', nodeId: 'chain-rule', prompt: 'Pick the chain rule', input: { kind: 'quiz.choice', payload, key: { correct: 'a' }, explanation: 'Differentiate the outside, keep the inside.' } })
    const open = env.learn.openQuestion(sessionId)
    expect(open?.form).toMatchObject({ type: 'interface', kind: 'quiz.choice', environment: 'quiz.card' })
    expect(JSON.stringify(open)).not.toMatch(/product mistake|Differentiate the outside|"correct"/)
    expect((await rejection(env.learn.answer(env.learner, q.id, { response: { pick: 'a' } }))).code).toBe('INVALID_INPUT')

    const result = await env.learn.answer(env.learner, q.id, { response: { choice: 'a' } })
    if (result.status !== 'answered') throw new Error('expected an answer')
    expect(result.question.answer?.verdict).toEqual({ outcome: 'correct', score: 1, feedback: 'Correct!', countsAsEvidence: true })
    expect(result.question.answer?.reveal).toEqual({ explanation: 'Differentiate the outside, keep the inside.', solution: { correct: 'a' } })
    expect(env.learn.view(env.learner, sessionId).mastery[0]).toMatchObject({ nodeId: 'chain-rule', observations: 1 })
  })

  it('steps through stepwise interface questions', async () => {
    const env = await setup()
    const sessionId = await toTeaching(env)
    const q = await env.learn.ask(sessionId, { form: 'interface', role: 'check', nodeId: 'derivative', prompt: 'Differentiate step by step', input: { kind: 'quiz.sequence', payload: { prompt: 'Steps', length: 2 }, key: { steps: ['outer', 'inner'] } } })
    const first = await env.learn.answer(env.learner, q.id, { response: { token: 'outer' } })
    expect(first).toMatchObject({ status: 'continue', message: 'Good. Next step?', question: { status: 'open', progress: { entered: ['outer'] } } })
    const done = await env.learn.answer(env.learner, q.id, { response: { token: 'inner' } })
    expect(done).toMatchObject({ status: 'answered', question: { status: 'answered', answer: { verdict: { outcome: 'correct' } } } })
  })

  it('does not count advisory graders as evidence', async () => {
    const env = await setup({ method: 'ai-rubric' })
    const sessionId = await toTeaching(env)
    const q = await env.learn.ask(sessionId, { form: 'interface', role: 'check', nodeId: 'limits', prompt: 'Name it', input: { kind: 'quiz.text', payload: { prompt: 'What is lim 1/x?' }, key: { answer: 'zero', accept: ['0'] } } })
    const result = await env.learn.answer(env.learner, q.id, { response: { text: '0' } })
    if (result.status !== 'answered') throw new Error('expected an answer')
    expect(result.question.answer?.verdict.countsAsEvidence).toBe(false)
    expect(env.learn.view(env.learner, sessionId).mastery).toEqual([])
  })

  it('supersedes an open question, guards ownership and refuses closed sessions', async () => {
    const env = await setup()
    const sessionId = await toTeaching(env)
    const first = await env.learn.ask(sessionId, { form: 'explain', role: 'predict', nodeId: 'limits', prompt: 'First?', input: { answer: 'one' } })
    const second = await env.learn.ask(sessionId, { form: 'explain', role: 'predict', nodeId: 'derivative', prompt: 'Second?', input: { answer: 'two' } })
    expect((await rejection(env.learn.answer(env.learner, first.id, { response: { text: 'x' } }))).message).toMatch(/withdrawn/)
    expect((await rejection(env.learn.answer(env.other, second.id, { response: { text: 'x' } }))).code).toBe('NOT_FOUND')
    expect((await rejection(() => env.learn.view(env.other, sessionId))).code).toBe('NOT_FOUND')
    expect(env.learn.view(env.learner, sessionId).plan?.statuses).toMatchObject({ limits: 'visited', derivative: 'current' })

    expect((await rejection(() => env.learn.start(env.learner, 'again', 'chat-1'))).code).toBe('CONFLICT')
    expect((await rejection(() => env.learn.start(env.learner, ' ', null))).code).toBe('INVALID_INPUT')

    env.learn.close(env.learner, sessionId)
    expect((await rejection(env.learn.answer(env.learner, second.id, { response: { text: 'x' } }))).message).toMatch(/closed/)
    expect((await rejection(env.learn.ask(sessionId, { form: 'explain', role: 'check', nodeId: 'limits', prompt: 'p', input: { answer: 'a' } }))).code).toBe('INVALID_STATE')
  })

  it('refuses to conclude the probe while a probe question waits for its answer', async () => {
    const env = await setup()
    const session = env.learn.start(env.learner, 'Chess tactics', null)
    await env.learn.ask(session.id, { form: 'explain', role: 'probe', prompt: 'What is a fork?', input: { answer: 'One piece attacking two.' } })
    expect((await rejection(() => env.learn.concludeProbe(session.id, { strands: [{ strand: 'forks', assessment: '?' }] }))).message).toMatch(/still waiting/)
    env.learn.withdrawOpen(session.id)
    expect(env.learn.concludeProbe(session.id, { strands: [{ strand: 'forks', assessment: 'unknown' }] }).strands).toHaveLength(1)
    const bad = await rejection(env.learn.ask(session.id, { form: 'choice', role: 'probe', prompt: 'p', input: { options: ['a', 'b'], correct: 'a' } }))
    expect(bad.code).toBe('INVALID_STATE')
  })
})
