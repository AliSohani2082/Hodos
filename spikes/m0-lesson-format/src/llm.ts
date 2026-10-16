// LLM client abstraction: the real Anthropic client for runs, a scripted stub for offline tests.
import Anthropic from '@anthropic-ai/sdk'
import type { Usage } from './score.ts'
import type { Model } from './types.ts'

export interface Turn {
  role: 'user' | 'assistant'
  /** For assistant turns, the API content blocks exactly as returned (thinking blocks included, append-only). */
  content: string | Anthropic.ContentBlockParam[]
  /** Cache breakpoint after this turn (user turns only). */
  cache?: boolean
}

export interface CompleteRequest {
  model: Model
  system: string
  turns: Turn[]
  maxTokens: number
  /** JSON Schema for structured output (judge calls). */
  schema?: Record<string, unknown>
}

export interface CompleteResult {
  text: string
  stopReason: string | null
  usage: Usage
  ms: number
  /** Content to send back as the assistant turn on repair. */
  raw: Anthropic.ContentBlockParam[] | string
}

export interface LlmClient {
  complete(req: CompleteRequest): Promise<CompleteResult>
  countTokens?(model: Model, text: string): Promise<number>
}

/** Effort is set explicitly to medium for all three models, because defaults differ by model (§8.4). */
export class AnthropicLlm implements LlmClient {
  private client = new Anthropic()

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const started = Date.now()
    const messages: Anthropic.MessageParam[] = req.turns.map((t) => ({
      role: t.role,
      content:
        t.cache && typeof t.content === 'string'
          ? [{ type: 'text', text: t.content, cache_control: { type: 'ephemeral' } }]
          : t.content,
    }))
    const msg = await this.client.messages
      .stream({
        model: req.model,
        max_tokens: req.maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}) },
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages,
      })
      .finalMessage()
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    return {
      text,
      stopReason: msg.stop_reason,
      usage: {
        input: msg.usage.input_tokens,
        output: msg.usage.output_tokens,
        cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
        cacheRead: msg.usage.cache_read_input_tokens ?? 0,
        thinking: msg.usage.output_tokens_details?.thinking_tokens,
      },
      ms: Date.now() - started,
      raw: msg.content as Anthropic.ContentBlockParam[],
    }
  }

  async countTokens(model: Model, text: string): Promise<number> {
    const r = await this.client.messages.countTokens({ model, messages: [{ role: 'user', content: text }] })
    return r.input_tokens
  }
}

export type { Anthropic }
