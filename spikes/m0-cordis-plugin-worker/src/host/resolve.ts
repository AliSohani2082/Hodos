// Shared by both adapters (no cordis here): turns SDK specs into the platform's async `Resolved*` entries and builds the plugin-facing facade.
// First-party: hooks are the plugin's own functions, wrapped to be async. Sandboxed: hooks are RPCs to the worker, with the result validated.
import type { BlockSpec, Disposer, ExerciseKindSpec, Json, LayoutSpec, PluginContext, PresetSpec } from '../sdk/types.ts'
import { HookError, type Origin, type PluginWorker, type ResolvedBlock, type ResolvedExerciseKind, type ResolvedLayout, type ResolvedPreset, type WorkerManifest } from './plugin-host.ts'
import { parseDiagnostics, parseFallbackText, parseGradeResult } from './validate-result.ts'

export type EntryMap = { block: ResolvedBlock; layout: ResolvedLayout; exercise: ResolvedExerciseKind; preset: ResolvedPreset }
export type Register = <K extends keyof EntryMap>(kind: K, entry: EntryMap[K]) => Disposer
export type Effect = (fn: () => Disposer | void) => Disposer

const rpc = async <T>(w: PluginWorker, hook: string, args: Json[], parse: (x: unknown) => T): Promise<T> => {
  const r = await w.call(hook, args)
  if (!r.ok) throw new HookError(hook, r.kind, r.message)
  return parse(r.result)
}

// ---- first-party (in-process) ----
const block = (o: Origin, s: BlockSpec): ResolvedBlock => ({
  ...o, name: s.name, version: s.version, kind: s.kind, body: s.body, attrs: s.attrs, guidance: s.guidance, renderer: s.renderer, fallbackMode: s.fallback.mode,
  validate: async (n, c) => (s.validate ? s.validate(n, c) : []),
  fallbackText: async (n) => s.fallback.text(n),
})
const kind = (o: Origin, s: ExerciseKindSpec): ResolvedExerciseKind => ({
  ...o, name: s.name, version: s.version, kinds: s.kinds, responseKind: s.responseKind, grader: s.grader, supports: s.supports, itemSchema: s.itemSchema, ui: s.ui,
  validateItem: async (i) => (s.validateItem ? s.validateItem(i) : []),
  grade: async (i, r, c) => parseGradeResult(await s.grade(i, r, c)), // even first-party results go through the same shape check
})

export function makeFacade(o: Origin, register: Register, effect: Effect): PluginContext {
  return {
    lesson: { block: (s) => register('block', block(o, s)), layout: (s: LayoutSpec) => register('layout', { ...o, name: s.name, spec: s }) },
    exercise: { kind: (s) => register('exercise', kind(o, s)) },
    pedagogy: { preset: (s: PresetSpec) => register('preset', { ...o, name: s.name, spec: s }) },
    effect,
  }
}

// ---- sandboxed (RPC) ----
export function applyManifest(o: Origin, w: PluginWorker, m: WorkerManifest, register: Register): void {
  for (const b of m.blocks) {
    const { id, hooks, fallback, ...data } = b
    register('block', {
      ...o, name: data.name, version: data.version, kind: data.kind, body: data.body, attrs: data.attrs, guidance: data.guidance, renderer: data.renderer, fallbackMode: fallback.mode,
      validate: async (n, c) => (hooks.includes('validate') ? rpc(w, `${id}#validate`, [n as unknown as Json, c as unknown as Json], parseDiagnostics) : []),
      fallbackText: async (n) => (hooks.includes('fallback.text') ? rpc(w, `${id}#fallback.text`, [n as unknown as Json], parseFallbackText) : ''),
    })
  }
  for (const l of m.layouts) { const { id, hooks, ...spec } = l; register('layout', { ...o, name: spec.name, spec }) }
  for (const k of m.exerciseKinds) {
    const { id, hooks, ...d } = k
    register('exercise', {
      ...o, name: d.name, version: d.version, kinds: d.kinds, responseKind: d.responseKind, grader: d.grader, supports: d.supports, itemSchema: d.itemSchema, ui: d.ui,
      validateItem: async (i) => (hooks.includes('validateItem') ? rpc(w, `${id}#validateItem`, [i as unknown as Json], parseDiagnostics) : []),
      grade: async (i, r, c) => rpc(w, `${id}#grade`, [i as unknown as Json, r, c as unknown as Json], parseGradeResult),
    })
  }
  for (const p of m.presets) { const { id, hooks, ...spec } = p; register('preset', { ...o, name: spec.name, spec }) }
}
