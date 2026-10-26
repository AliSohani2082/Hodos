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

/** How Hodos tells the tutor agent about learner activity in the workspace. */
export type NoticePolicy = 'off' | 'quiet' | 'proactive'

/** Plugin configuration. */
export interface HodosConfig {
  /** Directory for the Hodos database. */
  dataDir: string
  /** Environment plugin ids whose in-process graders and validators run (host allowlist). */
  trustedPlugins: string[]
  /** Directories holding declarative (untrusted, sandboxed) environment plugins. */
  pluginDirs: string[]
  /**
   * `restricted`: a session bound to a learning journey sees only Hodos tools
   * (no shell, filesystem, network or credential tools). `unrestricted` keeps
   * the session's other tools.
   */
  tutorTools: TutorToolPolicy
  /**
   * `quiet`: workspace activity is queued as context for the tutor's next step
   * (no extra model calls). `proactive`: checkpoint results and stuck learners
   * also wake the tutor (rate-limited). `off`: no notices.
   */
  notices: NoticePolicy
  /** Subagent provider for course drafting; empty picks the first provider with structured output. */
  delegateProvider: string
  /**
   * Import course files from `<dataDir>/inbox` (written by `hodos course
   * submit`) as drafts that wait for the learner's approval.
   */
  courseInbox: boolean
  /** Mastery gate strictness (θ = 0.90 / 0.95 / 0.98). */
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
    .description('Hide non-Hodos tools in sessions bound to a learning journey.'),
  notices: Schema.union(['off', 'quiet', 'proactive'] as const).default('quiet')
    .description('How the tutor hears about workspace activity.'),
  delegateProvider: Schema.string().default('').description('Subagent provider used to draft courses.'),
  courseInbox: Schema.boolean().default(true).description('Import course files from <dataDir>/inbox as drafts awaiting approval.'),
  strictness: Schema.union(['lenient', 'standard', 'strict'] as const).default('standard').description('Mastery gate strictness.'),
})
