/**
 * A deterministic stand-in for an Anthropic-Messages-compatible model
 * endpoint (`POST /v1/messages`, streaming SSE), which is what DeepSeek
 * Harness's DeepSeek provider speaks. A script decides each reply from the
 * request, so end-to-end tests drive real DSH sessions without network access,
 * API keys or paid services. Every request is recorded for assertions.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isJsonValue, type JsonObject, type JsonValue } from '@hodos/plugin-sdk'

/** A tool result found in the request's last message. */
export interface MockToolResult {
  readonly name: string
  readonly text: string
  readonly isError: boolean
}

/** What the script sees of one model request. */
export interface MockRequest {
  readonly index: number
  /** Request path without the query, e.g. `/v1/messages`. */
  readonly path: string
  /** Which credentials the client sent: the `x-api-key` value, and whether a bearer token came. */
  readonly auth: { readonly apiKey: string | null; readonly bearer: boolean }
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
export function summarizeRequest(raw: JsonObject, index: number, meta: { path?: string; auth?: MockRequest['auth'] } = {}): MockRequest {
  const messages = Array.isArray(raw.messages) ? raw.messages.map(obj) : []
  const toolNames = new Map<string, string>()
  for (const m of messages) {
    for (const b of blocks(m.content)) if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') toolNames.set(b.id, b.name)
  }
  // DeepSeek Harness may append a trailing `system` message, so the turn's input is the last user message.
  const last = messages.findLast(m => m.role === 'user')
  const lastBlocks = last === undefined ? [] : blocks(last.content)
  const toolResults = lastBlocks.filter(b => b.type === 'tool_result').map(b => ({
    name: typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) ?? 'unknown' : 'unknown',
    text: textOf(b.content),
    isError: b.is_error === true,
  }))
  const userTexts = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).filter(t => t !== '')
  const lastText = last === undefined ? '' : textOf(last.content)
  const system = typeof raw.system === 'string' ? raw.system : blocks(raw.system).map(b => (typeof b.text === 'string' ? b.text : '')).join('\n')
  return {
    index,
    path: meta.path ?? '/v1/messages',
    auth: meta.auth ?? { apiKey: null, bearer: false },
    system,
    tools: Array.isArray(raw.tools) ? raw.tools.map(t => obj(t).name).filter((n): n is string => typeof n === 'string') : [],
    lastUserText: lastText === '' ? null : lastText,
    userTexts,
    toolResults,
    raw,
  }
}

function sse(res: ServerResponse, payload: JsonObject): void {
  res.write(`event: ${typeof payload.type === 'string' ? payload.type : 'message'}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function message(reply: MockReply, index: number): JsonObject {
  const content: JsonObject[] = []
  if ('text' in reply && reply.text !== undefined && reply.text !== '') content.push({ type: 'text', text: reply.text })
  if ('tool' in reply) content.push({ type: 'tool_use', id: `call_${index}`, name: reply.tool, input: reply.input })
  return {
    id: `msg_${index}`, type: 'message', role: 'assistant', model: 'hodos-mock', content,
    stop_reason: 'tool' in reply ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 5 },
  }
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
      const path = new URL(req.url ?? '/', 'http://mock').pathname
      if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
        return
      }
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        res.writeHead(404).end()
        return
      }
      const apiKey = req.headers['x-api-key']
      const auth = { apiKey: typeof apiKey === 'string' ? apiKey : null, bearer: typeof req.headers.authorization === 'string' }
      let raw: JsonObject
      try {
        const parsed: unknown = JSON.parse(await body(req))
        raw = isObject(parsed) ? parsed : {}
      } catch {
        // A malformed request is the harness's bug; answer like the real API would.
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"invalid_request_error","message":"invalid JSON"}}')
        return
      }
      const request = summarizeRequest(raw, requests.length + 1, { path, auth })
      requests.push(request)
      let reply: MockReply
      try {
        reply = script(request)
      } catch (error) {
        reply = { text: `mock script failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (raw.stream === false) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(reply, request.index)))
      else stream(res, reply, request.index)
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

/** A scripted step of teaching: prose, then one tool call. */
export interface ScriptedStep {
  readonly text: string
  readonly tool: string
  readonly input: JsonObject
}

/** What the scripted tutor asks and writes in a learning or practice session. */
export interface LearningScriptOptions {
  /** The first probe question (`hodos_probe` input). */
  readonly probe: JsonObject
  /** The probe's conclusion (`hodos_probe_done` assessment). */
  readonly assessment: JsonObject
  /** The plan map (mermaid). */
  readonly plan: string
  /** Teaching steps: the first follows the learner's go-ahead, each next one follows an answer. */
  readonly steps: readonly ScriptedStep[]
  /** The practice problem (`hodos_problem` input). */
  readonly problem?: JsonObject
  /** The conclusion of a practice problem (`hodos_conclude` input). */
  readonly conclusion?: JsonObject
}

