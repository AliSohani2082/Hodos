// PluginHost WITHOUT cordis: plain Maps and explicit disposer lists, ~60 lines. Exists to prove the interface is swappable and to give the
// conformance suite a second implementation. Not a recommendation: it has no dependency injection, no hot-swapping of services, no fiber states.
import type { Disposer, PluginModule } from '../sdk/types.ts'
import type { HostEvent, HostRegistry, PluginHandle, PluginHost, PluginState, PluginWorker } from './plugin-host.ts'
import { applyManifest, makeFacade, type EntryMap, type Register } from './resolve.ts'

type Maps = { [K in keyof EntryMap]: Map<string, EntryMap[K]> }

class MapHandle implements PluginHandle {
  state: PluginState = 'pending'
  error: Error | undefined
  private disposers: Disposer[] = []
  private run: Promise<void> = Promise.resolve()
  constructor(readonly id: string, private start: (register: Register, effect: (fn: () => Disposer | void) => Disposer, config: unknown) => Promise<void> | void, private host: MapPluginHost, private config: unknown) { this.run = this.apply() }

  private async apply() {
    this.state = 'pending'; this.error = undefined
    const track = (d: Disposer) => { this.disposers.push(d); return d }
    const register: Register = (kind, entry) => {
      const map = this.host.maps[kind] as Map<string, typeof entry>
      if (map.has(entry.name)) throw new Error(`${kind} "${entry.name}" is already registered by plugin "${map.get(entry.name)!.pluginId}"`)
      map.set(entry.name, entry); this.host.emit('registered', kind, entry)
      return track(() => { map.delete(entry.name); this.host.emit('unregistered', kind, entry) })
    }
    try { await this.start(register, (fn) => track(fn() ?? (() => {})), this.config); this.state = 'active' }
    catch (e) { this.error = e as Error; await this.teardown(); this.state = 'failed' }
  }
  private async teardown() { while (this.disposers.length) { try { await this.disposers.pop()!() } catch {} } }
  async settled() { await this.run; return this.state }
  async dispose() { await this.run; await this.teardown(); this.state = 'disposed'; this.host.handles.delete(this) }
  async update(config: unknown) { await this.run; await this.teardown(); this.config = config; this.run = this.apply(); return this.settled() }
}

export class MapPluginHost implements PluginHost {
  readonly maps: Maps = { block: new Map(), layout: new Map(), exercise: new Map(), preset: new Map() }
  readonly handles = new Set<MapHandle>()
  private listeners = new Set<(e: HostEvent) => void>()
  private children = new Set<MapPluginHost>()
  readonly registry: HostRegistry = { blocks: () => this.maps.block, layouts: () => this.maps.layout, exerciseKinds: () => this.maps.exercise, presets: () => this.maps.preset }
  constructor(private scopeId = 'default') {}
  static async create(scopeId = 'default') { return new MapPluginHost(scopeId) }

  emit(type: HostEvent['type'], kind: keyof EntryMap, entry: { name: string; pluginId: string }) { this.listeners.forEach((l) => l({ type, kind, name: entry.name, pluginId: entry.pluginId, scope: this.scopeId })) }
  async scope(scopeId: string): Promise<PluginHost> { const c = new MapPluginHost(scopeId); this.children.add(c); return c }
  loadFirstParty(id: string, plugin: PluginModule, config?: unknown): PluginHandle {
    const origin = { pluginId: id, trust: 'first-party' as const, scope: this.scopeId }
    const h = new MapHandle(id, (register, effect, cfg) => plugin.apply(makeFacade(origin, register, effect), cfg), this, config)
    this.handles.add(h); return h
  }
  loadSandboxed(id: string, worker: PluginWorker, config?: unknown): PluginHandle {
    const origin = { pluginId: id, trust: 'sandboxed' as const, scope: this.scopeId }
    const h = new MapHandle(id, async (register, effect) => {
      effect(() => () => worker.stop())
      const { manifest } = await worker.start()
      applyManifest(origin, worker, manifest, register)
    }, this, config)
    this.handles.add(h); return h
  }
  onEvent(l: (e: HostEvent) => void) { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  async dispose() { for (const c of this.children) await c.dispose(); for (const h of [...this.handles]) await h.dispose() }
}
