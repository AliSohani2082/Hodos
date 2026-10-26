/**
 * The plugin registry. Registration is atomic: a plugin's contributions are
 * collected, validated and committed together, or not at all. Trust is
 * decided by the host (an allowlist or the declarative loader), never by the
 * plugin. Untrusted plugins' in-process functions are never called: their
 * graders and item validators run in the QuickJS sandbox, and their
 * fallback text uses a generic projection.
 * @module @hodos/core/registry
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  CORE_PLUGIN_API_VERSION,
  DEFAULT_LOOP_FOR_KIND,
  EXERCISE_MODES,
  LEARNING_LOOPS,
  RENDERER_CAPABILITIES,
  compileSchema,
  formatDiagnostics,
  HodosPluginError,
  isJsonValue,
  validateContentPackShape,
  validateManifest,
  type ContentGeneratorSpec,
  type ContentPack,
  type Diagnostic,
  type ExerciseItem,
  type ExerciseKindSpec,
  type GradeInput,
  type GradeResult,
  type GraderSpec,
  type GradingMethod,
  type HodosEnvironmentManifest,
  type HodosEnvironmentPlugin,
  type HodosPluginContext,
  type JsonObject,
  type JsonValue,
  type LessonBlockSpec,
  type PedagogyPreset,
  type RendererCapability,
  type RendererSpec,
  type SchemaValidator,
  type StepInput,
  type StepResult,
} from '@hodos/plugin-sdk'
import { HodosError } from '../errors.js'
import { validateGradeResult } from '../evidence/grade.js'
import type { SandboxRunner } from './sandbox/runner.js'

/** Logger used by the registry. */
export interface RegistryLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const CONTRIBUTION_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/
const BLOCK_NAME = /^[a-z][a-z0-9-]{1,47}$/
const CORE_BLOCKS = new Set(['step', 'callout', 'worked-example', 'check', 'term', 'note'])

/** A registered exercise kind with compiled validators. */
export interface RegisteredKind {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly trusted: boolean
  /** Loaded from a declarative plugin: its functions are host-generated templates. */
  readonly declarative: boolean
  readonly spec: ExerciseKindSpec
  readonly validatePayload: SchemaValidator
  readonly validateKey: SchemaValidator
  readonly validateResponse: SchemaValidator
}

/** A registered lesson block. */
export interface RegisteredBlock {
  readonly pluginId: string
  readonly trusted: boolean
  /** Loaded from a declarative plugin: its functions are host-generated templates. */
  readonly declarative: boolean
  readonly spec: LessonBlockSpec
  readonly validateAttributes: SchemaValidator
}

/** A registered renderer with the capabilities the host granted. */
export interface RegisteredRenderer {
  readonly pluginId: string
  readonly spec: RendererSpec
  readonly granted: readonly RendererCapability[]
}

/** One plugin's registration record. */
export interface PluginRecord {
  readonly manifest: HodosEnvironmentManifest
  readonly trusted: boolean
  readonly declarative: boolean
  readonly registeredAt: Date
}

/** Registry options. */
export interface RegistryOptions {
  readonly sandbox: SandboxRunner
  readonly logger: RegistryLogger
  /** Per-plugin configuration supplied by the host. */
  readonly pluginConfig?: (pluginId: string) => JsonObject
  /** Deadline for a plugin's `register` call, ms. */
  readonly registerTimeoutMs?: number
  /** Deadline for one trusted hook call (grade, step, validateItem), ms. */
  readonly hookTimeoutMs?: number
}

interface Collected {
  kinds: ExerciseKindSpec[]
  graders: GraderSpec[]
  blocks: LessonBlockSpec[]
  presets: PedagogyPreset[]
  renderers: RendererSpec[]
  packs: ContentPack[]
  generators: ContentGeneratorSpec[]
  disposers: Array<() => void | Promise<void>>
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new HodosError('UNAVAILABLE', `${what} did not finish within ${ms} ms`)), ms)
    }),
  ])
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (_missing) {
    // A missing or unreadable path is simply not a directory.
    return false
  }
}

