/**
 * Hodos Code: a DeepSeek Harness bundle whose Cordis entry registers the code
 * environment with the `hodos` service. Also usable directly through
 * {@link createCodePlugin} by any Hodos host; a host with an isolated code
 * runner passes it there to offer code-writing exercises.
 * @module @hodos/code
 */
import { createCordisEntry } from '@hodos/plugin-sdk'
import { createCodePlugin } from './plugin.js'

export { cpythonVerifiedIds, createCodePlugin, rendererRoot, snippetSetHash, type CodePluginOptions } from './plugin.js'
/** Host-neutral factory every Hodos environment package exports. */
export { createCodePlugin as createPlugin } from './plugin.js'
export { codePack, FEEDBACK, SKILL, snippets, tracingCourse, type Snippet } from './content.js'
export { createWriteGrader, FORMAT_CREDIT, gradePredict, gradeSandbox, OUTPUT_MISCONCEPTIONS } from './grader.js'
export { ENVIRONMENT, KIND, listing, predictKind, programProblems, SANDBOX_ENVIRONMENT, SANDBOX_LIMITS, sandboxKind, sandboxTests, snippetBlock, writeKind } from './kinds.js'
export { compareOutput, outputLines, sameOutput, type OutputDifference } from './output.js'
export { calledNames, importedModules, tokenize, type Token, type TokenType } from './python.js'
export { checkOutcomes, DEFAULT_LIMITS, MAX_RUNS, RUN_STATUSES, RUNNER_REQUIREMENTS, runAll, type CodeRunner, type RunLimits, type RunOutcome, type RunRequest, type RunStatus } from './runner.js'

// The Cordis entry offers no runner: DeepSeek Harness hosts get output-prediction exercises only.
const entry = createCordisEntry(createCodePlugin())

/** Cordis plugin name. */
export const name = entry.name

/** Services this plugin needs: the Hodos service from `@hodos/dsh`. */
export const inject = entry.inject

/** Cordis entry: register the environment while the plugin is loaded. */
export const apply = entry.apply
