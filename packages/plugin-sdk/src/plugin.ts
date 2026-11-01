/**
 * The environment plugin contract: a manifest plus a `register` function that
 * receives a typed registration context. A plugin contributes environments,
 * exercise kinds, graders, lesson blocks, presets, renderers and content; it
 * never touches learner state.
 * @module @hodos/plugin-sdk/plugin
 */
import type { ContentPack } from './content.js'
import type { ExerciseKindSpec } from './exercise.js'
import type { GraderSpec } from './grading.js'
import type { JsonObject, JsonSchema, JsonValue } from './json.js'
import type { LessonBlockSpec } from './lesson.js'
import type { HodosEnvironmentManifest } from './manifest.js'
import type { PedagogyPreset } from './preset.js'
import type { RendererCapability } from './protocol.js'

/** Static files served to a sandboxed iframe. */
export interface RendererSpec {
  /** Renderer id; must be listed in `capabilities.renderers`. */
  readonly id: string
  /** Environment ids this renderer presents. */
  readonly environments: readonly string[]
  /** Absolute directory holding the renderer's static files. Nothing outside it is served. */
  readonly root: string
  /** HTML entry file, relative to `root`. */
  readonly entry: string
  /** Capabilities requested; the host grants at most `manifest.rendererPermissions`. */
  readonly capabilities: readonly RendererCapability[]
}

/**
 * An optional content generator (experimental): produces candidate items for
 * a skill. Generated items go through the same validation as authored ones
 * and are marked `provenance.source = 'generated'`.
 */
export interface ContentGeneratorSpec {
  readonly id: string
  /** Exercise kinds it can produce. */
  readonly kinds: readonly string[]
  /** Schema of the generator's request parameters. */
  readonly requestSchema: JsonSchema
  readonly generate: (request: JsonObject) => Promise<readonly JsonValue[]> | readonly JsonValue[]
}

/** Logger handed to plugins; output is attributed to the plugin id. */
export interface PluginLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Registration context passed to {@link HodosEnvironmentPlugin.register}.
 * Registrations are collected and committed atomically after `register`
 * returns; if it throws, nothing is registered. Every registration must be
 * declared in the manifest's capabilities.
 */
export interface HodosPluginContext {
  readonly manifest: HodosEnvironmentManifest
  readonly logger: PluginLogger
  /** Host-supplied configuration for this plugin (JSON). */
  readonly config: JsonObject
  /** Whether the host runs this plugin's in-process hooks (built-in allowlist). */
  readonly trusted: boolean
  registerExerciseKind(spec: ExerciseKindSpec): void
  registerGrader(spec: GraderSpec): void
  registerLessonBlock(spec: LessonBlockSpec): void
  registerPreset(preset: PedagogyPreset): void
  registerRenderer(spec: RendererSpec): void
  registerContentPack(pack: ContentPack): void
  /** Experimental. */
  registerContentGenerator(spec: ContentGeneratorSpec): void
  /** Release a resource (engine process, timer) when the plugin unloads. */
  onDispose(dispose: () => void | Promise<void>): void
}

/** An environment plugin (spec §9). */
export interface HodosEnvironmentPlugin {
  readonly manifest: HodosEnvironmentManifest
  register(context: HodosPluginContext): void | Promise<void>
}

/**
 * Identity helper that gives a plugin definition its contract type.
 * @param plugin - the plugin.
 * @returns the same plugin.
 */
export function defineEnvironmentPlugin(plugin: HodosEnvironmentPlugin): HodosEnvironmentPlugin {
  return plugin
}