/** Generic, key-free text for an exercise whose plugin cannot be trusted to project it. */
export function genericFallbackText(title: string, payload: JsonValue): string {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    for (const field of ['prompt', 'question', 'instruction', 'text']) {
      const value = payload[field]
      if (typeof value === 'string' && value.length > 0) return `[${title}] ${value.slice(0, 500)}`
    }
  }
  return `[${title}]`
}

/** The registry of environment plugins and their contributions. */
export class PluginRegistry {
  private readonly records = new Map<string, PluginRecord>()
  private readonly kinds = new Map<string, RegisteredKind>()
  private readonly graders = new Map<string, { pluginId: string; trusted: boolean; spec: GraderSpec }>()
  private readonly blocks = new Map<string, RegisteredBlock>()
  private readonly presetMap = new Map<string, { pluginId: string; preset: PedagogyPreset }>()
  private readonly rendererMap = new Map<string, RegisteredRenderer>()
  private readonly packMap = new Map<string, { pluginId: string; pack: ContentPack }>()
  private readonly generatorMap = new Map<string, { pluginId: string; spec: ContentGeneratorSpec }>()
  private readonly disposersOf = new Map<string, Array<() => void | Promise<void>>>()
  private readonly listeners = new Set<() => void>()

  /** @param options - sandbox, logger and timeouts. */
  constructor(private readonly options: RegistryOptions) {}

