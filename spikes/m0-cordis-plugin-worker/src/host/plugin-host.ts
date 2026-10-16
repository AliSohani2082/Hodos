// The INTERNAL plugin-host interface (ALI-51). The rest of the platform talks to this, never to cordis.
// Rule: no import of 'cordis' (or any cordis package) in this file, in src/sdk/, or in anything the platform core imports.
// Two implementations ship in the spike: cordis-adapter.ts and map-adapter.ts. Both pass the same conformance suite.
import type { BlockSpec, Diagnostic, ExerciseKindSpec, GradeContext, GradeResult, Item, Json, LayoutSpec, LessonNode, PluginModule, PresetSpec, ValidationContext } from '../sdk/types.ts'

export type Trust = 'first-party' | 'sandboxed'

/** Where a registered contribution came from. `trust` is decided by the platform when it calls loadFirstParty/loadSandboxed, never read from a plugin. */
export interface Origin { pluginId: string; trust: Trust; scope: string }

/**
 * Hooks as the platform sees them: ALWAYS async, whatever the plugin wrote. A sandboxed plugin's hook is an RPC;
 * making the platform contract async for both keeps first-party and sandboxed plugins interchangeable and lets the host add timeouts.
 */
export interface ResolvedBlock extends Origin {
  name: string; version: number; kind: BlockSpec['kind']; body: BlockSpec['body']; attrs: Json
  guidance: BlockSpec['guidance']; renderer: BlockSpec['renderer']; fallbackMode: BlockSpec['fallback']['mode']
  validate(node: LessonNode, ctx: ValidationContext): Promise<Diagnostic[]>
  fallbackText(node: LessonNode): Promise<string>
}
export interface ResolvedLayout extends Origin { name: string; spec: LayoutSpec }
export interface ResolvedExerciseKind extends Origin {
  name: string; version: number; kinds: string[]; responseKind: ExerciseKindSpec['responseKind']; grader: ExerciseKindSpec['grader']
  supports: ExerciseKindSpec['supports']; itemSchema: Json; ui: ExerciseKindSpec['ui']
  validateItem(item: Item): Promise<Diagnostic[]>
  /** Result is EVIDENCE: already shape-checked and clamped by the host. Estimators and gates stay in the platform. */
  grade(item: Item, response: Json, ctx: GradeContext): Promise<GradeResult>
}
export interface ResolvedPreset extends Origin { name: string; spec: PresetSpec }

/** Read side: what the platform's validator, prompt assembler and renderer ask for. Per scope (one scope per course). */
export interface HostRegistry {
  blocks(): ReadonlyMap<string, ResolvedBlock>
  layouts(): ReadonlyMap<string, ResolvedLayout>
  exerciseKinds(): ReadonlyMap<string, ResolvedExerciseKind>
  presets(): ReadonlyMap<string, ResolvedPreset>
}

/** What a sandboxed plugin's worker must provide. `Sandbox` in sandboxes.ts satisfies it structurally. */
export interface PluginWorker {
  start(): Promise<{ manifest: WorkerManifest }>
  call(hook: string, args: Json[]): Promise<{ ok: true; result: Json } | { ok: false; kind: string; message: string }>
  stop(): Promise<void>
}
/** Data-only description returned by the worker's `apply()`: everything but the functions, plus the names of the hooks it holds. */
export interface WorkerManifest {
  name: string
  blocks: (Omit<BlockSpec, 'validate' | 'fallback' | 'speakable'> & { id: string; fallback: { mode: BlockSpec['fallback']['mode'] }; hooks: string[] })[]
  layouts: (LayoutSpec & { id: string; hooks: string[] })[]
  exerciseKinds: (Omit<ExerciseKindSpec, 'validateItem' | 'grade'> & { id: string; hooks: string[] })[]
  presets: (PresetSpec & { id: string; hooks: string[] })[]
}

export type PluginState = 'pending' | 'active' | 'failed' | 'disposed'
export interface PluginHandle {
  readonly id: string
  readonly state: PluginState
  readonly error: Error | undefined
  /** Resolves when the plugin is active or failed. Never rejects: inspect state/error. */
  settled(): Promise<PluginState>
  /** Unregister everything the plugin added, stop its worker, resolve when nothing is left behind. Idempotent. */
  dispose(): Promise<void>
  /** Re-apply with new config. Old registrations are removed first. */
  update(config: unknown): Promise<PluginState>
}

export type HostEvent = { type: 'registered' | 'unregistered'; kind: 'block' | 'layout' | 'exercise' | 'preset'; name: string; pluginId: string; scope: string }

export interface PluginHost {
  readonly registry: HostRegistry
  /** A child host for one course: its own registries, same plugin code. Disposing the parent disposes the scope. */
  scope(scopeId: string): Promise<PluginHost>
  /** In-process. Only for plugins on the platform's first-party allowlist. */
  loadFirstParty(id: string, plugin: PluginModule, config?: unknown): PluginHandle
  /** The plugin's code never runs in this process: `worker` holds it. The host registers data plus RPC stubs. */
  loadSandboxed(id: string, worker: PluginWorker, config?: unknown): PluginHandle
  onEvent(listener: (e: HostEvent) => void): () => void
  dispose(): Promise<void>
}

export class HookError extends Error {
  constructor(public hook: string, public kind: string, message: string) { super(`${hook}: ${kind}: ${message}`); this.name = 'HookError' }
}
