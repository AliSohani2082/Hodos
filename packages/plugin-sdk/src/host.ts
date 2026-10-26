/**
 * Host bindings that let an environment plugin mount itself into a running
 * Hodos host without importing the host. The DeepSeek Harness adapter
 * provides a Cordis service named `hodos` implementing {@link HodosEnvironmentHost};
 * {@link createCordisEntry} returns a structurally typed Cordis plugin that
 * registers into it, so environment packages need no Cordis or core import.
 * @module @hodos/plugin-sdk/host
 */
import type { HodosEnvironmentPlugin } from './plugin.js'

/** The registration face a host exposes to environment plugins. */
export interface HodosEnvironmentHost {
  /**
   * Register an environment plugin.
   * @param plugin - the plugin to validate and register.
   * @returns a disposer that unregisters everything the plugin contributed.
   */
  registerEnvironment(plugin: HodosEnvironmentPlugin): Promise<() => Promise<void>>
}

/** The subset of a Cordis context the entry uses. */
export interface CordisLikeContext {
  readonly hodos: HodosEnvironmentHost
  effect(execute: () => Promise<() => Promise<void>>, label?: string): unknown
}

/** A Cordis plugin object (name, service dependencies, apply). */
export interface CordisEntry {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: CordisLikeContext): void
}

/**
 * Build the Cordis plugin that mounts an environment plugin into the `hodos`
 * service. Cordis keeps the entry pending until `hodos` exists and disposes
 * the registration when either side unloads.
 * @param plugin - the environment plugin.
 * @returns a Cordis object plugin; export its fields as the module's `name`, `inject` and `apply`.
 */
export function createCordisEntry(plugin: HodosEnvironmentPlugin): CordisEntry {
  return {
    name: `hodos-environment:${plugin.manifest.id}`,
    inject: ['hodos'],
    apply(ctx) {
      ctx.effect(() => ctx.hodos.registerEnvironment(plugin), `hodos environment ${plugin.manifest.id}`)
    },
  }
}
