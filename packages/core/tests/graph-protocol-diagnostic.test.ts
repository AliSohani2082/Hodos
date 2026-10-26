import { describe, expect, it } from 'vitest'
import type { SkillSpec } from '@hodos/plugin-sdk'
import {
  DEFAULT_DIAGNOSTIC_CONFIG,
  Diagnostic,
  HodosError,
  SkillGraph,
  chooseStrategy,
  initialJourneyState,
  replayJourney,
  seededRandom,
  transition,
  validateSkillGraph,
  type DiagnosticConfig,
  type DiagnosticNode,
  type JourneyState,
} from '../src/index.js'

const skills: SkillSpec[] = [
  { id: 'rules', title: 'Rules', kind: 'fact' },
  { id: 'check', title: 'Check', kind: 'concept', requires: ['rules'] },
  { id: 'fork', title: 'Fork', kind: 'pattern', requires: ['check'] },
  { id: 'pin', title: 'Pin', kind: 'pattern', requires: ['rules'] },
  { id: 'tactics', title: 'Tactics', kind: 'judgment', requires: ['fork', 'pin'] },
]

describe('skill graph validation', () => {
  it('accepts a valid DAG and orders prerequisites first', () => {
    expect(validateSkillGraph(skills)).toEqual([])
    const g = new SkillGraph(skills)
    // Authoring order is kept wherever prerequisites allow it.
    expect(g.skills.map(s => s.id)).toEqual(['rules', 'check', 'fork', 'pin', 'tactics'])
    expect(g.ancestors('tactics')).toEqual(['rules', 'check', 'fork', 'pin'])
    expect(g.descendants('check')).toEqual(['fork', 'tactics'])
    expect(g.depth('tactics')).toBe(3)
  })

  it('reports cycles with their path', () => {
    const cyclic: SkillSpec[] = [
      { id: 'aa', title: 'A', kind: 'concept', requires: ['cc'] },
      { id: 'bb', title: 'B', kind: 'concept', requires: ['aa'] },
      { id: 'cc', title: 'C', kind: 'concept', requires: ['bb'] },
    ]
    const findings = validateSkillGraph(cyclic)
    expect(findings.map(f => f.code)).toEqual(['graph/cycle'])
    expect(findings[0]?.message).toBe('prerequisites form a cycle: aa -> cc -> bb -> aa')
    expect(() => new SkillGraph(cyclic)).toThrowError(HodosError)
  })

  it('reports unknown prerequisites, duplicates, self-loops, bad kinds and ids', () => {
    const bad = [
      { id: 'aa', title: 'A', kind: 'concept', requires: ['missing', 'aa'] },
      { id: 'aa', title: 'A again', kind: 'concept' },
      { id: 'bb', title: 'B', kind: 'wizardry' },
      { id: 'Bad Id', title: 'C', kind: 'fact' },
    ] as unknown as SkillSpec[]
    const codes = validateSkillGraph(bad).map(f => f.code).sort()
    expect(codes).toEqual(['graph/bad-id', 'graph/bad-kind', 'graph/duplicate', 'graph/self-loop', 'graph/unknown-prerequisite'])
  })

  it('computes the frontier and plans a path that skips known skills', () => {
    const g = new SkillGraph(skills)
    expect(g.frontier(new Set())).toEqual(['rules'])
    expect(g.frontier(new Set(['rules']))).toEqual(['check', 'pin'])
    expect(g.planPath('tactics', new Set(['rules', 'check']))).toEqual(['fork', 'pin', 'tactics'])
    expect(g.planPath('fork', new Set(['rules', 'check', 'fork']))).toEqual([])
  })
})

