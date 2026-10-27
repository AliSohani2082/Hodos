/**
 * Configuration of the Hodos DSH plugin. Values come from the bundle patch
 * row (`cordis.patch.yml`) and can be overridden in a profile's patch.
 * @module @hodos/dsh/config
 */
import Schema from '@deepseek-ai/schemastery'
import { BUILT_IN_ENVIRONMENTS } from './trust.js'

/** The DSH principal every authenticated browser and agent maps to (DSH has one owner principal). */
export const OWNER_PRINCIPAL = 'dsh:owner'

/** How Hodos changes the tools of a session once it becomes a tutoring session. */
export type TutorToolPolicy = 'restricted' | 'unrestricted'

/** Plugin configuration. */
export interface HodosConfig {
  /** Directory for the Hodos database. */
  dataDir: string
  /** Environment plugin ids whose in-process graders and validators run (host allowlist). */
  trustedPlugins: string[]
  /** Directories holding declarative (untrusted, sandboxed) environment plugins. */
  pluginDirs: string[]
  /**
   * `restricted`: a chat that is a Hodos learning or practice session sees
   * only Hodos tools and DSH's own question tool (no shell, filesystem,
   * network or credential tools). `unrestricted` keeps the session's other tools.
   */
  tutorTools: TutorToolPolicy
  /** Background model calls (knowledge-graph extraction) per learner per 24 hours. */
  backgroundCallsPerDay: number
  /** Subagent provider for course drafting; empty picks the first provider with structured output. */
  delegateProvider: string
  /**
   * Import course files from `<dataDir>/inbox` (written by `hodos course
   * submit`) as drafts that wait for the learner's approval.
   */
  courseInbox: boolean
  /** Threshold at which a plan node counts as mastered (θ = 0.90 / 0.95 / 0.98). */
  strictness: 'lenient' | 'standard' | 'strict'
}

/**
 * Schemastery schema of {@link HodosConfig}. Its output type is checked
 * against the interface where the plugin applies it (`index.ts`).
 */
export const Config = Schema.object({
  dataDir: Schema.string().required().description('Directory for the Hodos database (learning records).'),
  trustedPlugins: Schema.array(Schema.string()).default([...BUILT_IN_ENVIRONMENTS])
    .description('Environment plugins whose in-process graders run. Others must ship sandboxed graders.'),
  pluginDirs: Schema.array(Schema.string()).default([])
    .description('Directories of declarative environment plugins (hodos-plugin.json), loaded as data.'),
  tutorTools: Schema.union(['restricted', 'unrestricted'] as const).default('restricted')
    .description('Hide non-Hodos tools in chats that are Hodos learning or practice sessions.'),
  backgroundCallsPerDay: Schema.natural().default(60)
    .description('Background model calls (knowledge-graph extraction) per learner per 24 hours; 0 turns extraction off.'),
  delegateProvider: Schema.string().default('').description('Subagent provider used to draft courses.'),
  courseInbox: Schema.boolean().default(true).description('Import course files from <dataDir>/inbox as drafts awaiting approval.'),
  strictness: Schema.union(['lenient', 'standard', 'strict'] as const).default('standard').description('Mastery threshold for plan nodes.'),
})
