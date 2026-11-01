/**
 * The port through which the core makes background model calls (graph
 * extraction, identity audits). The host supplies it: on DeepSeek Harness,
 * a tool-free call on the user's default model. Tests supply a scripted fake.
 * @module @hodos/core/model
 */

/** One tool-free model call. */
export interface ModelRequest {
  /** What the call is for, for logs and budgets (for example `graph.extract`). */
  readonly purpose: string
  readonly system: string
  readonly prompt: string
  readonly maxOutputTokens: number
  readonly signal?: AbortSignal
}

/** The model's reply. */
export interface ModelReply {
  readonly text: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** Makes background model calls. */
export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelReply>
}

/**
 * Read the JSON object in a model reply: the whole reply, a fenced block,
 * or the outermost braces.
 * @param text - the reply.
 * @returns the object, or an error message for the model.
 */
export function parseJsonReply(text: string): Record<string, unknown> | string {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/u.exec(text)
  const candidates = [text.trim(), fenced?.[1]?.trim() ?? '']
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // Try the next candidate; the error below covers all of them.
    }
  }
  return 'the reply must be one JSON object and nothing else'
}
