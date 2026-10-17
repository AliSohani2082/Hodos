// LLM client abstraction: OpenRouter's OpenAI-compatible streaming endpoint and an offline stub.
import type Anthropic from '@anthropic-ai/sdk'
import type { Usage } from './score.ts'
import { OPENROUTER_MODELS, type Model } from './types.ts'
import { CreditGuard, CreditLimitError } from './credits.ts'

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
  /** Amount already held by the local reserve-before-call budget. */
  reservationUSD?: number
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

/** OpenRouter chat completions; cost is mandatory so the spend ledger uses provider-reported dollars. */
export class OpenRouterLlm implements LlmClient {
  private readonly apiKey = process.env.OPENROUTER_API_KEY
  private readonly credits: CreditGuard

  constructor() {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not set')
    this.credits = new CreditGuard(this.apiKey)
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const started = Date.now()
    const contentText = (content: Turn['content']) => typeof content === 'string'
      ? content
      : content.map((b) => b.type === 'text' ? b.text : '').join('')
    const messages = [
      { role: 'system', content: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] },
      ...req.turns.map((t) => ({
        role: t.role,
        content: t.cache
          ? [{ type: 'text', text: contentText(t.content), cache_control: { type: 'ephemeral' } }]
          : contentText(t.content),
      })),
    ]
    const body: Record<string, unknown> = {
      model: OPENROUTER_MODELS[req.model],
      messages,
      max_tokens: req.maxTokens,
      reasoning: { effort: 'medium' },
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true },
    }
    if (req.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'lesson_eval_judgment', strict: true, schema: req.schema } }
    await this.credits.assertAvailable(req.reservationUSD ?? 0)
    const controller = new AbortController()
    let pollError: Error | undefined
    let checking = false
    const poll = setInterval(async () => {
      if (checking || pollError) return
      checking = true
      try { await this.credits.assertAvailable(0, true) }
      catch (error) { pollError = error instanceof Error ? error : new Error('Credit check failed'); controller.abort() }
      finally { checking = false }
    }, 5000)
    try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (response.status === 403) throw new CreditLimitError('OpenRouter rejected the request (HTTP 403); check the effective key budget', false)
    if (!response.ok || !response.body) throw new Error(`OpenRouter request failed (HTTP ${response.status})`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let finishReason: string | null = null
    let reportedUsage: Record<string, unknown> | undefined
    const consume = (frame: string) => {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string | { text?: string }[] }; finish_reason?: string | null }[]
          usage?: Record<string, unknown>
          error?: unknown
        }
        if (chunk.error) throw new Error('OpenRouter stream returned an error')
        const choice = chunk.choices?.[0]
        const delta = choice?.delta?.content
        if (typeof delta === 'string') text += delta
        else if (Array.isArray(delta)) text += delta.map((part) => part.text ?? '').join('')
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (chunk.usage) reportedUsage = chunk.usage
      }
    }
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) consume(frame)
      if (done) { if (buffer.trim()) consume(buffer); break }
    }
    if (!reportedUsage) throw new Error('OpenRouter response omitted usage accounting')
    await this.credits.assertAvailable(0, true)
    const details = (reportedUsage.completion_tokens_details ?? {}) as Record<string, number>
    const promptDetails = (reportedUsage.prompt_tokens_details ?? {}) as Record<string, number>
    const costUSD = Number(reportedUsage.cost)
    if (!Number.isFinite(costUSD) || costUSD < 0) throw new Error('OpenRouter response omitted a valid usage cost')
    const promptTokens = Number(reportedUsage.prompt_tokens ?? 0)
    const cacheRead = Number(promptDetails.cached_tokens ?? 0)
    const cacheWrite = Number(promptDetails.cache_write_tokens ?? 0)
    const usage: Usage = {
      input: Math.max(0, promptTokens - cacheRead - cacheWrite),
      output: Number(reportedUsage.completion_tokens ?? 0),
      cacheWrite,
      cacheRead,
      thinking: details.reasoning_tokens,
      costUSD,
    }
    return {
      text,
      stopReason: finishReason === 'length' ? 'max_tokens' : finishReason === 'content_filter' ? 'refusal' : finishReason === 'stop' ? 'end_turn' : finishReason,
      usage,
      ms: Date.now() - started,
      raw: text,
    }
    } catch (error) {
      if (pollError) throw pollError
      throw error
    } finally {
      clearInterval(poll)
    }
  }

  // OpenRouter's chat endpoint has no equivalent count-only call; visible tokens are estimated locally.
}

export type { Anthropic }
