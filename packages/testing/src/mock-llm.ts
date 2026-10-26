/**
 * A deterministic stand-in for an Anthropic-Messages-compatible model
 * endpoint (`POST /v1/messages`, streaming SSE), which is what DeepSeek
 * Harness's DeepSeek provider speaks. A script decides each reply from the
 * request, so end-to-end tests drive real DSH sessions without network access,
 * API keys or paid services. Every request is recorded for assertions.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { JsonObject, JsonValue } from '@hodos/plugin-sdk'

/** A tool result found in the request's last message. */
export interface MockToolResult {
  readonly name: string
  readonly text: string
  readonly isError: boolean
}

/** What the script sees of one model request. */
export interface MockRequest {
  readonly index: number
  readonly system: string
  /** Names of the tools offered to the model. */
  readonly tools: readonly string[]
  /** Text of the last user message (null when it carries only tool results). */
  readonly lastUserText: string | null
  /** Text of every user message, oldest first. */
  readonly userTexts: readonly string[]
  /** Tool results in the last message. */
  readonly toolResults: readonly MockToolResult[]
  readonly raw: JsonObject
}

/** One scripted reply: plain text, or a tool call (optionally preceded by text). */
export type MockReply = { readonly text: string } | { readonly tool: string; readonly input: JsonObject; readonly text?: string }

/** Decides the reply to a request. */
export type MockScript = (request: MockRequest) => MockReply

/** A running mock. */
export interface MockLlm {
  /** Base URL (use as `DEEPSEEK_BASE_URL`). */
  readonly url: string
  readonly requests: MockRequest[]
  close(): Promise<void>
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function obj(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function blocks(content: JsonValue | undefined): JsonObject[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.map(obj) : []
}

function textOf(content: JsonValue | undefined): string {
  return blocks(content).map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
}

/**
 * Summarize a raw Messages API request for a script.
 * @param raw - parsed request body.
 * @param index - request number.
 * @returns the summary.
 */
export function summarizeRequest(raw: JsonObject, index: number): MockRequest {
  const messages = Array.isArray(raw.messages) ? raw.messages.map(obj) : []
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    for (const b of blocks(m.content)) if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') toolNames.set(b.id, b.name)
  }
  const last = messages.at(-1)
  const lastBlocks = last === undefined ? [] : blocks(last.content)
  const toolResults = lastBlocks.filter(b => b.type === 'tool_result').map(b => ({
    name: typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) ?? 'unknown' : 'unknown',
    text: textOf(b.content),
    isError: b.is_error === true,
  }))
  const userTexts = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).filter(t => t !== '')
  const lastText = last?.role === 'user' ? textOf(last.content) : ''
  const system = typeof raw.system === 'string' ? raw.system : blocks(raw.system).map(b => (typeof b.text === 'string' ? b.text : '')).join('\n')
  return {
    index,
    system,
    tools: Array.isArray(raw.tools) ? raw.tools.map(t => obj(t).name).filter((n): n is string => typeof n === 'string') : [],
    lastUserText: lastText === '' ? null : lastText,
    userTexts,
    toolResults,
    raw,
  }
}

function sse(res: ServerResponse, payload: JsonObject): void {
  res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function stream(res: ServerResponse, reply: MockReply, index: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sse(res, { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'hodos-mock', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
  let block = 0
  const text = 'text' in reply ? reply.text : undefined
  if (text !== undefined && text !== '') {
    sse(res, { type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } })
    sse(res, { type: 'content_block_delta', index: block, delta: { type: 'text_delta', text } })
    sse(res, { type: 'content_block_stop', index: block })
    block += 1
  }
  if ('tool' in reply) {
    sse(res, { type: 'content_block_start', index: block, content_block: { type: 'tool_use', id: `call_${index}`, name: reply.tool, input: {} } })
    sse(res, { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } })
    sse(res, { type: 'content_block_stop', index: block })
  }
  sse(res, { type: 'message_delta', delta: { stop_reason: 'tool' in reply ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
  sse(res, { type: 'message_stop' })
  res.end()
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Start the mock on 127.0.0.1.
 * @param script - reply policy.
 * @param port - port (0 picks a free one).
 * @returns the running mock.
 */
export async function startMockLlm(script: MockScript, port = 0): Promise<MockLlm> {
  const requests: MockRequest[] = []
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/v1/messages')) {
        res.writeHead(404).end()
        return
      }
      let raw: JsonObject
      try {
        const parsed: unknown = JSON.parse(await body(req))
        raw = isObject(parsed) ? parsed : {}
      } catch (_invalid) {
        // A malformed request is the harness's bug; answer like the real API would.
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"invalid_request_error","message":"invalid JSON"}}')
        return
      }
      const request = summarizeRequest(raw, requests.length + 1)
      requests.push(request)
      let reply: MockReply
      try {
        reply = script(request)
      } catch (error) {
        reply = { text: `mock script failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      stream(res, reply, request.index)
    })()
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock LLM did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}

/**
 * The scripted tutor used by the Hodos end-to-end journeys. It starts a
 * journey when the learner states a learning goal, resumes one when asked,
 * reports tool results back as text, and otherwise answers briefly.
 * @param options - environment hint and self-report for the start call.
 * @returns the script.
 */
export function tutorScript(options: { environment: string; selfReport?: ReadonlyArray<{ skill: string; level: 'never' | 'heard-of' | 'used-it' }> }): MockScript {
  return request => {
    const result = request.toolResults[0]
    if (result !== undefined) return { text: `[${result.name}${result.isError ? ' failed' : ''}] ${result.text.slice(0, 400)}` }
    const said = request.lastUserText ?? ''
    if (/\b(teach me|i want to learn|learn)\b/i.test(said) && request.tools.includes('hodos_start_learning')) {
      return {
        text: 'Let me set up a learning path for you.',
        tool: 'hodos_start_learning',
        input: { goal: said.slice(0, 300), environment: options.environment, ...(options.selfReport === undefined ? {} : { self_report: [...options.selfReport] }) },
      }
    }
    if (/\b(continue|resume)\b/i.test(said) && request.tools.includes('hodos_resume_learning')) return { tool: 'hodos_resume_learning', input: {} }
    if (/\bstatus\b/i.test(said) && request.tools.includes('hodos_status')) return { tool: 'hodos_status', input: {} }
    if (/\bapprove\b/i.test(said) && request.tools.includes('hodos_approve_path')) return { tool: 'hodos_approve_path', input: {} }
    return { text: 'Keep going in the Hodos workspace; ask me if you get stuck.' }
  }
}
