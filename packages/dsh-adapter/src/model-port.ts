/**
 * The model Hodos uses for background work (knowledge-graph extraction): one
 * tool-free call on the user's default DSH model, through `ctx.llm`, the
 * way DSH's own session-title generator calls a model. The call has no
 * tools, a token cap and a deadline; Hodos counts each call against the
 * learner's daily budget before making it.
 * @module @hodos/dsh/model-port
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ModelPort } from '@hodos/core'

/** Longest a background call may run. */
export const MODEL_CALL_TIMEOUT_MS = 180_000

/** The part of `ctx.agentDefaultModel` Hodos reads (DSH's default-model service). */
export interface DefaultModelSource {
  currentSelection(): { readonly provider: string; readonly model: string }
}

/**
 * A model port over DSH's LLM runtime.
 * @param ctx - plugin context with `llm`.
 * @param defaults - the user's default model selection.
 * @returns the port.
 */
export function dshModelPort(ctx: Context, defaults: DefaultModelSource): ModelPort {
  return {
    async complete(request) {
      const { provider, model } = defaults.currentSelection()
      const signals = [AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS), ...(request.signal === undefined ? [] : [request.signal])]
      const signal = AbortSignal.any(signals)
      const call = await ctx.llm.prepareCall({ provider, model, maxTokens: request.maxOutputTokens }, signal)
      const assembler = new BlockAssembler()
      for await (const chunk of call.stream({ ...call.config, system: request.system, messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }], signal })) {
        signal.throwIfAborted()
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(`model call ${finish.kind}: ${finish.failure.message}`)
      const text = assembler.blocks().map(block => (block.type === 'text' ? block.text : '')).join('')
      const usage = assembler.usage
      return { text, ...(usage === undefined ? {} : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }
    },
  }
}
