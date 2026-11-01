/**
 * Hodos Language: a DeepSeek Harness bundle whose Cordis entry registers the
 * language environment with the `hodos` service. Also usable directly through
 * {@link createLanguagePlugin} by any Hodos host.
 * @module @hodos/language
 */
import { createCordisEntry } from '@hodos/plugin-sdk'
import { createLanguagePlugin } from './plugin.js'

export { createLanguagePlugin } from './plugin.js'
/** Host-neutral factory every Hodos environment package exports. */
export { createLanguagePlugin as createPlugin } from './plugin.js'
export { languagePack, SKILL, spanishCourse } from './content.js'
export { ACCENT_CREDIT, gradeLanguage, MISCONCEPTIONS } from './grader.js'
export { BLANK, ENVIRONMENT, GRADER_ID, KIND, KINDS, phraseBlock } from './kinds.js'
export { canonical, match, withoutAccents, type Match } from './normalize.js'

const entry = createCordisEntry(createLanguagePlugin())

/** Cordis plugin name. */
export const name = entry.name

/** Services this plugin needs: the Hodos service from `@hodos/dsh`. */
export const inject = entry.inject

/** Cordis entry: register the environment while the plugin is loaded. */
export const apply = entry.apply
