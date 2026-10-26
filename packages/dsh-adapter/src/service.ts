/**
 * The `hodos` Cordis service: owns the Hodos database, the plugin registry,
 * the sandbox worker and the engine for one DSH process. Environment bundles
 * inject it and call {@link HodosService.registerEnvironment}.
 * @module @hodos/dsh/service
 */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  HodosEngine,
  HodosStore,
  loadDeclarativePlugin,
  PluginRegistry,
  SandboxRunner,
  THETA_BY_STRICTNESS,
  DEFAULT_MASTERY_CONFIG,
  type Actor,
  type LearnerId,
} from '@hodos/core'
import type { HodosEnvironmentHost, HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { OWNER_PRINCIPAL, type HodosConfig } from './config.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hodos: HodosService
  }
}

/** Logger shape shared by the registry and engine. */
export interface HodosLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The Hodos service. */
export class HodosService extends Service implements HodosEnvironmentHost {
  readonly store: HodosStore
  readonly registry: PluginRegistry
  readonly engine: HodosEngine
  readonly logger: HodosLogger
  private readonly sandbox: SandboxRunner
  private readonly boundListeners = new Set<(sessionId: string) => void>()
  private readonly globalToolNames = new Set<string>()

  /**
   * @param ctx - plugin context.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, readonly config: HodosConfig) {
    super(ctx, 'hodos')
    const log = ctx.logger('hodos')
    this.logger = { info: m => log.info(m), warn: m => log.warn(m), error: m => log.error(m) }
    this.sandbox = new SandboxRunner()
    this.registry = new PluginRegistry({ sandbox: this.sandbox, logger: this.logger })
    this.store = new HodosStore(join(config.dataDir, 'hodos.db'))
    this.engine = new HodosEngine({
      store: this.store,
      registry: this.registry,
      logger: this.logger,
      config: { mastery: { ...DEFAULT_MASTERY_CONFIG, theta: THETA_BY_STRICTNESS[config.strictness] } },
    })
    ctx.effect(() => () => {
      this.sandbox.dispose()
      this.store.close()
    }, 'hodos storage and sandbox')
  }

  /** Load declarative plugins and import shipped content once the service starts. */
  protected async [Service.init](): Promise<void> {
    for (const dir of this.config.pluginDirs) {
      try {
        const plugin = await loadDeclarativePlugin(dir)
        const dispose = await this.registry.register(plugin, { trusted: false, declarative: true })
        this.ctx.effect(() => () => { void dispose() }, `hodos declarative plugin ${plugin.manifest.id}`)
      } catch (error) {
        // One broken plugin directory must not take Hodos down.
        this.logger.error(`declarative plugin in ${dir} was not loaded: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.syncContent()
  }

  private async syncContent(): Promise<void> {
    for (const rejected of await this.engine.syncContentPacks()) {
      this.logger.error(`course ${rejected.courseId} was rejected: ${rejected.errors.join('; ')}`)
    }
  }

  /**
   * Register an environment plugin. Trust comes from the host allowlist
   * (`trustedPlugins`), never from the plugin.
   * @param plugin - the environment plugin.
   * @returns a disposer that unregisters it.
   */
  async registerEnvironment(plugin: HodosEnvironmentPlugin): Promise<() => Promise<void>> {
    const trusted = this.config.trustedPlugins.includes(plugin.manifest.id)
    const dispose = await this.registry.register(plugin, { trusted })
    await this.syncContent()
    return dispose
  }

  /** The learner of the DSH owner principal. */
  ownerLearner(): LearnerId {
    return this.engine.learnerForPrincipal(OWNER_PRINCIPAL)
  }

  /**
   * The actor for a tool call from an agent session.
   * @param sessionId - the calling agent's session id (from the tool execution, never from arguments).
   * @returns the actor.
   */
  agentActor(sessionId: string): Actor {
    return { learnerId: this.engine.learnerForSession(sessionId, OWNER_PRINCIPAL), channel: 'agent', sessionId }
  }

  /**
   * The actor for an authenticated workspace request.
   * @param sessionId - the DSH session the workspace is shown in, if any.
   * @returns the actor.
   */
  uiActor(sessionId: string | undefined): Actor {
    const learnerId = this.ownerLearner()
    return sessionId === undefined ? { learnerId, channel: 'ui' } : { learnerId, channel: 'ui', sessionId }
  }

  /**
   * Announce that a session was bound to a journey (by a tool or the workspace).
   * @param sessionId - DSH session id.
   */
  notifyBound(sessionId: string): void {
    for (const listener of this.boundListeners) {
      try {
        listener(sessionId)
      } catch (error) {
        this.logger.warn(`session-bound listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * @param listener - called when a session is bound to a journey.
   * @returns the unsubscriber.
   */
  onBound(listener: (sessionId: string) => void): () => void {
    this.boundListeners.add(listener)
    return () => { this.boundListeners.delete(listener) }
  }

  /**
   * Record a globally registered Hodos tool (it stays visible in restricted tutor sessions).
   * @param name - tool name.
   * @returns a disposer that forgets it.
   */
  trackGlobalTool(name: string): () => void {
    this.globalToolNames.add(name)
    return () => { this.globalToolNames.delete(name) }
  }

  /** Globally registered Hodos tool names. */
  globalTools(): string[] {
    return [...this.globalToolNames]
  }

  /**
   * Whether a session is bound to a learning journey.
   * @param sessionId - DSH session id.
   * @returns true when a journey is bound.
   */
  isTutorSession(sessionId: string): boolean {
    const binding = this.store.sessionBinding(sessionId)
    return binding !== undefined && binding.journeyId !== null
  }
}