  /**
   * Validate and register a plugin.
   * @param plugin - the plugin object.
   * @param trust - whether its in-process hooks may run (decided by the host), and
   *   whether it was loaded by the declarative loader (its functions are host-generated).
   * @returns a disposer that removes every contribution and runs the plugin's cleanup.
   * @throws {HodosPluginError} for an invalid manifest, incompatible core,
   *   undeclared or duplicate contributions, invalid schemas or a failing `register`.
   */
  async register(plugin: HodosEnvironmentPlugin, trust: { readonly trusted: boolean; readonly declarative?: boolean }): Promise<() => Promise<void>> {
    const manifestFindings = validateManifest(plugin.manifest, CORE_PLUGIN_API_VERSION)
    if (manifestFindings.length > 0) {
      const incompatible = manifestFindings.some(f => f.code === 'manifest/incompatible-core')
      throw new HodosPluginError(incompatible ? 'INCOMPATIBLE_CORE' : 'INVALID_MANIFEST', `plugin manifest rejected:\n${formatDiagnostics(manifestFindings)}`, manifestFindings)
    }
    const manifest = plugin.manifest
    if (this.records.has(manifest.id)) {
      throw new HodosPluginError('DUPLICATE_REGISTRATION', `plugin ${manifest.id} is already registered`)
    }
    const collected: Collected = { kinds: [], graders: [], blocks: [], presets: [], renderers: [], packs: [], generators: [], disposers: [] }
    let open = true
    const guard = (): void => {
      if (!open) throw new HodosPluginError('INVALID_REGISTRATION', 'registrations are only accepted during register()')
    }
    const logger = this.options.logger
    const context: HodosPluginContext = {
      manifest,
      trusted: trust.trusted,
      config: this.options.pluginConfig?.(manifest.id) ?? {},
      logger: {
        info: m => logger.info(`[${manifest.id}] ${m}`),
        warn: m => logger.warn(`[${manifest.id}] ${m}`),
        error: m => logger.error(`[${manifest.id}] ${m}`),
      },
      registerExerciseKind: spec => { guard(); collected.kinds.push(spec) },
      registerGrader: spec => { guard(); collected.graders.push(spec) },
      registerLessonBlock: spec => { guard(); collected.blocks.push(spec) },
      registerPreset: preset => { guard(); collected.presets.push(preset) },
      registerRenderer: spec => { guard(); collected.renderers.push(spec) },
      registerContentPack: pack => { guard(); collected.packs.push(pack) },
      registerContentGenerator: spec => { guard(); collected.generators.push(spec) },
      onDispose: dispose => { guard(); collected.disposers.push(dispose) },
    }
    try {
      await withTimeout(Promise.resolve(plugin.register(context)), this.options.registerTimeoutMs ?? 10_000, `plugin ${manifest.id} register()`)
    } catch (error) {
      open = false
      await this.runDisposers(manifest.id, collected.disposers)
      if (error instanceof HodosPluginError) throw error
      throw new HodosPluginError('REGISTRATION_FAILED', `plugin ${manifest.id} failed to register: ${error instanceof Error ? error.message : String(error)}`)
    }
    open = false
    let prepared: ReturnType<PluginRegistry['prepare']>
    try {
      // Re-check after the await: another registration of the same id may have committed meanwhile.
      if (this.records.has(manifest.id)) throw new HodosPluginError('DUPLICATE_REGISTRATION', `plugin ${manifest.id} is already registered`)
      prepared = this.prepare(manifest, trust.trusted, trust.declarative === true, collected)
    } catch (error) {
      await this.runDisposers(manifest.id, collected.disposers)
      throw error
    }
    // Commit: every contribution was validated, so these writes cannot fail half-way.
    this.records.set(manifest.id, { manifest, trusted: trust.trusted, declarative: trust.declarative === true, registeredAt: new Date() })
    for (const k of prepared.kinds) this.kinds.set(k.spec.id, k)
    for (const g of collected.graders) this.graders.set(g.id, { pluginId: manifest.id, trusted: trust.trusted, spec: g })
    for (const b of prepared.blocks) this.blocks.set(b.spec.name, b)
    for (const p of collected.presets) this.presetMap.set(p.id, { pluginId: manifest.id, preset: p })
    for (const r of prepared.renderers) this.rendererMap.set(r.spec.id, r)
    for (const p of collected.packs) this.packMap.set(p.id, { pluginId: manifest.id, pack: p })
    for (const g of collected.generators) this.generatorMap.set(g.id, { pluginId: manifest.id, spec: g })
    this.disposersOf.set(manifest.id, collected.disposers)
    logger.info(`registered plugin ${manifest.id}@${manifest.version} (${trust.trusted ? 'trusted' : 'sandboxed'})`)
    this.emitChange()
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      await this.unregister(manifest.id)
    }
  }

  private prepare(manifest: HodosEnvironmentManifest, trusted: boolean, declarative: boolean, c: Collected): {
    kinds: RegisteredKind[]
    blocks: RegisteredBlock[]
    renderers: RegisteredRenderer[]
  } {
    const findings: Diagnostic[] = []
    const err = (code: string, message: string): void => { findings.push({ severity: 'error', code, message }) }
    const caps = manifest.capabilities
    const declared = (list: readonly string[] | undefined, id: string): boolean => (list ?? []).includes(id)
    const unique = <T>(items: readonly T[], key: (t: T) => string, what: string, existing: ReadonlyMap<string, unknown>): void => {
      const seen = new Set<string>()
      for (const item of items) {
        const id = key(item)
        if (seen.has(id) || existing.has(id)) err('registry/duplicate', `${what} ${id} is already registered`)
        seen.add(id)
      }
    }
    unique(c.kinds, k => k.id, 'exercise kind', this.kinds)
    unique(c.graders, g => g.id, 'grader', this.graders)
    unique(c.blocks, b => b.name, 'lesson block', this.blocks)
    unique(c.presets, p => p.id, 'preset', this.presetMap)
    unique(c.renderers, r => r.id, 'renderer', this.rendererMap)
    unique(c.packs, p => p.id, 'content pack', this.packMap)

    const graderIds = new Set(c.graders.map(g => g.id))
    for (const g of c.graders) {
      if (!CONTRIBUTION_ID.test(g.id)) err('registry/bad-id', `invalid grader id ${g.id}`)
      if (!declared(caps.graders, g.id)) err('registry/undeclared', `grader ${g.id} is not declared in the manifest`)
      if (trusted) {
        if (g.grade === undefined && g.step === undefined && g.sandbox === undefined) err('registry/grader-empty', `grader ${g.id} has no implementation`)
      } else if (g.sandbox === undefined || typeof g.sandbox.source !== 'string' || g.sandbox.source.length === 0) {
        err('registry/untrusted-grader', `grader ${g.id} must ship a sandboxed source because the plugin is not trusted`)
      } else if (g.sandbox.source.length > 512 * 1024) {
        err('registry/sandbox-too-large', `grader ${g.id} sandbox source exceeds 512 KiB`)
      }
    }

    const kinds: RegisteredKind[] = []
    for (const k of c.kinds) {
      if (!CONTRIBUTION_ID.test(k.id)) err('registry/bad-id', `invalid exercise kind id ${k.id}`)
      if (!declared(caps.exerciseKinds, k.id)) err('registry/undeclared', `exercise kind ${k.id} is not declared in the manifest`)
      if (!declared(caps.environments, k.environment)) err('registry/undeclared', `environment ${k.environment} of kind ${k.id} is not declared in the manifest`)
      if (!graderIds.has(k.grader)) err('registry/unknown-grader', `exercise kind ${k.id} names grader ${k.grader}, which this plugin does not register`)
      else {
        const g = c.graders.find(x => x.id === k.grader)
        if (g !== undefined && !g.kinds.includes(k.id)) err('registry/grader-kind', `grader ${g.id} does not list kind ${k.id}`)
        if (g !== undefined && trusted && k.interaction === 'stepwise' && g.step === undefined) err('registry/grader-step', `stepwise kind ${k.id} needs a grader with step()`)
      }
      if (k.format.options !== undefined && !(Number.isInteger(k.format.options) && k.format.options >= 2)) {
        err('registry/format', `kind ${k.id} has an invalid option count`)
      }
      try {
        kinds.push({
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          trusted,
          declarative,
          spec: k,
          validatePayload: compileSchema(k.payloadSchema, `${k.id}/payload`),
          validateKey: compileSchema(k.keySchema, `${k.id}/key`),
          validateResponse: compileSchema(k.responseSchema, `${k.id}/response`),
        })
      } catch (error) {
        err('registry/schema', error instanceof Error ? error.message : String(error))
      }
    }

    const blocks: RegisteredBlock[] = []
    for (const b of c.blocks) {
      if (!BLOCK_NAME.test(b.name) || CORE_BLOCKS.has(b.name)) err('registry/bad-block', `invalid or reserved lesson block name ${b.name}`)
      if (!declared(caps.lessonBlocks, b.name)) err('registry/undeclared', `lesson block ${b.name} is not declared in the manifest`)
      try {
        blocks.push({ pluginId: manifest.id, trusted, declarative, spec: b, validateAttributes: compileSchema(b.attributes, `${b.name}/attributes`) })
      } catch (error) {
        err('registry/schema', error instanceof Error ? error.message : String(error))
      }
    }

    for (const p of c.presets) {
      if (!/^[a-z0-9][a-z0-9._-]{1,63}@[0-9]+$/.test(p.id)) err('registry/bad-preset', `invalid preset id ${p.id}`)
      if (!declared(caps.presets, p.id)) err('registry/undeclared', `preset ${p.id} is not declared in the manifest`)
      for (const [kind, loop] of Object.entries(p.kindLoops ?? {})) {
        if (!(kind in DEFAULT_LOOP_FOR_KIND) || !LEARNING_LOOPS.some(l => l === loop)) err('registry/bad-preset', `preset ${p.id} maps ${kind} to unknown loop ${String(loop)}`)
      }
      const maxHint = p.tutor?.maxHintLevel
      if (maxHint !== undefined && !(Number.isInteger(maxHint) && maxHint >= 0 && maxHint <= 5)) err('registry/bad-preset', `preset ${p.id} hint ceiling must be 0..5`)
      const retention = p.review?.targetRetention
      if (retention !== undefined && !(retention >= 0.8 && retention <= 0.97)) err('registry/bad-preset', `preset ${p.id} target retention must be within [0.80, 0.97]`)
    }

    const renderers: RegisteredRenderer[] = []
    for (const r of c.renderers) {
      if (!CONTRIBUTION_ID.test(r.id)) err('registry/bad-id', `invalid renderer id ${r.id}`)
      if (!declared(caps.renderers, r.id)) err('registry/undeclared', `renderer ${r.id} is not declared in the manifest`)
      for (const env of r.environments) if (!declared(caps.environments, env)) err('registry/undeclared', `renderer ${r.id} environment ${env} is not declared`)
      if (!isAbsolute(r.root) || !isDirectory(r.root)) {
        err('registry/renderer-root', `renderer ${r.id} root must be an existing absolute directory`)
      } else {
        const root = realpathSync(r.root)
        const entry = resolve(root, r.entry)
        const rel = relative(root, entry)
        if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(entry)) err('registry/renderer-entry', `renderer ${r.id} entry must be a file inside its root`)
        const allowed = new Set(manifest.rendererPermissions ?? [])
        const granted = r.capabilities.filter(cap => RENDERER_CAPABILITIES.includes(cap) && (cap === 'respond' || cap === 'resize' || allowed.has(cap)))
        renderers.push({ pluginId: manifest.id, spec: { ...r, root }, granted })
      }
    }

    for (const p of c.packs) {
      if (!CONTRIBUTION_ID.test(p.id)) err('registry/bad-id', `invalid content pack id ${p.id}`)
      if (!declared(caps.contentPacks, p.id)) err('registry/undeclared', `content pack ${p.id} is not declared in the manifest`)
      for (const d of validateContentPackShape(p)) err('registry/content', `content pack ${p.id}: ${d.message}`)
    }

    for (const g of c.generators) {
      if (!trusted) err('registry/untrusted-generator', `content generator ${g.id} requires a trusted plugin`)
      if (!declared(caps.generators, g.id)) err('registry/undeclared', `content generator ${g.id} is not declared in the manifest`)
    }

    if (findings.length > 0) {
      const code = findings.some(f => f.code === 'registry/duplicate') ? 'DUPLICATE_REGISTRATION'
        : findings.some(f => f.code === 'registry/undeclared') ? 'UNDECLARED_CAPABILITY'
          : findings.some(f => f.code === 'registry/schema') ? 'INVALID_SCHEMA' : 'INVALID_REGISTRATION'
      throw new HodosPluginError(code, `plugin ${manifest.id} registration rejected:\n${formatDiagnostics(findings)}`, findings)
    }
    return { kinds, blocks, renderers }
  }

  private async runDisposers(pluginId: string, disposers: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
    for (const dispose of [...disposers].reverse()) {
      try {
        await withTimeout(Promise.resolve(dispose()), 5000, `plugin ${pluginId} cleanup`)
      } catch (error) {
        this.options.logger.warn(`plugin ${pluginId} cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Remove a plugin and everything it contributed. Learner records are untouched.
   * @param pluginId - the plugin id.
   */
  async unregister(pluginId: string): Promise<void> {
    if (!this.records.has(pluginId)) return
    this.records.delete(pluginId)
    const owned = <V extends { pluginId: string }>(map: Map<string, V>): void => {
      for (const [key, value] of map) if (value.pluginId === pluginId) map.delete(key)
    }
    owned(this.kinds)
    owned(this.graders)
    owned(this.blocks)
    owned(this.presetMap)
    owned(this.rendererMap)
    owned(this.packMap)
    owned(this.generatorMap)
    const disposers = this.disposersOf.get(pluginId) ?? []
    this.disposersOf.delete(pluginId)
    this.emitChange()
    await this.runDisposers(pluginId, disposers)
    this.options.logger.info(`unregistered plugin ${pluginId}`)
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.options.logger.warn(`registry listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Subscribe to registration changes.
   * @param listener - called after every register/unregister.
   * @returns the unsubscriber.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Registered plugins. */
  plugins(): PluginRecord[] {
    return [...this.records.values()]
  }

  /** @param id - kind id. @returns the kind, or undefined when its plugin is not installed. */
  kind(id: string): RegisteredKind | undefined {
    return this.kinds.get(id)
  }

  /** Ids of the registered exercise kinds. */
  kindIds(): string[] {
    return [...this.kinds.keys()]
  }

  /** @param name - block name. @returns the block, or undefined. */
  block(name: string): RegisteredBlock | undefined {
    return this.blocks.get(name)
  }

  /** All registered blocks. */
  allBlocks(): RegisteredBlock[] {
    return [...this.blocks.values()]
  }

  /** @param id - preset id. @returns the preset, or undefined. */
  preset(id: string): PedagogyPreset | undefined {
    return this.presetMap.get(id)?.preset
  }

  /** @param id - renderer id. @returns the renderer, or undefined. */
  renderer(id: string): RegisteredRenderer | undefined {
    return this.rendererMap.get(id)
  }

  /**
   * The renderer for an environment.
   * @param environment - environment id.
   * @returns the first renderer presenting it, or undefined.
   */
  rendererFor(environment: string): RegisteredRenderer | undefined {
    return [...this.rendererMap.values()].find(r => r.spec.environments.includes(environment))
  }

  /** Environments provided by active plugins. */
  environments(): string[] {
    return [...new Set([...this.records.values()].flatMap(r => r.manifest.capabilities.environments ?? []))]
  }

  /** Registered content packs with their owning plugin. */
  contentPacks(): Array<{ pluginId: string; pack: ContentPack }> {
    return [...this.packMap.values()]
  }

  /** @param id - generator id. @returns the generator, or undefined. */
  generator(id: string): ContentGeneratorSpec | undefined {
    return this.generatorMap.get(id)?.spec
  }

  private graderFor(kindId: string): { kind: RegisteredKind; grader: { pluginId: string; trusted: boolean; spec: GraderSpec } } {
    const kind = this.kinds.get(kindId)
    if (kind === undefined) throw new HodosError('UNAVAILABLE', `the environment for exercise kind ${kindId} is not installed`, { kind: kindId })
    const grader = this.graders.get(kind.spec.grader)
    if (grader === undefined) throw new HodosError('UNAVAILABLE', `grader ${kind.spec.grader} is not installed`, { kind: kindId })
    return { kind, grader }
  }

  /**
   * Grade one response. The result is validated before it is returned.
   * @param input - grading input (contains the key; server-side only).
   * @returns the validated grade.
   * @throws {HodosError} `UNAVAILABLE` when the plugin is missing or the grader
   *   fails; `INVALID_INPUT` when the grader returns a malformed result.
   */
  async grade(input: GradeInput): Promise<GradeResult> {
    const { grader } = this.graderFor(input.kind)
    return this.runGrader(grader.spec.id, 'grade', async () => {
      if (grader.trusted && grader.spec.grade !== undefined) {
        const grade = grader.spec.grade
        return withTimeout(Promise.resolve().then(() => grade(input)), this.options.hookTimeoutMs ?? 5000, `grader ${grader.spec.id}`)
      }
      if (grader.spec.sandbox !== undefined) return this.options.sandbox.call('grade', grader.spec.sandbox.source, input)
      throw new HodosError('UNAVAILABLE', `grader ${grader.spec.id} cannot grade single responses`)
    }, raw => validateGradeResult(raw, input.skills))
  }

  /**
   * Run a grader hook and validate its output. Any failure becomes one fixed
   * error: grader messages can quote the answer key, so they go to the server
   * log only and never to the learner, the model or the HTTP client.
   */
  private async runGrader<T>(graderId: string, hook: 'grade' | 'step', invoke: () => Promise<unknown>, validate: (raw: unknown) => T): Promise<T> {
    try {
      return validate(await invoke())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = /did not finish|exceeded/.test(message) ? 'timeout'
        : error instanceof HodosError && error.code === 'INVALID_INPUT' && /rejected|oversized|invalid JSON|not plain JSON/.test(message) ? 'malformed-result' : 'error'
      this.options.logger.warn(`grader ${graderId} ${hook} failed (${reason}): ${message.slice(0, 300)}`)
      throw new HodosError('UNAVAILABLE', `grader ${graderId} failed; the attempt was not counted`, { grader: graderId, reason })
    }
  }

  /**
   * The grader of an exercise kind.
   * @param kindId - kind id.
   * @returns its id, method and trust, or undefined when not installed.
   */
  graderInfo(kindId: string): { id: string; method: GradingMethod; trusted: boolean } | undefined {
    const kind = this.kinds.get(kindId)
    const grader = kind === undefined ? undefined : this.graders.get(kind.spec.grader)
    return grader === undefined ? undefined : { id: grader.spec.id, method: grader.spec.method, trusted: grader.trusted }
  }

  /**
   * Advance a stepwise exercise by one learner step.
   * @param input - step input (contains the key; server-side only).
   * @returns the validated step result.
   * @throws {HodosError} as for {@link grade}.
   */
  async step(input: StepInput): Promise<StepResult> {
    const { grader } = this.graderFor(input.kind)
    return this.runGrader(grader.spec.id, 'step', async () => {
      if (grader.trusted && grader.spec.step !== undefined) {
        const step = grader.spec.step
        return withTimeout(Promise.resolve().then(() => step(input)), this.options.hookTimeoutMs ?? 5000, `grader ${grader.spec.id}`)
      }
      if (grader.spec.sandbox !== undefined) return this.options.sandbox.call('step', grader.spec.sandbox.source, input)
      throw new HodosError('UNAVAILABLE', `grader ${grader.spec.id} cannot grade steps`)
    }, raw => validateStepResult(raw, input.skills))
  }

  /**
   * Validate an item against its kind: schemas, envelope rules and the
   * plugin's semantic checks (in the sandbox for untrusted plugins).
   * @param item - the item.
   * @returns findings; empty when valid.
   */
  async validateItem(item: ExerciseItem): Promise<Diagnostic[]> {
    const out: Diagnostic[] = []
    const kind = this.kinds.get(item.kind)
    if (kind === undefined) {
      return [{ severity: 'error', code: 'item/unknown-kind', message: `exercise kind ${item.kind} is not installed`, target: item.id }]
    }
    const tag = (ds: readonly Diagnostic[], prefix: string): Diagnostic[] => ds.map(d => ({ ...d, target: item.id, path: `${prefix}${d.path ?? ''}` }))
    out.push(...tag(kind.validatePayload(item.payload), '/payload'), ...tag(kind.validateKey(item.key), '/key'))
    out.push(...validateEnvelope(item))
    if (out.some(d => d.severity === 'error')) return out
    try {
      if (kind.trusted && kind.spec.validateItem !== undefined) {
        out.push(...kind.spec.validateItem(item).map(d => ({ ...d, target: d.target ?? item.id })))
      } else if (!kind.trusted) {
        const grader = this.graders.get(kind.spec.grader)
        if (grader?.spec.sandbox !== undefined) {
          const raw = await this.options.sandbox.call('validateItem', grader.spec.sandbox.source, item).catch((error: unknown) => {
            // A sandbox without validateItem simply has no semantic checks.
            if (error instanceof HodosError && /is not defined/.test(error.message)) return []
            throw error
          })
          out.push(...parseDiagnostics(raw, item.id))
        }
      }
    } catch (error) {
      out.push({ severity: 'error', code: 'item/validator-failed', message: `item validator failed: ${error instanceof Error ? error.message : String(error)}`, target: item.id })
    }
    return out
  }

  /**
   * Plain-text projection of a payload (never the key).
   * @param kindId - kind id.
   * @param payload - client-visible payload.
   * @returns text; a generic projection for untrusted or missing plugins.
   */
  fallbackText(kindId: string, payload: JsonValue): string {
    const kind = this.kinds.get(kindId)
    if (kind === undefined) return genericFallbackText(kindId, payload)
    if (!kind.trusted && !kind.declarative) return genericFallbackText(kind.spec.title, payload)
    try {
      return kind.spec.fallbackText(payload)
    } catch (_error) {
      // A throwing projection must not break the learner's view; use the generic one.
      return genericFallbackText(kind.spec.title, payload)
    }
  }
}

/** Envelope rules every item must satisfy regardless of plugin. */
export function validateEnvelope(item: ExerciseItem): Diagnostic[] {
  const out: Diagnostic[] = []
  const e = (code: string, message: string, path?: string): void => {
    out.push({ severity: 'error', code, message, target: item.id, ...(path === undefined ? {} : { path }) })
  }
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(item.id)) e('item/bad-id', `invalid item id ${item.id}`, '/id')
  if (item.skills.length === 0) e('item/no-skills', 'item is not tagged with any skill', '/skills')
  for (const s of item.skills) if (!(s.weight > 0 && s.weight <= 1)) e('item/weight', `skill weight for ${s.skillId} must be in (0, 1]`, '/skills')
  if (!(Number.isFinite(item.difficulty) && item.difficulty >= -4 && item.difficulty <= 4)) e('item/difficulty', 'difficulty must be within [-4, 4] logits', '/difficulty')
  if (item.modes.length === 0 || item.modes.some(m => !EXERCISE_MODES.includes(m))) e('item/modes', 'item has no valid modes', '/modes')
  const levels = (item.hints ?? []).map(h => h.level)
  if (new Set(levels).size !== levels.length) e('item/hints', 'hint levels must be unique', '/hints')
  for (const h of item.hints ?? []) if (h.text.trim() === '') e('item/hints', `hint level ${h.level} is empty`, '/hints')
  return out
}

function parseDiagnostics(raw: unknown, target: string): Diagnostic[] {
  if (!Array.isArray(raw)) return [{ severity: 'error', code: 'item/validator-output', message: 'sandboxed validateItem must return an array', target }]
  const out: Diagnostic[] = []
  for (const entry of raw.slice(0, 50)) {
    if (typeof entry !== 'object' || entry === null) continue
    const d = entry as Record<string, unknown>
    out.push({
      severity: d.severity === 'warning' ? 'warning' : 'error',
      code: typeof d.code === 'string' ? d.code.slice(0, 64) : 'plugin/finding',
      message: typeof d.message === 'string' ? d.message.slice(0, 500) : 'invalid item',
      target,
    })
  }
  return out
}

function validateStepResult(raw: unknown, skills: GradeInput['skills']): StepResult {
  if (typeof raw !== 'object' || raw === null || !isJsonValue(raw)) throw new HodosError('INVALID_INPUT', 'step result rejected: not a JSON object')
  const r = raw as Record<string, JsonValue>
  if (r.progress === undefined || JSON.stringify(r.progress).length > 16_384) throw new HodosError('INVALID_INPUT', 'step result rejected: missing or oversized progress')
  if (r.status === 'continue') {
    const message = r.message
    if (message !== undefined && (typeof message !== 'string' || message.length > 500)) throw new HodosError('INVALID_INPUT', 'step result rejected: invalid message')
    return { status: 'continue', progress: r.progress, ...(typeof message === 'string' ? { message } : {}) }
  }
  if (r.status === 'complete') return { status: 'complete', progress: r.progress, grade: validateGradeResult(r.grade, skills) }
  throw new HodosError('INVALID_INPUT', 'step result rejected: unknown status')
}