describe('learning protocol state machine', () => {
  const approved = (): JourneyState => replayJourney(initialJourneyState(true), [
    { type: 'DIAGNOSTIC_COMPLETED', known: ['rules'] },
    { type: 'PATH_PROPOSED', path: ['fork', 'pin'] },
    { type: 'PATH_APPROVED' },
  ])

  it('walks goal → diagnostic → planning → teach → practice → checkpoint → next skill → complete', () => {
    let s = approved()
    expect(s).toMatchObject({ phase: 'learning', activeSkill: 'fork', stage: 'teach', diagnosedKnown: ['rules'] })
    s = transition(s, { type: 'LESSON_COMPLETED' })
    s = transition(s, { type: 'CHECKPOINT_STARTED' })
    s = transition(s, { type: 'CHECKPOINT_PASSED' })
    expect(s).toMatchObject({ activeSkill: 'pin', stage: 'teach', completed: ['fork'] })
    s = replayJourney(s, [{ type: 'LESSON_COMPLETED' }, { type: 'CHECKPOINT_STARTED' }, { type: 'CHECKPOINT_PASSED' }])
    expect(s).toMatchObject({ phase: 'complete', activeSkill: null, completed: ['fork', 'pin'] })
  })

  it('a failed checkpoint adapts and remediates instead of advancing', () => {
    let s = replayJourney(approved(), [{ type: 'LESSON_COMPLETED' }, { type: 'CHECKPOINT_STARTED' }, { type: 'CHECKPOINT_FAILED' }])
    expect(s).toMatchObject({ activeSkill: 'fork', stage: 'adapt' })
    expect(() => transition(s, { type: 'CHECKPOINT_PASSED' })).toThrowError(/cannot apply CHECKPOINT_PASSED/)
    s = transition(s, { type: 'ADAPTATION_APPLIED' })
    expect(s).toMatchObject({ activeSkill: 'fork', stage: 'remedial', adaptations: { fork: 1 } })
    s = transition(s, { type: 'REMEDIAL_COMPLETED' })
    expect(s.stage).toBe('practice')
  })

  it('an adaptation can insert a weak prerequisite ahead of the active skill', () => {
    const s = replayJourney(approved(), [
      { type: 'LESSON_COMPLETED' }, { type: 'CHECKPOINT_STARTED' }, { type: 'CHECKPOINT_FAILED' },
      { type: 'ADAPTATION_APPLIED', insertBefore: ['check'] },
    ])
    expect(s).toMatchObject({ activeSkill: 'check', stage: 'teach', path: ['check', 'fork', 'pin'] })
  })

  it('rejects out-of-order events', () => {
    const fresh = initialJourneyState(true)
    expect(() => transition(fresh, { type: 'PATH_APPROVED' })).toThrowError(HodosError)
    expect(() => transition(approved(), { type: 'REMEDIAL_COMPLETED' })).toThrowError(/INVALID_STATE|cannot apply/)
    const inCheckpoint = replayJourney(approved(), [{ type: 'LESSON_COMPLETED' }, { type: 'CHECKPOINT_STARTED' }])
    expect(() => transition(inCheckpoint, { type: 'REVIEW_STARTED' })).toThrowError(HodosError)
    expect(() => transition(fresh, { type: 'DIAGNOSTIC_SKIPPED' })).not.toThrow()
  })

  it('reviews return to the phase they interrupted', () => {
    const s = replayJourney(approved(), [{ type: 'REVIEW_STARTED' }])
    expect(s.phase).toBe('reviewing')
    expect(transition(s, { type: 'REVIEW_COMPLETED' })).toMatchObject({ phase: 'learning', activeSkill: 'fork' })
  })
})

function layeredDag(n: number, layers: number, rng: () => number): DiagnosticNode[] {
  const layerOf: number[] = []
  const nodes: DiagnosticNode[] = []
  for (let i = 0; i < n; i++) {
    const layer = Math.floor((i * layers) / n)
    layerOf.push(layer)
    const prev = layerOf.map((l, j) => ({ l, j })).filter(x => x.l === layer - 1).map(x => x.j)
    const requires = new Set<string>()
    if (prev.length > 0) {
      requires.add(`n${prev[Math.floor(rng() * prev.length)]}`)
      if (rng() < 0.5) requires.add(`n${prev[Math.floor(rng() * prev.length)]}`)
    }
    nodes.push({ id: `n${i}`, requires: [...requires], askable: true })
  }
  return nodes
}

function closure(nodes: DiagnosticNode[], raw: Set<string>): Set<string> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const ok = (id: string): boolean => raw.has(id) && (byId.get(id)?.requires ?? []).every(ok)
  return new Set(nodes.map(n => n.id).filter(ok))
}

