// ALI-54 / 04.1: minimal ACP client. Starts a session, sends a prompt, streams updates,
// answers permission requests by policy, supports cancel. Spawns the agent INSIDE the sandbox
// (scripts/sandbox-exec.sh) so the ACP stream crosses the container boundary (ALI-55).
//
//   node src/client/acp-client.ts --harness claude|codex --job JOB --checkout DIR --prompt "..."
//        [--policy policies/x.json] [--mcp-token T] [--model M] [--cancel-after-ms N] [--out DIR]
//        [--where sandbox|host --cmd "node /path/agent.js"]   (host = protocol exploration only)
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import { plan, type Harness } from "./harnesses.ts";
import { decide, loadPolicy, type Decision } from "./policy.ts";

const { values: a } = parseArgs({
  options: {
    harness: { type: "string" }, job: { type: "string" }, checkout: { type: "string" }, prompt: { type: "string" },
    "prompt-file": { type: "string" }, policy: { type: "string", default: "policies/readonly-plus-mcp.json" },
    "mcp-token": { type: "string" }, model: { type: "string" }, "cancel-after-ms": { type: "string" },
    out: { type: "string", default: "work/runs" }, where: { type: "string", default: "sandbox" }, cmd: { type: "string" },
    proxy: { type: "string", default: "http://ali39-proxy:8080" }, "max-turns": { type: "string" },
    "timeout-s": { type: "string", default: "300" }, "no-mcp": { type: "boolean", default: false },
    "allow-project-config": { type: "boolean", default: false },
  },
});
const harness = a.harness as Harness;
if (!harness || !a.job || !a.checkout || !(a.prompt || a["prompt-file"])) {
  console.error("usage: acp-client.ts --harness claude|codex --job J --checkout DIR --prompt TEXT|--prompt-file F");
  process.exit(2);
}
const prompt = a.prompt ?? readFileSync(a["prompt-file"]!, "utf8");
const checkout = resolve(a.checkout!);
const outDir = resolve(a.out!, `${a.job}-${harness}`);
mkdirSync(outDir, { recursive: true });
const transcript = (o: unknown) => appendFileSync(`${outDir}/transcript.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...(o as object) }) + "\n");
const policy = loadPolicy(a.policy!);
const decisions: Decision[] = [];

const net = { proxy: a.proxy!, mcpUrl: `${a.proxy}/mcp`, mcpToken: a["mcp-token"] ?? "" };
const p = plan(harness, net, { model: a.model, maxTurns: a["max-turns"] ? Number(a["max-turns"]) : undefined, allowProjectConfig: a["allow-project-config"] });

let child;
if (a.where === "host") {
  const [c, ...rest] = a.cmd!.split(" ");
  child = spawn(c, rest, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...p.env } });
} else {
  const envFlags = Object.entries({ ...p.env, ...(a["allow-project-config"] ? { ALI39_CONFIG_TEST: "1" } : {}) }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  child = spawn(resolve("scripts/sandbox-exec.sh"), [a.job!, checkout, ...envFlags, "--", p.command, ...p.args], { stdio: ["pipe", "pipe", "pipe"] });
}
child.stderr.on("data", (d: Buffer) => { appendFileSync(`${outDir}/agent-stderr.log`, d); });
const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

const toolCalls: { id: string; title: string; kind?: string; status?: string }[] = [];
let text = "";
const t0 = Date.now();
const watchdog = setTimeout(() => {
  console.error("client wall-clock timeout");
  // SIGKILL on the local `podman run` client does not stop the container, so remove it by name.
  if (a.where !== "host") spawn("podman", ["rm", "-f", "-t", "0", `ali39-job-${a.job}`], { stdio: "ignore" });
  child.kill("SIGKILL");
}, Number(a["timeout-s"]) * 1000);

let result: Record<string, unknown> = {};
try {
  result = await acp
    .client({ name: "hodos-spike-client" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const { response, decision } = decide(policy, ctx.params);
      decisions.push(decision);
      transcript({ permission: decision });
      return response;
    })
    .connectWith(stream, async (ctx) => {
      const init: any = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: p.clientCapabilities,
        clientInfo: { name: "hodos-spike-client", version: "0.0.1" },
      } as any);
      transcript({ initialize: { agentInfo: init.agentInfo, protocolVersion: init.protocolVersion, authMethods: (init.authMethods ?? []).map((m: any) => m.id), caps: init.agentCapabilities } });
      await p.setup?.(ctx, init);
      const mcpServers = a["no-mcp"] ? [] : [{ type: "http" as const, name: "hodos", url: net.mcpUrl, headers: [{ name: "Authorization", value: `Bearer ${net.mcpToken}` }] }];
      const session = await ctx.buildSession({ cwd: "/workspace", mcpServers, _meta: p.sessionMeta } as any).start();
      transcript({ session: session.sessionId });
      if (a["cancel-after-ms"]) setTimeout(() => ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }), Number(a["cancel-after-ms"]));
      transcript({ promptSent: true });
      const promptResponse = session.prompt(prompt);
      promptResponse.catch((e) => transcript({ promptError: String(e) }));
      for (;;) {
        const m = await session.nextUpdate();
        if (m.kind === "stop") return { stopReason: m.stopReason, usage: (m.response as any).usage ?? null, sessionId: session.sessionId };
        const u: any = m.update;
        transcript({ update: u });
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") { text += u.content.text; process.stdout.write(u.content.text); }
        if (u.sessionUpdate === "tool_call") { toolCalls.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status }); console.error(`\n[tool] ${u.title} (${u.kind ?? "?"})`); }
        if (u.sessionUpdate === "tool_call_update" && u.status) { const t = toolCalls.find((x) => x.id === u.toolCallId); if (t) t.status = u.status; }
      }
    });
} catch (e) {
  result = { error: String(e) };
  console.error("client error:", e);
} finally {
  clearTimeout(watchdog);
  child.kill("SIGTERM");
}
const summary = { harness, job: a.job, where: a.where, policy: policy.name, ms: Date.now() - t0, ...result, toolCalls, decisions, text, exit: await Promise.race([exited, new Promise((r) => setTimeout(() => r("still-running"), 3000))]) };
writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
console.error(`\n[done] ${JSON.stringify({ stopReason: (result as any).stopReason, error: (result as any).error, ms: summary.ms, tools: toolCalls.length, decisions: decisions.length })}  -> ${outDir}`);
process.exit((result as any).error ? 1 : 0);
