/**
 * The Hodos chess environment plugin.
 * @module @hodos/chess/plugin
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_PLUGIN_API_VERSION, SDK_VERSION, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { chessPack } from './content.js'
import { UciEngine } from './engine.js'
import { gradeIdentify, stepPuzzle } from './grader.js'
import { ENVIRONMENT, GRADER_ID, identifyKind, positionBlock, puzzleKind, RENDERER_ID } from './kinds.js'
import { expandPuzzles } from './puzzles.js'
import { STOCKFISH_VERIFICATION } from './verification.js'

/** Plugin options (from the DSH bundle row's config). */
export interface ChessOptions {
  /** Absolute path of a UCI engine (e.g. Stockfish) used to accept equally strong alternative moves. Empty disables it. */
  readonly stockfishPath?: string
}

/**
 * Hash of the expanded puzzle set (mirrors included): Stockfish verification
 * applies only to the exact positions and lines it checked.
 */
export function puzzleSetHash(): string {
  const checked = expandPuzzles().map(p => [p.id, p.fen, p.line, p.alternatives ?? [], p.goal, p.theme, p.engineChecked])
  return createHash('sha256').update(JSON.stringify(checked)).digest('hex')
}

/** Puzzle ids confirmed by the recorded Stockfish run, if it matches the current puzzle set. */
export function engineVerifiedIds(): ReadonlySet<string> {
  return STOCKFISH_VERIFICATION.puzzleSetHash === puzzleSetHash() ? new Set(STOCKFISH_VERIFICATION.verified) : new Set()
}

/** Directory of the built board renderer. */
export function rendererRoot(): string {
  return fileURLToPath(new URL('../renderer/dist', import.meta.url))
}

/**
 * Create the plugin.
 * @param options - engine configuration.
 * @returns the environment plugin.
 */
export function createChessPlugin(options: ChessOptions = {}): HodosEnvironmentPlugin {
  return {
    manifest: {
      id: 'hodos-chess',
      version: '0.1.0',
      displayName: 'Hodos Chess',
      description: 'Chess tactics on a legal-move board: forks, pins, skewers and mate in one.',
      requiresCore: `^${CORE_PLUGIN_API_VERSION}`,
      sdkVersion: SDK_VERSION,
      license: 'MIT',
      capabilities: {
        environments: [ENVIRONMENT],
        exerciseKinds: [puzzleKind.id, identifyKind.id],
        graders: [GRADER_ID],
        lessonBlocks: [positionBlock.name],
        presets: ['chess-tactics@1'],
        renderers: [RENDERER_ID],
        contentPacks: ['chess-tactics'],
      },
    },
    register(ctx) {
      const path = options.stockfishPath ?? ''
      let engine: UciEngine | null = null
      if (path !== '') {
        if (isAbsolute(path) && existsSync(path)) {
          ctx.logger.info(`using engine ${path} to accept alternative solutions`)
        } else {
          ctx.logger.warn(`stockfishPath ${path} is not an absolute path to an existing file; engine checks are off`)
        }
      }
      const useEngine = (): UciEngine | null => {
        if (path === '' || !isAbsolute(path) || !existsSync(path)) return null
        engine ??= new UciEngine(path)
        return engine
      }
      ctx.onDispose(() => engine?.dispose())
      ctx.registerGrader({
        id: GRADER_ID,
        kinds: [puzzleKind.id, identifyKind.id],
        method: 'deterministic',
        grade: gradeIdentify,
        step: input => stepPuzzle(input, { engine: useEngine }),
      })
      ctx.registerExerciseKind(puzzleKind)
      ctx.registerExerciseKind(identifyKind)
      ctx.registerLessonBlock(positionBlock)
      ctx.registerPreset({
        id: 'chess-tactics@1',
        title: 'Chess tactics',
        kindLoops: { pattern: 'recognize-fast', judgment: 'recognize-fast' },
        tutor: { maxHintLevel: 5 },
        lessonTemplate: 'Introduce the pattern with one chess-position diagram, state the key idea in a callout, then one check question.',
      })
      ctx.registerRenderer({ id: RENDERER_ID, environments: [ENVIRONMENT], root: rendererRoot(), entry: 'index.html', capabilities: ['respond', 'resize'] })
      ctx.registerContentPack(chessPack(engineVerifiedIds()))
    },
  }
}