describe('diagnostic', () => {
  const base = (strategy: DiagnosticConfig['strategy'], seed = 7): DiagnosticConfig => ({
    ...DEFAULT_DIAGNOSTIC_CONFIG, strategy, seed, priors: {}, particles: 1500,
  })

  it('half-split classifies most skills correctly within the question budget (simulation)', () => {
    const rng = seededRandom(42)
    const accuracies: number[] = []
    const questions: number[] = []
    for (let run = 0; run < 12; run++) {
      const nodes = layeredDag(30, 5, () => rng.next())
      const truth = closure(nodes, new Set(nodes.filter((_, i) => i < 8 + run).map(n => n.id)))
      const d = new Diagnostic(nodes, base('halfsplit', 100 + run))
      while (!d.isComplete()) {
        const skill = d.nextSkill()
        if (skill === null) break
        const knows = truth.has(skill)
        const correct = knows ? rng.next() > 0.1 : rng.next() < 0.2
        d.observe(skill, correct ? 'correct' : 'wrong')
      }
      const est = d.estimate()
      const known = new Set(est.known)
      accuracies.push(nodes.filter(n => known.has(n.id) === truth.has(n.id)).length / nodes.length)
      questions.push(est.questions)
    }
    const meanAccuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length
    expect(meanAccuracy).toBeGreaterThan(0.85)
    expect(Math.max(...questions)).toBeLessThanOrEqual(25)
    expect(Math.min(...questions)).toBeGreaterThanOrEqual(5)
  })

  it('is reconstructed exactly from its answer log after a restart', () => {
    const nodes = layeredDag(12, 4, () => 0.3)
    const config = base('halfsplit', 99)
    const live = new Diagnostic(nodes, config)
    const answers = ['correct', 'wrong', 'dont-know', 'correct'] as const
    for (const a of answers) {
      const s = live.nextSkill()
      if (s !== null) live.observe(s, a)
    }
    const restored = new Diagnostic(nodes, config, live.observations)
    expect(restored.marginals()).toEqual(live.marginals())
    expect(restored.nextSkill()).toBe(live.nextSkill())
  })

  it('"I don\'t know" lowers the estimate more than a wrong answer would allow guessing', () => {
    const nodes: DiagnosticNode[] = layeredDag(8, 3, () => 0.5)
    const a = new Diagnostic(nodes, base('halfsplit', 5))
    const b = new Diagnostic(nodes, base('halfsplit', 5))
    a.observe('n7', 'dont-know')
    b.observe('n7', 'wrong')
    expect(a.marginals().n7).toBeLessThanOrEqual(b.marginals().n7 ?? 1)
  })

  it('self-reported priors are weak: wrong answers override them', () => {
    const nodes = layeredDag(10, 3, () => 0.4)
    const d = new Diagnostic(nodes, { ...base('halfsplit', 11), priors: { n9: 0.95 } })
    const before = d.marginals().n9 ?? 0
    d.observe('n9', 'wrong')
    d.observe('n9', 'dont-know')
    expect(d.marginals().n9).toBeLessThan(before)
    expect(d.estimate().known).not.toContain('n9')
  })

  it('never classifies a skill as known from a self-report alone', () => {
    const nodes = layeredDag(10, 3, () => 0.4)
    const d = new Diagnostic(nodes, { ...base('halfsplit', 13), priors: { n0: 0.99, n1: 0.99, n2: 0.99 } })
    expect(d.estimate().known).toEqual([])
    const small = new Diagnostic(nodes.slice(0, 3).map(n => ({ ...n, requires: [] })), { ...base('propagation'), priors: { n0: 0.99 } })
    expect(small.estimate().known).toEqual([])
  })

  it('falls back to propagation for small scopes', () => {
    const chain: DiagnosticNode[] = [
      { id: 'a', requires: [], askable: true },
      { id: 'b', requires: ['a'], askable: true },
      { id: 'c', requires: ['b'], askable: true },
    ]
    expect(chooseStrategy(chain)).toBe('propagation')
    const d = new Diagnostic(chain, base('propagation'))
    expect(d.nextSkill()).toBe('b')
    d.observe('b', 'correct')
    expect(d.estimate().known).toEqual(['a', 'b'])
    expect(d.nextSkill()).toBe('c')
    d.observe('c', 'dont-know')
    expect(d.isComplete()).toBe(true)
    expect(d.estimate().known).toEqual(['a', 'b'])
  })

  it('stops on fatigue after repeated "I don\'t know"', () => {
    const d = new Diagnostic(layeredDag(20, 4, () => 0.6), base('halfsplit', 3))
    for (let i = 0; i < 3; i++) {
      const s = d.nextSkill()
      if (s !== null) d.observe(s, 'dont-know')
    }
    expect(d.isComplete()).toBe(true)
  })
})
