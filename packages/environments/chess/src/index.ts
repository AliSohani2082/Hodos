/**
 * Hodos Chess: a DeepSeek Harness bundle whose Cordis entry registers the
 * chess environment with the `hodos` service. Also usable directly through
 * {@link createChessPlugin} by any Hodos host.
 * @module @hodos/chess
 */
import type { HodosEnvironmentHost } from '@hodos/plugin-sdk'
import { createChessPlugin } from './plugin.js'

export { createChessPlugin, engineVerifiedIds, puzzleSetHash, rendererRoot, type ChessOptions } from './plugin.js'
export { chessPack, tacticsCourse } from './content.js'
export { expandPuzzles, PUZZLES, SKILL, type Puzzle, type PuzzleSpec } from './puzzles.js'
export { UciEngine, scoreCp, type EngineAnalysis } from './engine.js'
export { validatePuzzleItem } from './kinds.js'
export { describePosition, mirrorFen, mirrorSan, parseMove } from './position.js'

/** Cordis plugin name. */
export const name = 'hodos-chess'

/** Services this plugin needs: the Hodos service from `@hodos/dsh`. */
export const inject = ['hodos']

/** The structural Cordis context this entry uses. */
interface HostContext {
  readonly hodos: HodosEnvironmentHost
  effect(execute: () => Promise<() => Promise<void>>, label?: string): unknown
}

/**
 * Cordis entry: register the environment while the plugin is loaded.
 * @param ctx - plugin context with the `hodos` service.
 * @param config - `{ stockfishPath?: string }` from the bundle row.
 */
export function apply(ctx: HostContext, config: unknown): void {
  const raw = typeof config === 'object' && config !== null && 'stockfishPath' in config ? config.stockfishPath : undefined
  const stockfishPath = typeof raw === 'string' ? raw : ''
  ctx.effect(() => ctx.hodos.registerEnvironment(createChessPlugin({ stockfishPath })), 'hodos environment hodos-chess')
}
