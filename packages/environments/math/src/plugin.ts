/**
 * The Hodos math environment plugin.
 * @module @hodos/math/plugin
 */
import { fileURLToPath } from 'node:url'
import { CORE_PLUGIN_API_VERSION, SDK_VERSION, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { mathPack } from './content.js'
import { gradeMath } from './grader.js'
import { ENVIRONMENT, formulaBlock, GRADER_ID, graphBlock, KINDS, RENDERER_ID } from './kinds.js'

/** Directory of the built renderer. */
export function rendererRoot(): string {
  return fileURLToPath(new URL('../renderer/dist', import.meta.url))
}

/**
 * Create the plugin.
 * @returns the environment plugin.
 */
export function createMathPlugin(): HodosEnvironmentPlugin {
  return {
    manifest: {
      id: 'hodos-math',
      version: '0.1.0',
      displayName: 'Hodos Math',
      description: 'Algebra basics: simplify, expand, factor, solve linear equations and read slopes.',
      requiresCore: `^${CORE_PLUGIN_API_VERSION}`,
      sdkVersion: SDK_VERSION,
      license: 'MIT',
      capabilities: {
        environments: [ENVIRONMENT],
        exerciseKinds: KINDS.map(k => k.id),
        graders: [GRADER_ID],
        lessonBlocks: [formulaBlock.name, graphBlock.name],
        presets: ['math-practice@1'],
        renderers: [RENDERER_ID],
        contentPacks: ['algebra-basics'],
      },
    },
    register(ctx) {
      ctx.registerGrader({ id: GRADER_ID, kinds: KINDS.map(k => k.id), method: 'deterministic', grade: gradeMath })
      for (const kind of KINDS) ctx.registerExerciseKind(kind)
      ctx.registerLessonBlock(formulaBlock)
      ctx.registerLessonBlock(graphBlock)
      ctx.registerPreset({
        id: 'math-practice@1',
        title: 'Math practice',
        kindLoops: { procedure: 'drill' },
        tutor: { maxHintLevel: 5 },
        lessonTemplate: 'State the rule, show one worked example with math-formula blocks (or a math-graph), then one check question.',
      })
      ctx.registerRenderer({ id: RENDERER_ID, environments: [ENVIRONMENT], root: rendererRoot(), entry: 'index.html', capabilities: ['resize'] })
      ctx.registerContentPack(mathPack())
    },
  }
}
