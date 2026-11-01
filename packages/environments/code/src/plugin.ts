/**
 * The Hodos code environment plugin.
 * @module @hodos/code/plugin
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CORE_PLUGIN_API_VERSION, SDK_VERSION, type HodosEnvironmentPlugin } from '@hodos/plugin-sdk'
import { codePack, snippets } from './content.js'
import { createWriteGrader, gradePredict, gradeSandbox } from './grader.js'
import { ENVIRONMENT, GRADER_ID, KIND, predictKind, RENDERER_ID, RUNNER_GRADER_ID, SANDBOX_ENVIRONMENT, SANDBOX_GRADER_ID, SANDBOX_RENDERER_ID, sandboxKind, snippetBlock, writeKind } from './kinds.js'
import type { CodeRunner } from './runner.js'
import { CPYTHON_VERIFICATION } from './verification.js'

/** Hash of every program with a known output; the CPython record applies only to this set. */
export function snippetSetHash(): string {
  return createHash('sha256').update(JSON.stringify(snippets().map(s => [s.id, s.source, s.output]))).digest('hex')
}

/** Ids whose output the recorded CPython run confirmed, if it matches the current programs. */
export function cpythonVerifiedIds(): ReadonlySet<string> {
  return CPYTHON_VERIFICATION.snippetSetHash === snippetSetHash() ? new Set(CPYTHON_VERIFICATION.verified) : new Set()
}

/** Directory of the built renderer. */
export function rendererRoot(): string {
  return fileURLToPath(new URL('../renderer/dist', import.meta.url))
}

/** Options of {@link createCodePlugin}. */
export interface CodePluginOptions {
  /**
   * An isolated runner supplied by the host (see `RUNNER_REQUIREMENTS`).
   * Without one, `code.write` is not offered at all.
   */
  readonly runner?: CodeRunner
  /** How long one grading may wait for the runner; keep it below the host's grading timeout (5 s by default). */
  readonly runnerBudgetMs?: number
}

/**
 * Create the plugin.
 * @param options - an optional isolated runner.
 * @returns the environment plugin.
 */
export function createCodePlugin(options: CodePluginOptions = {}): HodosEnvironmentPlugin {
  const { runner } = options
  if (runner !== undefined && (!runner.languages.includes('python') || runner.isolation.trim() === '')) {
    throw new Error('the code runner must run python and describe its isolation')
  }
  const kinds = runner === undefined ? [predictKind, sandboxKind] : [predictKind, sandboxKind, writeKind]
  return {
    manifest: {
      id: 'hodos-code',
      version: '0.1.0',
      displayName: 'Hodos Code',
      description: runner === undefined
        ? 'Read, trace and write Python: predict what programs print, and write programs in a sandbox that runs in your browser.'
        : `Read, trace and write Python. Programs run in your browser, or in the host's runner (${runner.isolation}) for hidden tests.`,
      requiresCore: `^${CORE_PLUGIN_API_VERSION}`,
      sdkVersion: SDK_VERSION,
      license: 'MIT',
      capabilities: {
        environments: [ENVIRONMENT, SANDBOX_ENVIRONMENT],
        exerciseKinds: kinds.map(k => k.id),
        graders: runner === undefined ? [GRADER_ID, SANDBOX_GRADER_ID] : [GRADER_ID, SANDBOX_GRADER_ID, RUNNER_GRADER_ID],
        lessonBlocks: [snippetBlock.name],
        presets: ['code-reading@1'],
        renderers: [RENDERER_ID, SANDBOX_RENDERER_ID],
        contentPacks: ['python-basics'],
      },
      // The sandbox renderer runs Python (Pyodide, WebAssembly) in a worker inside its sandboxed frame.
      rendererPermissions: ['run-code'],
    },
    register(ctx) {
      ctx.registerGrader({ id: GRADER_ID, kinds: [KIND.predict], method: 'deterministic', grade: gradePredict })
      ctx.registerGrader({ id: SANDBOX_GRADER_ID, kinds: [KIND.sandbox], method: 'self-report', grade: gradeSandbox })
      if (runner !== undefined) {
        ctx.registerGrader({ id: RUNNER_GRADER_ID, kinds: [KIND.write], method: 'oracle', grade: createWriteGrader(runner, options.runnerBudgetMs ?? 4500) })
        ctx.logger.info(`code.write is offered; programs run in the host's runner (${runner.isolation})`)
      }
      for (const kind of kinds) ctx.registerExerciseKind(kind)
      ctx.registerLessonBlock(snippetBlock)
      ctx.registerPreset({
        id: 'code-reading@1',
        title: 'Code reading',
        tutor: { maxHintLevel: 5 },
        lessonTemplate: 'Explain the rule in two or three sentences, show one code-snippet with its output, then ask one check question. Never show an exercise program\'s output.',
      })
      ctx.registerRenderer({ id: RENDERER_ID, environments: [ENVIRONMENT], root: rendererRoot(), entry: 'index.html', capabilities: ['resize'] })
      ctx.registerRenderer({ id: SANDBOX_RENDERER_ID, environments: [SANDBOX_ENVIRONMENT], root: rendererRoot(), entry: 'sandbox.html', capabilities: ['respond', 'resize', 'run-code'] })
      ctx.registerContentPack(codePack(cpythonVerifiedIds()))
    },
  }
}
