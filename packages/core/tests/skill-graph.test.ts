import { describe, expect, it } from 'vitest'
import type { SkillSpec } from '@hodos/plugin-sdk'
import {
  HodosError,
  SkillGraph,
  validateSkillGraph,
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
    const codes = validateSkillGraph(bad).map(f => f.code).toSorted()
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
