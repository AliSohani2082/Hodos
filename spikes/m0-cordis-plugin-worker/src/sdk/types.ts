// Public plugin SDK surface sketch (would become @hodos/plugin-sdk, MIT).
// RULE: nothing in this file may import 'cordis' or mention a cordis type. `scripts/check-no-leak.ts` enforces it.
// Shapes follow docs/research/lesson-ir.md section 4 and docs/research/intelligent-tutoring.md section 6.
// Simplified: JSONSchema7 is typed as Json, GradeResult/Item are trimmed to the fields the hooks touch,
// and Markdoc/renderer/materializer details are omitted because they never run in the plugin worker.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Disposer = () => void | Promise<void>

/** Parsed, schema-validated node. Everything the platform hands to plugin code is plain data. */
export interface LessonNode {
  id: string
  type: string
  attrs: Record<string, Json>
  children?: LessonNode[]
  text?: string
  span?: { lines: [number, number] }
}

export interface Diagnostic {
  level: 'error' | 'warning'
  id: string
  message: string
  nodeId?: string
  line?: number
}

export interface ValidationContext {
  /** Plain data only: no DB handle, no fetch, no secrets. */
  courseId: string
  locale: string
}

export interface BlockSpec {
  name: string
  version: number
  kind: 'leaf' | 'container' | 'inline'
  body: 'none' | 'markdown' | 'text' | 'yaml'
  attrs: Json // JSON Schema; fields may carry "x-visibility": "server"
  guidance: { when: string; syntax: string; rules?: string[]; avoid?: string[] }
  validate?(node: LessonNode, ctx: ValidationContext): Diagnostic[] | Promise<Diagnostic[]>
  fallback: { mode: 'children' | 'text' | 'hide'; text(node: LessonNode): string }
  speakable?(node: LessonNode): string | undefined
  renderer: { entry: string; trust: 'sandboxed' | 'first-party'; capabilities?: string[]; height?: 'auto' | number }
}

export interface LayoutSpec {
  name: string
  guidance: string
  accepts: string[]
  roles?: Record<string, string>
  renderer: BlockSpec['renderer']
}

export interface Item {
  id: string
  isomorphGroup: string
  skills: { id: string; weight: number; role: 'target' | 'prereq' }[]
  kind: string
  difficulty: { b: number; source: 'llm' | 'teacher' | 'calibrated'; n: number }
  modes: ('practice' | 'checkpoint' | 'review' | 'diagnostic')[]
  prompt: Json
  /** SERVER-ONLY: answer, tests, reference solution. Reaches the plugin worker, never a client. */
  key: Json
  hints: { level: 1 | 2 | 3 | 4 | 5; text: string }[]
  distractors?: { id: string; misconception?: string; feedback: string }[]
}

export interface GradeResult {
  score: number // 0..1
  correct?: boolean
  misconceptionsDetected: string[]
  oracle?: Json
  feedback: { text: string; revealsAnswer: boolean }
  graderConfidence: number // 0..1
  needsHumanReview: boolean
}

export interface GradeContext {
  mode: 'practice' | 'checkpoint' | 'review' | 'diagnostic'
  attempt: number
}

export interface ExerciseKindSpec {
  name: string
  version: number
  kinds: string[]
  responseKind: 'choice' | 'text' | 'code' | 'moves' | 'image' | 'audio' | 'structured'
  grader: 'deterministic' | 'oracle' | 'llm-rubric' | 'pairwise' | 'human' | 'hybrid'
  supports: { steps: boolean; hints: boolean; partialCredit: boolean; timed: boolean; variants: boolean }
  itemSchema: Json
  validateItem?(item: Item): Diagnostic[] | Promise<Diagnostic[]>
  grade(item: Item, response: Json, ctx: GradeContext): GradeResult | Promise<GradeResult>
  ui: { entry: string; trust: 'sandboxed' | 'first-party' }
}

export interface PresetSpec {
  name: string
  version: number
  data: Json // data only
}

/** What plugin code sees as `ctx`. A facade: it is NOT a cordis Context and must not expose one. */
export interface PluginContext {
  lesson: { layout(spec: LayoutSpec): Disposer; block(spec: BlockSpec): Disposer }
  exercise: { kind(spec: ExerciseKindSpec): Disposer }
  pedagogy: { preset(spec: PresetSpec): Disposer }
  /** Run `fn` now; the returned disposer runs when the plugin unloads. */
  effect(fn: () => Disposer | void): Disposer
}

export interface PluginModule<Config = unknown> {
  name: string
  apply(ctx: PluginContext, config?: Config): void | Promise<void>
}