/** A tool call parsed from "Call the tool <name> with <JSON object>". */
function namedCall(said: string): MockReply | null {
  const probe = /^call the tool ([\w-]+) with (\{.*\})$/i.exec(said)
  if (probe?.[1] === undefined || probe[2] === undefined) return null
  const input: unknown = JSON.parse(probe[2])
  return isJsonValue(input) && typeof input === 'object' && input !== null && !Array.isArray(input) ? { tool: probe[1], input } : null
}

/**
 * Findings for an extraction request: one proposition per teacher passage
 * (`[T<n>]` labels), each later one derived from the one before.
 */
function extractionReply(prompt: string): string {
  const passages = [...prompt.matchAll(/\[T(\d+)\]\n([^\n]+)/gu)].map(m => ({ n: m[1] ?? '', text: (m[2] ?? '').trim() }))
  const propositions = passages.map((p, i) => ({
    id: `p${i + 1}`,
    name: p.text.split(/\s+/u).slice(0, 4).join(' ').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 60) || `Idea ${i + 1}`,
    statement: (p.text.split(/(?<=\.)\s/u)[0] ?? p.text).slice(0, 300),
    passage: `T${p.n}`,
  }))
  const chains = propositions.slice(1).map((p, i) => ({ premises: [`p${i + 1}`], conclusion: p.id }))
  return JSON.stringify({ propositions, chains })
}

/**
 * A scripted tutor for end-to-end tests of learning and practice sessions in
 * a real DeepSeek Harness. It reads the conversation the Harness sends:
 *
 * - "I want to learn …" → hodos_start_learning; then the probe question;
 * - the graded answer of the probe → hodos_probe_done, then hodos_plan;
 * - the learner's go-ahead, then each graded answer → the next teaching step;
 * - a practice session → hodos_problem; the learner's thinking → hodos_conclude;
 * - Hodos's background calls (extraction, identity) → valid JSON findings;
 * - "Call the tool <name> with <JSON object>" → exactly that call, offered or
 *   not, so tests can probe the tool policy.
 * @param options - the questions, plan and steps.
 * @returns the script.
 */
export function learningScript(options: LearningScriptOptions): MockScript {
  return (request): MockReply => {
    if (request.system.includes('You are the extraction stage')) return { text: extractionReply(request.lastUserText ?? '') }
    if (request.system.includes('You are the identity stage')) return { text: '{"links": []}' }
    // A follow-up from the Hodos panel can share the model message with the result of the
    // question tool that ended the previous turn, so the message's text is read first.
    const text = request.lastUserText ?? ''
    const line = (prefix: string): string | undefined => text.split('\n').find(l => l.startsWith(prefix))
    const answers = request.userTexts.filter(t => t.includes('[Hodos] Answer to question')).length
    if (line('[Hodos] Answer to question') !== undefined) {
      if (request.tools.includes('hodos_probe_done')) return { text: 'I know enough to plan.', tool: 'hodos_probe_done', input: { assessment: options.assessment } }
      const step = options.steps[answers - 1]
      return step === undefined ? { text: 'Well done: that completes the plan.' } : step
    }
    if (line('[Hodos] The learner started a learning session') !== undefined) return { tool: 'hodos_probe', input: options.probe }
    if ((line('[Hodos] The learner started a practice session') !== undefined || line('[Hodos] Next problem') !== undefined) && options.problem !== undefined) return { tool: 'hodos_problem', input: options.problem }
    if (line('Your thinking (problem') !== undefined && options.conclusion !== undefined) return { tool: 'hodos_conclude', input: options.conclusion }
    // DeepSeek Harness appends a runtime-context block to the learner's message; the request is the first line.
    // It is read before tool results: it can share a model message with the result of the call that ended the turn.
    const said = text.split('\n')[0] ?? ''
    const named = namedCall(said)
    if (named !== null) return named
    const result = request.toolResults[0]
    if (result !== undefined) {
      if (result.isError) return { text: `[${result.name} failed] ${result.text.slice(0, 400)}` }
      if (result.name === 'hodos_start_learning') return { text: 'Let us find out where you are. Your first question is in the Hodos panel.', tool: 'hodos_probe', input: options.probe }
      if (result.name === 'hodos_probe_done') return { text: 'Now the plan.', tool: 'hodos_plan', input: { mermaid: options.plan } }
      if (result.name === 'hodos_plan') return { text: 'Here is the plan in the Hodos panel. Say "looks good" when you are ready to start.' }
      if (result.name === 'hodos_start_practice' && options.problem !== undefined) return { tool: 'hodos_problem', input: options.problem }
      return { text: `[${result.name}] ${result.text.slice(0, 400)}` }
    }
    if (/\b(i want to learn|teach me)\b/i.test(said) && request.tools.includes('hodos_start_learning')) return { tool: 'hodos_start_learning', input: { goal: said.slice(0, 300) } }
    if (/\blooks good\b/i.test(said) && request.tools.includes('hodos_quiz')) {
      const step = options.steps[0]
      if (step !== undefined) return step
    }
    return { text: 'Keep going in the Hodos panel; ask me if you get stuck.' }
  }
}
