import { describe, expect, it } from 'vitest'
import {
  brandId,
  chainsForSelection,
  deriveView,
  GraphRepository,
  HodosError,
  HodosStore,
  KnowledgeService,
  LearnRepository,
  manualClock,
  parseJsonReply,
  PracticeService,
  readFindings,
  sequentialIds,
  simplifyChains,
  type GraphProposition,
  type LearnerId,
  type ModelPort,
  type ModelRequest,
} from '../src/index.js'

const silent = { info: () => {}, warn: () => {}, error: () => {} }

const chain = (id: string, premises: string[], conclusion: string, createdAt = '2026-10-28T00:00:00.000Z') => ({ id, premises, conclusion, createdAt })
const prop = (id: string): GraphProposition => ({ id, name: id.toUpperCase(), statement: id, aliases: [], createdAt: '', provenance: [] })
const notesReply = (n: number): string => JSON.stringify({ propositions: [{ id: 'p1', name: `Idea ${n}`, statement: `Statement ${n}.` }], chains: [] })

describe('chains', () => {
  it('keeps the leanest derivation of a conclusion', () => {
    const kept = simplifyChains([chain('c1', ['a', 'b'], 'x'), chain('c2', ['a'], 'x'), chain('c3', ['d'], 'x')])
    expect(kept.map(c => c.id)).toEqual(['c2', 'c3'])
  })

  it('drops a chain whose premises a kept chain already derives', () => {
    const kept = simplifyChains([chain('ab-x', ['a', 'b'], 'x'), chain('xc-y', ['c', 'x'], 'y'), chain('abc-y', ['a', 'b', 'c'], 'y')])
    expect(kept.map(c => c.id)).toEqual(['ab-x', 'xc-y'])
  })

  it('selects chains whose members are all picked; the rest stand alone', () => {
    const chains = [chain('arg_1', ['a', 'b'], 'x'), chain('arg_2', ['x'], 'y')]
    expect(chainsForSelection(['a', 'b', 'x', 'z'], chains)).toEqual([
      { id: 'arg_1', premises: ['a', 'b'], conclusion: 'x' },
      { id: 'z', premises: [], conclusion: 'z' },
    ])
  })

  it('derives arrows: direct for one premise, through a junction for several', () => {
    const view = deriveView(['a', 'b', 'x', 'y'].map(prop), [
      { ...chain('arg_1', ['a', 'b'], 'x'), sources: [] },
      { ...chain('arg_2', ['x'], 'y'), sources: [] },
      { ...chain('arg_3', ['gone'], 'y'), sources: [] },
    ])
    expect(view.edges).toEqual([{ from: 'a', to: 'arg_1' }, { from: 'b', to: 'arg_1' }, { from: 'arg_1', to: 'x' }, { from: 'x', to: 'y' }])
    expect(view.implications).toEqual([{ id: 'arg_1', premises: ['a', 'b'], conclusion: 'x', line: 'A, B → X' }])
    expect(view.logicalEdges).toHaveLength(3)
  })
})

describe('findings', () => {
  it('reads JSON from fenced or chatty replies', () => {
    expect(parseJsonReply('Here:\n```json\n{"links": []}\n```')).toEqual({ links: [] })
    expect(parseJsonReply('ok {"a": 1} done')).toEqual({ a: 1 })
    expect(parseJsonReply('no json')).toMatch(/one JSON object/)
  })

  it('validates endpoints, ids and passages', () => {
    const result = readFindings({
      propositions: [{ id: 'p1', name: 'Rate', statement: 'A derivative is a rate.', passage: 'T9' }, { id: 'n_1', name: 'x', statement: 'y', passage: 'T2' }],
      chains: '[{"premises": ["p1", "p7"], "conclusion": "p1"}]',
    }, { existing: new Set(['n_1']), passages: new Set([2, 3]) })
    expect('problems' in result ? result.problems : []).toEqual([
      'proposition 1 (p1): "passage" must be the label of one passage of this stretch (such as "T2")',
      'proposition 2 (n_1): the id "n_1" is already used; give each new proposition its own id',
      'chain 1: premises "p7" are neither propositions of this report nor existing ids',
    ])
  })
})

/** A fake model that answers each purpose from a queue and records the prompts. */
function fakeModel(replies: Record<string, string[]>): ModelPort & { readonly requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  return {
    requests,
    complete: request => {
      requests.push(request)
      const next = replies[request.purpose]?.shift()
      if (next === undefined) return Promise.reject(new Error(`no scripted reply for ${request.purpose}`))
      return Promise.resolve({ text: next, inputTokens: 100, outputTokens: 50 })
    },
  }
}

