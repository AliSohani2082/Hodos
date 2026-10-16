// Stand-in LLM provider used to test key injection WITHOUT spending money.
// Records which credential header arrived so the test can assert the proxy replaced the sandbox's
// placeholder with the "real" key. Speaks just enough of both APIs to answer.
import { createServer } from "node:http";
import { makeLogger } from "../lib/log.ts";

const log = makeLogger("mock-llm", process.env.LOG_FILE);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const auth = String(req.headers["authorization"] ?? "");
  const key = String(req.headers["x-api-key"] ?? "");
  log("request", {
    method: req.method,
    url: req.url,
    "x-api-key": key ? key.slice(0, 4) + "…" + key.slice(-4) : null,
    authorization: auth ? auth.slice(0, 11) + "…" + auth.slice(-4) : null,
    injectedAnthropicKey: key === "mock-anthropic-provider-key",
    injectedOpenaiKey: auth === "Bearer mock-openai-provider-key",
    bytes: Buffer.concat(chunks).length,
  });
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  log("request_shape", { url: req.url, keys: Object.keys(body), toolNames: (body.tools ?? []).map((t: any) => t.name ?? t.function?.name), messageTypes: (body.messages ?? []).map((m: any) => m.role), plantedClaudeSeen: JSON.stringify(body).includes("ALI39_PLANTED_CLAUDE_CANARY"), plantedCodexSeen: JSON.stringify(body).includes("ALI39_PLANTED_CODEX_CANARY"), stream: body.stream });
  const stamp = { seenXApiKey: key, seenAuthorization: auth, url: req.url };
  if (new URL(req.url ?? "/", "http://mock.local").pathname === "/v1/messages") {
    const hasToolResult = (body.messages ?? []).some((m: any) => JSON.stringify(m).includes("tool_result"));
    const shellCall = JSON.stringify(body).includes("ALI39_RUN_SHELL") && !hasToolResult;
    const mcpCall = JSON.stringify(body).includes("ALI39_CALL_MCP") && !hasToolResult;
    const msg = { id: "msg_ali39_mock", type: "message", role: "assistant", model: body.model ?? "claude-sonnet-4-5", content: [{ type: "text", text: "ALI39_MOCK_OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      event("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (shellCall || mcpCall) {
        const name = mcpCall ? "mcp__hodos__lesson_validate" : "Bash";
        const input = mcpCall ? { draftId: "d1", path: "lessons/01.md", markdown: "---\ntitle: Test\n---\nBody" } : { command: "touch /workspace/ali39-permission-marker" };
        event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ali39", name, input: {} } });
        event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        event("content_block_stop", { type: "content_block_stop", index: 0 });
        event("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } });
        event("message_stop", { type: "message_stop" });
        return res.end();
      }
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ALI39_MOCK_OK" } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
      event("message_stop", { type: "message_stop" });
      return res.end();
    }
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
  }
  if (new URL(req.url ?? "/", "http://mock.local").pathname === "/v1/responses") {
    const response = { id: "resp_ali39_mock", object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model ?? "gpt-5.2-codex", output: [{ id: "msg_ali39", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ALI39_MOCK_OK", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      event("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } });
      event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "msg_ali39", type: "message", role: "assistant", status: "in_progress", content: [] } });
      event("response.content_part.added", { type: "response.content_part.added", item_id: "msg_ali39", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_ali39", output_index: 0, content_index: 0, delta: "ALI39_MOCK_OK" });
      event("response.output_text.done", { type: "response.output_text.done", item_id: "msg_ali39", output_index: 0, content_index: 0, text: "ALI39_MOCK_OK" });
      event("response.content_part.done", { type: "response.content_part.done", item_id: "msg_ali39", output_index: 0, content_index: 0, part: { type: "output_text", text: "ALI39_MOCK_OK", annotations: [] } });
      event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: response.output[0] });
      event("response.completed", { type: "response.completed", response });
      return res.end();
    }
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
  }
  return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stamp));
}).listen(Number(process.env.PORT ?? 9000), "0.0.0.0", () => log("listening", { port: process.env.PORT ?? 9000 }));
