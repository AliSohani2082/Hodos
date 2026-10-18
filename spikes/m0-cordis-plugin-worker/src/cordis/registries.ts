// Typed registries as cordis Services (ALI-50). This file is cordis-specific on purpose: it is what the
// internal adapter (src/host/cordis-adapter.ts) hides from the SDK. Erasable TypeScript only, so Bun and Node run it directly.
import { Context, Service } from 'cordis'
import type { BlockSpec, ExerciseKindSpec, LayoutSpec, PresetSpec } from '../sdk/types.ts'

declare module 'cordis' {
  interface Context {
    lesson: LessonRegistry
    exercise: ExerciseRegistry
    pedagogy: PedagogyRegistry
  }
  interface Events {
    'hodos/registered'(kind: string, name: string): void
    'hodos/unregistered'(kind: string, name: string): void
  }
}

/** Generic registry: `add()` registers through `this.ctx.effect`, so the entry dies with the *calling* plugin's fiber. */
abstract class Registry<S extends { name: string }> extends Service {
  readonly entries = new Map<string, S>()
  protected abstract readonly kindName: string

  protected add(spec: S) {
    // `this.ctx` is the caller's context: cordis rebinds service `ctx` per access (Tracker), so the effect is owned by the plugin that called us.
    return this.ctx.effect(() => {
      if (this.entries.has(spec.name)) throw new Error(`${this.kindName} "${spec.name}" is already registered`)
      this.entries.set(spec.name, spec)
      this.ctx.emit('hodos/registered', this.kindName, spec.name)
      return () => {
        this.entries.delete(spec.name)
        this.ctx.emit('hodos/unregistered', this.kindName, spec.name)
      }
    }, `${this.kindName}(${spec.name})`)
  }
}

export class LessonRegistry extends Registry<BlockSpec | LayoutSpec> {
  protected readonly kindName = 'lesson'
  readonly blocks = new Map<string, BlockSpec>()
  readonly layouts = new Map<string, LayoutSpec>()
  constructor(ctx: Context) { super(ctx, 'lesson') }

  block(spec: BlockSpec) {
    return this.ctx.effect(() => {
      if (this.blocks.has(spec.name)) throw new Error(`block "${spec.name}" is already registered`)
      this.blocks.set(spec.name, spec)
      this.ctx.emit('hodos/registered', 'lesson.block', spec.name)
      return () => { this.blocks.delete(spec.name); this.ctx.emit('hodos/unregistered', 'lesson.block', spec.name) }
    }, `lesson.block(${spec.name})`)
  }
  layout(spec: LayoutSpec) {
    return this.ctx.effect(() => {
      if (this.layouts.has(spec.name)) throw new Error(`layout "${spec.name}" is already registered`)
      this.layouts.set(spec.name, spec)
      this.ctx.emit('hodos/registered', 'lesson.layout', spec.name)
      return () => { this.layouts.delete(spec.name); this.ctx.emit('hodos/unregistered', 'lesson.layout', spec.name) }
    }, `lesson.layout(${spec.name})`)
  }
}

export class ExerciseRegistry extends Registry<ExerciseKindSpec> {
  protected readonly kindName = 'exercise.kind'
  constructor(ctx: Context) { super(ctx, 'exercise') }
  kind(spec: ExerciseKindSpec) { return this.add(spec) }
}

export class PedagogyRegistry extends Registry<PresetSpec> {
  protected readonly kindName = 'pedagogy.preset'
  constructor(ctx: Context) { super(ctx, 'pedagogy') }
  preset(spec: PresetSpec) { return this.add(spec) }
}

/** Mounts the three registry services as plugins under `ctx`. Returns the fibers so a test can dispose/restart them. */
export function installRegistries(ctx: Context) {
  return { lesson: ctx.plugin(LessonRegistry), exercise: ctx.plugin(ExerciseRegistry), pedagogy: ctx.plugin(PedagogyRegistry) }
}
