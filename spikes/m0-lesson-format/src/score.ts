// Per-generation scoring (§8.5). Everything is recomputed from the stored round texts, so scoring rules can be
// refined without re-spending API money.
import { markers } from './markers.ts'
import { blocksOf } from './shared-validate.ts'
import { contextFor } from './tasks.ts'
import { validateLesson } from './validate.ts'
import type { Arm, Diagnostic, LNode, Model, Task } from './types.ts'

export interface Usage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** Reasoning tokens included in `output` (from output_tokens_details), when the API reports them. */
  thinking?: number
  /** Exact per-request USD cost returned by OpenRouter. */
  costUSD?: number
}

export interface RoundRecord {
  kind: 'generate' | 'repair'
  text: string
  stopReason: string | null
  usage: Usage
  costUSD: number
  ms: number
}

export interface GenRecord {
  key: string
  run: string
  model: Model
  arm: Arm
  taskId: string
  sample: number
  /** ok = finished; budget = stopped by the budget guard (excluded from statistics); error = API failure. */
  status: 'ok' | 'budget' | 'error'
  error?: string
  rounds: RoundRecord[]
  costUSD: number
  /** Visible output tokens of the final lesson (count_tokens), when measured. */
  visibleTokens?: number
}

export const MAX_REPAIRS = 3

export interface Scores {
  m1: number // first-pass valid
  m2: number // final valid (within MAX_REPAIRS repairs)
  m3: number // repair rounds to green (failure counts as MAX_REPAIRS)
  m4: number // dropped block, unreported by the validator (final text)
  m4silent: number // dropped block regardless of whether the validator reported it (final text)
  m5first: number // no semantic diagnostics on the first pass
  m6first: number // emitted a block outside the allowed set on the first pass
  m7: number // visible output tokens of the final lesson (estimated if not measured)
  checklist: number // fraction of checklist items met by the final lesson
  literals: number // fraction of literal checks passed (1 if none)
  nesting: number // 1 if the required nesting exists or none is required
  firstDiagnostics: number
}

const countAst = (nodes: LNode[]) => {
  const c = new Map<string, number>()
  for (const b of blocksOf(nodes)) c.set(b.type, (c.get(b.type) ?? 0) + 1)
  return c
}

function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out))
  return out
}

function proseText(nodes: LNode[], types: string[]): string[] {
  const out: string[] = []
  const walk = (ns: LNode[]) => {
    for (const n of ns) {
      if (n.kind === 'prose' && types.includes(n.type) && n.text !== undefined) out.push(n.text)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/** All prose text, with adjacent text nodes of a paragraph joined (so a restored ":1" rejoins "3"). */
function flowText(nodes: LNode[]): string[] {
  const out: string[] = []
  const inline = (ns: LNode[]): string => ns.map((n) => (n.type === 'text' || n.type === 'code' ? n.text ?? '' : inline(n.children))).join('')
  const walk = (ns: LNode[]) => {
    for (const n of ns) {
      if (n.kind === 'prose' && (n.type === 'paragraph' || n.type === 'heading')) out.push(inline(n.children))
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

function hasNesting(nodes: LNode[], chain: string[]): boolean {
  const walk = (ns: LNode[], need: number): boolean => {
    for (const n of ns) {
      const next = n.type === chain[need] ? need + 1 : need
      if (next === chain.length) return true
      if (walk(n.children, next)) return true
    }
    return false
  }
  return walk(nodes, 0)
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export function estimateTokens(text: string): number {
  return Math.round(text.length / 3.6)
}

export function scoreGeneration(rec: GenRecord, task: Task): Scores {
  const ctx = contextFor(task)
  const rounds = rec.rounds.slice(0, MAX_REPAIRS + 1)
  const results = rounds.map((r) => ({ r, v: validateLesson(rec.arm, r.text, ctx) }))
  const usable = (i: number) => {
    const x = results[i]
    return !!x && x.v.valid && x.r.stopReason !== 'max_tokens' && x.r.stopReason !== 'refusal'
  }
  const firstValid = results.findIndex((_, i) => usable(i))
  const first = results[0]!
  const final = results[results.length - 1]!

  // M4: markers in the text vs blocks in the AST, for blocks on the gold checklist.
  const mk = markers(rec.arm, final.r.text)
  const ast = countAst(final.v.doc.children)
  let m4 = 0
  let m4silent = 0
  for (const item of task.checklist) {
    const lines = mk.filter((m) => m.name === item.block).map((m) => m.line)
    if (lines.length > (ast.get(item.block) ?? 0)) {
      m4silent = 1
      const reported = final.v.diagnostics.some(
        (d: Diagnostic) => d.block === item.block || lines.some((l) => d.line !== undefined && Math.abs(d.line - l) <= 1),
      )
      if (!reported) m4 = 1
    }
  }

  const doc = final.v.doc
  const checks = task.checklist.map((c) => (ast.get(c.block) ?? 0) >= c.min)
  const codeStrings = proseText(doc.children, ['fence', 'code'])
  const flow = flowText(doc.children).map(norm)
  const blocks = blocksOf(doc.children)
  const lits = (task.literals ?? []).map((l) => {
    const want = norm(l.value)
    if (l.where === 'code') return codeStrings.some((s) => norm(s).includes(want))
    if (l.where === 'text') return flow.some((s) => s.includes(want))
    return blocks.some((b) => (!l.block || b.type === l.block) && allStrings(l.attr ? b.attrs[l.attr] : b.attrs).some((s) => norm(s) === want))
  })

  const m7 = rec.visibleTokens ?? estimateTokens(final.r.text)
  return {
    m1: usable(0) ? 1 : 0,
    m2: firstValid >= 0 ? 1 : 0,
    m3: firstValid >= 0 ? firstValid : MAX_REPAIRS,
    m4,
    m4silent,
    m5first: first.v.diagnostics.some((d) => d.stage === 'semantic') ? 0 : 1,
    m6first: first.v.diagnostics.some((d) => d.id === 'disallowed-block' || d.id === 'unknown-block') ? 1 : 0,
    m7,
    checklist: checks.length ? checks.filter(Boolean).length / checks.length : 1,
    literals: lits.length ? lits.filter(Boolean).length / lits.length : 1,
    nesting: task.nesting ? (hasNesting(doc.children, task.nesting) ? 1 : 0) : 1,
    firstDiagnostics: first.v.diagnostics.length,
  }
}
