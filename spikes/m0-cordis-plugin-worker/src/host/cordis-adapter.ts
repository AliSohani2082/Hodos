// PluginHost over cordis 4.0.0-rc.11. Everything cordis-specific in the platform lives in THIS file.
// Mapping: scope -> ctx.isolate('hodos', Symbol); plugin -> Fiber (lifecycle + disposal); registry -> a Service; registration -> ctx.effect.
import { Context, Service } from 'cordis'
import type { Disposer, PluginModule } from '../sdk/types.ts'
import type { HostEvent, HostRegistry, PluginHandle, PluginHost, PluginState, PluginWorker, ResolvedBlock, ResolvedExerciseKind, ResolvedLayout, ResolvedPreset } from './plugin-host.ts'
import { applyManifest, makeFacade, type EntryMap, type Register } from './resolve.ts'

declare module 'cordis' { interface Context { hodos: HodosRegistry } }

type Listener = (e: HostEvent) => void
const KIND_LABEL = { block: 'blocks', layout: 'layouts', exercise: 'exerciseKinds', preset: 'presets' } as const

class HodosRegistry extends Service {
  readonly maps = { block: new Map<string, ResolvedBlock>(), layout: new Map<string, ResolvedLayout>(), exercise: new Map<string, ResolvedExerciseKind>(), preset: new Map<string, ResolvedPreset>() }
  readonly listeners = new Set<Listener>()
  scopeId = 'default'
  constructor(ctx: Context) { super(ctx, 'hodos') }

  /** `this.ctx` is the calling plugin's context (cordis rebinds it per access), so the entry is owned by that plugin's fiber. */
  add<K extends keyof EntryMap>(kind: K, entry: EntryMap[K]): Disposer {
    const map = this.maps[kind] as Map<string, EntryMap[K]>
    const emit = (type: HostEvent['type']) => this.listeners.forEach((l) => l({ type, kind, name: entry.name, pluginId: entry.pluginId, scope: this.scopeId }))
    return this.ctx.effect(() => {
      if (map.has(entry.name)) throw new Error(`${kind} "${entry.name}" is already registered by plugin "${map.get(entry.name)!.pluginId}"`)
      map.set(entry.name, entry)
      emit('registered')
      return () => { map.delete(entry.name); emit('unregistered') }
    }, `${KIND_LABEL[kind]}(${entry.name})`)
  }
}

const STATE: PluginState[] = ['pending', 'pending', 'active', 'failed', 'disposed', 'disposed']

class CordisHandle implements PluginHandle {
  error: Error | undefined
  constructor(readonly id: string, private fiber: any, private afterDispose: () => void) {}
  get state(): PluginState { return STATE[this.fiber.state] }
  async settled(): Promise<PluginState> { try { await this.fiber.await() } catch (e) { this.error = e as Error } return this.state }
  async dispose() { await this.fiber.dispose(); this.afterDispose() }
  async update(config: unknown) { this.error = undefined; try { await this.fiber.update(config); await this.fiber.await() } catch (e) { this.error = e as Error } return this.state }
}

export class CordisPluginHost implements PluginHost {
  private handles = new Set<CordisHandle>()
  private children = new Set<CordisPluginHost>()
  private registryFiber: any
  readonly registry: HostRegistry
  private constructor(private ctx: Context, private scopeId: string) {
    this.registryFiber = ctx.plugin(HodosRegistry)
    // `ctx.get` returns undefined (instead of throwing) once the registry service is gone, i.e. after dispose: reads then see an empty registry.
    const reg = (): HodosRegistry | undefined => ctx.get('hodos') as HodosRegistry | undefined
    const empty = new Map<string, any>()
    this.registry = { blocks: () => reg()?.maps.block ?? empty, layouts: () => reg()?.maps.layout ?? empty, exerciseKinds: () => reg()?.maps.exercise ?? empty, presets: () => reg()?.maps.preset ?? empty }
  }
  /** Creates a root host. `ready` resolves once its registry service is up. */
  static async create(scopeId = 'default'): Promise<CordisPluginHost> {
    const h = new CordisPluginHost(new Context(), scopeId)
    await h.registryFiber
    h.ctx.hodos.scopeId = scopeId
    return h
  }
  async scope(scopeId: string): Promise<PluginHost> {
    const c = this.ctx.isolate('hodos', Symbol(scopeId))
    const child = new CordisPluginHost(c, scopeId)
    await child.registryFiber
    child.ctx.hodos.scopeId = scopeId
    this.children.add(child)
    return child
  }

  private track(id: string, fiber: any): PluginHandle {
    const h = new CordisHandle(id, fiber, () => this.handles.delete(h))
    this.handles.add(h)
    void h.settled()
    return h
  }
  loadFirstParty(id: string, plugin: PluginModule, config?: unknown): PluginHandle {
    const origin = { pluginId: id, trust: 'first-party' as const, scope: this.scopeId }
    const wrapper = { name: id, inject: ['hodos'], apply: (c: Context, cfg: unknown) => {
      const register: Register = (kind, entry) => c.hodos.add(kind, entry)
      return plugin.apply(makeFacade(origin, register, (fn) => c.effect(() => fn() ?? (() => {}))), cfg)
    } }
    return this.track(id, this.ctx.plugin(wrapper as any, config as any))
  }
  loadSandboxed(id: string, worker: PluginWorker, config?: unknown): PluginHandle {
    const origin = { pluginId: id, trust: 'sandboxed' as const, scope: this.scopeId }
    const wrapper = { name: id, inject: ['hodos'], apply: async (c: Context) => {
      c.effect(() => () => worker.stop(), `worker(${id})`) // registered first, so it is torn down last: entries leave the registry, then the worker dies
      const { manifest } = await worker.start()
      applyManifest(origin, worker, manifest, (kind, entry) => c.hodos.add(kind, entry))
    } }
    return this.track(id, this.ctx.plugin(wrapper as any, config as any))
  }
  onEvent(listener: Listener) { this.ctx.hodos.listeners.add(listener); return () => { this.ctx.hodos.listeners.delete(listener) } }
  async dispose() {
    for (const c of this.children) await c.dispose()
    for (const h of [...this.handles]) await h.dispose()
    await this.registryFiber.dispose()
  }
}
