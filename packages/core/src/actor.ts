/**
 * The trusted caller of a Hodos operation. Hosts build it from their own
 * authentication and session runtime, never from model-supplied arguments.
 * @module @hodos/core/actor
 */
import type { LearnerId } from './ids.js'

/** Where a request came from: the learner's workspace, an agent's tool call, or Hodos itself. */
export type Channel = 'ui' | 'agent' | 'system'

/** The authenticated caller of an operation. */
export interface Actor {
  readonly learnerId: LearnerId
  readonly channel: Channel
  /** Host session (e.g. a DeepSeek Harness session) the request came from. */
  readonly sessionId?: string
}
