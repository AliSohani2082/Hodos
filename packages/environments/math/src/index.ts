/**
 * Hodos Math: a DeepSeek Harness bundle whose Cordis entry registers the math
 * environment with the `hodos` service. Also usable directly through
 * {@link createMathPlugin} by any Hodos host.
 * @module @hodos/math
 */
import { createCordisEntry } from '@hodos/plugin-sdk'
import { createMathPlugin } from './plugin.js'

export { createMathPlugin, rendererRoot } from './plugin.js'
/** Host-neutral factory every Hodos environment package exports. */
export { createMathPlugin as createPlugin } from './plugin.js'
export { expressionsCourse, linesCourse, mathPack, SKILL } from './content.js'
export { FORM_CREDIT, FORM_MISCONCEPTIONS, gradeMath } from './grader.js'
export { ENVIRONMENT, FORMS, KIND, KINDS, meetsForm, type Form } from './kinds.js'
export { equivalent, evaluate, parse, type Expr } from './expr.js'
export { sampleFunction, serializeMath, toMathTree, toText } from './present.js'

const entry = createCordisEntry(createMathPlugin())

/** Cordis plugin name. */
export const name = entry.name

/** Services this plugin needs: the Hodos service from `@hodos/dsh`. */
export const inject = entry.inject

/** Cordis entry: register the environment while the plugin is loaded. */
export const apply = entry.apply
