/**
 * The Hodos language environment plugin.
 * @module @hodos/language/plugin
 */
import { CORE_PLUGIN_API_VERSION, SDK_VERSION, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { languagePack } from './content.js'
import { gradeLanguage } from './grader.js'
import { ENVIRONMENT, GRADER_ID, KINDS, phraseBlock } from './kinds.js'

/**
 * Create the plugin.
 * @returns the environment plugin.
 */
export function createLanguagePlugin(): HodosEnvironmentPlugin {
  return {
    manifest: {
      id: 'hodos-language',
      version: '0.1.0',
      displayName: 'Hodos Language',
      description: 'English→Spanish basics: vocabulary, articles, ser and estar, word order and translation.',
      requiresCore: `^${CORE_PLUGIN_API_VERSION}`,
      sdkVersion: SDK_VERSION,
      license: 'MIT',
      capabilities: {
        environments: [ENVIRONMENT],
        exerciseKinds: KINDS.map(k => k.id),
        graders: [GRADER_ID],
        lessonBlocks: [phraseBlock.name],
        presets: ['language-basics@1'],
        contentPacks: ['spanish-basics'],
      },
    },
    register(ctx) {
      ctx.registerGrader({ id: GRADER_ID, kinds: KINDS.map(k => k.id), method: 'deterministic', grade: gradeLanguage })
      for (const kind of KINDS) ctx.registerExerciseKind(kind)
      ctx.registerLessonBlock(phraseBlock)
      ctx.registerPreset({
        id: 'language-basics@1',
        title: 'Language basics',
        kindLoops: { fact: 'drill', procedure: 'drill' },
        review: { targetRetention: 0.9 },
        tutor: { maxHintLevel: 5 },
        lessonTemplate: 'Introduce the words with language-phrase blocks, state the rule in a callout, show one worked example, then one check question.',
      })
      ctx.registerContentPack(languagePack())
    },
  }
}