interface Env {
  readonly store: HodosStore
  readonly learnRepo: LearnRepository
  readonly graph: GraphRepository
  readonly learner: LearnerId
  readonly other: LearnerId
}

function setup(): Env {
  const store = new HodosStore(':memory:')
  const learner = brandId<'LearnerId'>('lrn_me')
  const other = brandId<'LearnerId'>('lrn_other')
  for (const id of [learner, other]) store.insertLearner({ id, displayName: id, settings: {}, createdAt: '2026-10-28T00:00:00.000Z' })
  return { store, learnRepo: new LearnRepository(store), graph: new GraphRepository(store), learner, other }
}

function session(env: Env, id: string, goal: string, teacher: string[]): void {
  env.learnRepo.insertSession({ id, learnerId: env.learner, hostSessionId: null, goal, phase: 'teach', assessment: null, plan: null, planSource: null, planVersion: 0, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' })
  for (const text of teacher) {
    env.learnRepo.appendTranscript(id, 'teacher', text, '2026-10-28T00:00:00.000Z')
    env.learnRepo.appendTranscript(id, 'learner', `SECRET LEARNER NOTE after: ${text.slice(0, 10)}`, '2026-10-28T00:00:00.000Z')
  }
}

const FIRST = JSON.stringify({
  propositions: [
    { id: 'p1', name: 'Derivative', statement: 'The derivative of f at x is the limit of difference quotients.', passage: 'T1' },
    { id: 'p2', name: 'Chain rule', statement: '(f∘g)\' = (f\'∘g)·g\'.', passage: 'T3' },
    { id: 'p3', name: 'Rates compose', statement: 'Rates of change of composed functions multiply.', passage: 'T3' },
  ],
  chains: [{ premises: ['p1', 'p3'], conclusion: 'p2' }],
})

describe('knowledge extraction', () => {
  it('extracts teacher prose once, links re-encounters and records provenance', async () => {
    const env = setup()
    session(env, 'lsn_1', 'Chain rule', ['A derivative is a limit of difference quotients.', 'When functions compose, their rates multiply: that is the chain rule.'])
    const model = fakeModel({
      'graph.extract': ['not json at all', FIRST, JSON.stringify({ propositions: [{ id: 'p1', name: 'Derivative as limit', statement: 'f\'(x) is the limit of (f(x+h)−f(x))/h as h→0.', passage: 'T5' }, { id: 'p2', name: 'Power rule', statement: 'd/dx x^n = n x^(n−1).', passage: 'T5' }], chains: [{ premises: ['p1'], conclusion: 'p2' }] })],
      'graph.audit': ['{"links": [{"id": "p1", "linkTo": "n_1"}]}'],
    })
    const clock = manualClock(new Date('2026-10-28T10:00:00.000Z'))
    const knowledge = new KnowledgeService({ graph: env.graph, learn: env.learnRepo, model: () => model, logger: silent, clock, ids: sequentialIds(), budget: { minUncoveredChars: 10 } })

    const first = await knowledge.extractSession(env.learner, 'lsn_1')
    expect(first).toEqual({ status: 'done', batches: 1, stats: { propositions: 3, linked: 0, chains: 1, droppedChains: 0 } })
    expect(model.requests.map(r => r.purpose)).toEqual(['graph.extract', 'graph.extract'])
    expect(model.requests[0]?.prompt).toContain('[T1]\nA derivative is a limit')
    expect(model.requests[0]?.prompt).not.toContain('SECRET LEARNER NOTE')
    expect(model.requests[1]?.prompt).toContain('Your previous reply was rejected')
    expect(knowledge.uncovered('lsn_1')).toBe(0)
    expect(await knowledge.extractSession(env.learner, 'lsn_1')).toMatchObject({ status: 'nothing-to-do' })

    session(env, 'lsn_2', 'Power rule', ['The derivative is defined as a limit; from it the power rule follows.'])
    const second = await knowledge.extractSession(env.learner, 'lsn_2')
    expect(second).toMatchObject({ status: 'done', stats: { propositions: 1, linked: 1, chains: 1 } })
    expect(model.requests.at(-1)?.purpose).toBe('graph.audit')
    expect(model.requests.at(-1)?.prompt).toContain('n_1 | Derivative | The derivative of f at x')

    const snapshot = knowledge.snapshot(env.learner)
    const derivative = snapshot.propositions.find(p => p.id === 'n_1')
    expect(derivative?.name).toBe('Derivative')
    expect(derivative?.aliases).toContain('f\'(x) is the limit of (f(x+h)−f(x))/h as h→0.')
    expect(derivative?.provenance).toEqual([{ sourceId: 'lsn_1', anchor: 1 }, { sourceId: 'lsn_2', anchor: 5 }])
    expect(snapshot.clusters).toEqual([{ sourceId: 'lsn_1', label: 'Chain rule', members: ['n_1', 'n_2', 'n_3'] }])
    expect(snapshot.sources.map(s => s.title)).toEqual(['Chain rule', 'Power rule'])
    expect(snapshot.chains.map(c => c.premises.length)).toEqual([2, 1])

    expect(env.graph.removeSource(env.learner, 'lsn_2', 'delete-nodes')).toEqual({ propositions: 1, chains: 1 })
    const after = knowledge.snapshot(env.learner)
    expect(after.propositions.map(p => p.id)).toEqual(['n_1', 'n_2', 'n_3'])
    expect(after.propositions[0]?.provenance).toEqual([{ sourceId: 'lsn_1', anchor: 1 }])

    expect(knowledge.deleteProposition(env.learner, 'n_3')).toEqual({ propositions: 1, chains: 1 })
    expect(knowledge.snapshot(env.learner).chains).toEqual([])
    expect(() => knowledge.deleteProposition(env.other, 'n_1')).toThrow(HodosError)
  })

  it('security: stops at the daily budget without marking the stretch covered', async () => {
    const env = setup()
    session(env, 'lsn_1', 'Limits', ['Limits describe behaviour near a point, not at it.'])
    const model = fakeModel({ 'graph.extract': ['{}', '{}', '{}'] })
    const knowledge = new KnowledgeService({ graph: env.graph, learn: env.learnRepo, model: () => model, logger: silent, ids: sequentialIds(), budget: { callsPerDay: 1, minUncoveredChars: 10 } })
    const result = await knowledge.extractSession(env.learner, 'lsn_1')
    expect(result.status).toBe('budget')
    expect(model.requests).toHaveLength(1)
    expect(knowledge.uncovered('lsn_1')).toBeGreaterThan(0)
  })

  it('security: refuses sessions of other learners and runs one extraction per learner at a time', async () => {
    const env = setup()
    session(env, 'lsn_1', 'Limits', ['Limits describe behaviour near a point.'])
    const opened: Array<() => void> = []
    const gate = new Promise<void>(resolve => { opened.push(resolve) })
    const model: ModelPort = { complete: async () => { await gate; return { text: '{"propositions": [], "chains": []}' } } }
    const knowledge = new KnowledgeService({ graph: env.graph, learn: env.learnRepo, model: () => model, logger: silent, ids: sequentialIds() })
    await expect(knowledge.extractSession(env.other, 'lsn_1', { force: true })).rejects.toThrow(/no such learning session/)
    const running = knowledge.extractSession(env.learner, 'lsn_1', { force: true })
    expect((await knowledge.extractSession(env.learner, 'lsn_1', { force: true })).status).toBe('busy')
    for (const open of opened) open()
    expect((await running).status).toBe('done')
    expect((await new KnowledgeService({ graph: env.graph, learn: env.learnRepo, model: () => null, logger: silent }).extractSession(env.learner, 'lsn_1', { force: true })).status).toBe('unavailable')
  })

  it('imports notes in chunks under one stable source', async () => {
    const env = setup()
    const model = fakeModel({ 'graph.extract': [notesReply(1), notesReply(2)], 'graph.audit': ['{"links": []}'] })
    const knowledge = new KnowledgeService({ graph: env.graph, learn: env.learnRepo, model: () => model, logger: silent, ids: sequentialIds(), budget: { batchChars: 60 } })
    const notes = `${'First paragraph about sets. '.repeat(2)}\n\n${'Second paragraph about maps. '.repeat(2)}`
    const imported = await knowledge.importNotes(env.learner, 'algebra.md', notes)
    expect(imported.result).toMatchObject({ status: 'done', batches: 2 })
    expect(model.requests[1]?.prompt).toContain('THE GRAPH SO FAR')
    const again = await knowledge.importNotes(env.learner, 'algebra.md', notes)
    expect(again).toEqual({ sourceId: imported.sourceId, result: { status: 'nothing-to-do', batches: 0, stats: { propositions: 0, linked: 0, chains: 0, droppedChains: 0 } } })
    expect(knowledge.snapshot(env.learner).sources).toEqual([{ id: imported.sourceId, kind: 'notes', title: 'algebra.md' }])
  })
})

async function practiceEnv() {
  const env = setup()
  session(env, 'lsn_1', 'Chain rule', ['A derivative is a limit.', 'Rates multiply under composition.'])
  const model = fakeModel({ 'graph.extract': [FIRST] })
  const knowledge = new KnowledgeService({ graph: env.graph, learn: env.learnRepo, model: () => model, logger: silent, ids: sequentialIds(), budget: { minUncoveredChars: 1 } })
  await knowledge.extractSession(env.learner, 'lsn_1')
  const practice = new PracticeService({ store: env.store, graph: env.graph, ids: sequentialIds() })
  return { env, practice }
}

describe('practice sessions', () => {
  it('security: poses one problem at a time and releases the solution only when concluded', async () => {
    const { env, practice } = await practiceEnv()
    expect(() => practice.start(env.learner, { targets: ['n_99'], hostSessionId: null })).toThrow(/not in your graph/)
    const s = practice.start(env.learner, { targets: ['n_1', 'n_2', 'n_3'], hostSessionId: 'chat-p' })
    expect(s.title).toBe('Derivative, Chain rule, Rates compose')
    expect(practice.tutorContext(s.id)).toContain('- Derivative, Rates compose → Chain rule')

    expect(() => practice.pose(s.id, { statement: 'Differentiate sin(3x).', mode: 'guessing', modelSolution: '3cos(3x)', target: ['n_77'] })).toThrow(/mode must be one of recall, discrimination, composition; target "n_77" is not a proposition/)
    const p = practice.pose(s.id, { statement: 'Differentiate sin(3x).', mode: 'recall', modelSolution: 'Outer cos(3x) times inner 3: 3cos(3x).', target: ['Chain rule'] })
    expect(p.targets).toEqual(['n_2'])
    expect(() => practice.pose(s.id, { statement: 'Next', mode: 'recall', modelSolution: 'x' })).toThrow(/already active/)

    const open = practice.view(env.learner, s.id).problems[0]
    expect(open).toMatchObject({ status: 'active', statement: 'Differentiate sin(3x).' })
    expect(JSON.stringify(open)).not.toContain('Outer cos')

    expect(practice.submitThinking(env.learner, p.id, 'cos(3x)?').message).toBe(`Your thinking (problem ${p.id}):\ncos(3x)?`)
    expect(() => practice.submitThinking(env.other, p.id, 'x')).toThrow(/no such practice session/)
    const done = practice.conclude(s.id, { outcome: 'solvedWithHints', verdict: 'Found the outer derivative; needed a nudge for the inner factor.', rung: 'R1', missClass: 'null', retest: 'true' })
    expect(done.conclusion).toEqual({ outcome: 'solvedWithHints', verdict: 'Found the outer derivative; needed a nudge for the inner factor.', rung: 'R1', missClass: null, retest: true })
    const concluded = practice.view(env.learner, s.id).problems[0]
    expect(concluded).toMatchObject({ status: 'concluded', modelSolution: 'Outer cos(3x) times inner 3: 3cos(3x).', thinking: [{ text: 'cos(3x)?' }] })
    expect(() => practice.conclude(s.id, { outcome: 'solved', verdict: 'x' })).toThrow(/no problem is active/)
    expect(practice.tutorContext(s.id)).toContain('Concluded recall problem on n_2: solvedWithHints, needed R1, retest')
  })

  it('lets the learner dismiss a problem and refuses the tutor the dismissed outcome', async () => {
    const { env, practice } = await practiceEnv()
    const s = practice.start(env.learner, { targets: [], hostSessionId: null })
    expect(s.title).toBe('Practice')
    const p = practice.pose(s.id, { statement: 'Explain why limits matter.', mode: 'composition', modelSolution: 'Because…' })
    expect(() => practice.conclude(s.id, { outcome: 'dismissed', verdict: 'x' })).toThrow(/outcome must be one of solved/)
    expect(practice.dismiss(env.learner, p.id).message).toMatch(/dismissed problem/)
    expect(practice.view(env.learner, s.id).problems[0]?.conclusion?.outcome).toBe('dismissed')
    practice.close(env.learner, s.id)
    expect(() => practice.pose(s.id, { statement: 'x', mode: 'recall', modelSolution: 'y' })).toThrow(/closed/)
  })
})
