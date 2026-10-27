/**
 * The `hodos` Cordis service: owns the Hodos database, the plugin registry,
 * the sandbox worker, the learning, knowledge-graph and practice services,
 * and the course store used for question banks, for one DSH process.
 * Environment bundles inject it and call {@link HodosService.registerEnvironment}.
 * @module @hodos/dsh/service
 */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  GraphRepository,
  HodosEngine,
  HodosStore,
  KnowledgeService,
  LearnRepository,
  LearnService,
  loadDeclarativePlugin,
  PluginRegistry,
  PracticeService,
  SandboxRunner,
  THETA_BY_STRICTNESS,
  DEFAULT_MASTERY_CONFIG,
  type Actor,
  type LearnerId,
  type LearnPhase,
  type ModelPort,
} from '@hodos/core'
import type { HodosEnvironmentHost, HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { OWNER_PRINCIPAL, type HodosConfig } from './config.js'
import { CourseInbox, INBOX_DIR } from './inbox.js'

/** How often the course inbox is checked for new files. */
export const INBOX_POLL_MS = 3000

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

/** What a DSH chat is to Hodos. */
export type ChatBinding =
  | { readonly kind: 'learn'; readonly sessionId: string; readonly phase: LearnPhase }
  | { readonly kind: 'practice'; readonly sessionId: string; readonly closed: boolean }

/** The Hodos service. */
export class HodosService extends Service implements HodosEnvironmentHost {
  readonly store: HodosStore
  readonly registry: PluginRegistry
  /** Course storage, validation and the inbox: installed courses serve as question banks. */
  readonly engine: HodosEngine
  readonly learnRepo: LearnRepository
  readonly graph: GraphRepository
  readonly learn: LearnService
  readonly knowledge: KnowledgeService
  readonly practice: PracticeService
  readonly logger: HodosLogger
  private readonly sandbox: SandboxRunner
  private model: ModelPort | null = null
  private delivery: ((chatId: string, text: string, summary: string) => boolean) | null = null
  private readonly changeListeners = new Set<(sessionId: string) => void>()
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
    this.learnRepo = new LearnRepository(this.store)
    this.graph = new GraphRepository(this.store)
    this.learn = new LearnService({ repository: this.learnRepo, registry: this.registry, logger: this.logger, theta: THETA_BY_STRICTNESS[config.strictness] })
    this.knowledge = new KnowledgeService({ graph: this.graph, learn: this.learnRepo, model: () => this.model, logger: this.logger, budget: { callsPerDay: config.backgroundCallsPerDay } })
    this.practice = new PracticeService({ store: this.store, graph: this.graph })
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
    if (this.config.courseInbox) await this.startInbox()
  }

  /** Import inbox files now and every few seconds while the service runs. */
  private async startInbox(): Promise<void> {
    const inbox = new CourseInbox({
      dir: join(this.config.dataDir, INBOX_DIR),
      propose: (proposal, source) => this.engine.proposeCourse(this.uiActor(undefined), proposal, { origin: 'import', source }),
      logger: this.logger,
    })
    try {
      await inbox.prepare()
    } catch (error) {
      this.logger.error(`course inbox is unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const scan = (): void => {
      inbox.scan().catch((error: unknown) => this.logger.warn(`course inbox scan failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    scan()
    const timer = setInterval(scan, INBOX_POLL_MS)
    timer.unref()
    this.ctx.effect(() => () => clearInterval(timer), 'hodos course inbox')
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
   * Offer a model for background work (graph extraction). The host's
   * model plugin calls this; without it, extraction reports that no model
   * is available.
   * @param port - the model port.
   * @returns a disposer that withdraws it.
   */
  setModel(port: ModelPort): () => void {
    this.model = port
    return () => { if (this.model === port) this.model = null }
  }

  /**
   * Set how messages from the Hodos panel reach a chat's agent (the tools plugin does).
   * @param deliver - starts a turn in the chat, or holds the message until its agent runs.
   * @returns a disposer.
   */
  setDelivery(deliver: (chatId: string, text: string, summary: string) => boolean): () => void {
    this.delivery = deliver
    return () => { if (this.delivery === deliver) this.delivery = null }
  }

  /**
   * Start a turn in a chat with a message from the Hodos panel.
   * @param chatId - DSH session id.
   * @param text - the message for the tutor.
   * @param summary - a one-line account.
   * @returns whether it was delivered or queued.
   */
  deliver(chatId: string, text: string, summary: string): boolean {
    if (this.delivery === null) {
      this.logger.warn(`no agent runtime to deliver a Hodos message to ${chatId}`)
      return false
    }
    return this.delivery(chatId, text, summary)
  }

  /** Whether a model is available for background work. */
  hasModel(): boolean {
    return this.model !== null
  }

  /**
   * Announce that a chat became a Hodos session or its phase changed, so its
   * tools and prompt follow.
   * @param sessionId - DSH session id.
   */
  notifyChanged(sessionId: string): void {
    for (const listener of this.changeListeners) {
      try {
        listener(sessionId)
      } catch (error) {
        this.logger.warn(`session listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * @param listener - called when a chat is bound or its phase changes.
   * @returns the unsubscriber.
   */
  onChanged(listener: (sessionId: string) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
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
   * What a DSH chat is to Hodos.
   * @param sessionId - DSH session id (trusted, from the host runtime).
   * @returns the binding, or null for an ordinary chat.
   */
  binding(sessionId: string): ChatBinding | null {
    const learn = this.learn.sessionForHost(sessionId)
    if (learn !== undefined) return { kind: 'learn', sessionId: learn.id, phase: learn.phase }
    const practice = this.practice.sessionForHost(sessionId)
    if (practice !== undefined) return { kind: 'practice', sessionId: practice.id, closed: practice.status === 'closed' }
    return null
  }

  /**
   * Whether a chat is an open Hodos session (its tools are restricted and its prompt is the tutor's).
   * @param sessionId - DSH session id.
   * @returns true for an open learning or practice session.
   */
  isTutorSession(sessionId: string): boolean {
    const b = this.binding(sessionId)
    return b !== null && (b.kind === 'learn' ? b.phase !== 'closed' : !b.closed)
  }
}
