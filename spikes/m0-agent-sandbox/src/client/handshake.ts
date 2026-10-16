// ALI-54 first probe: spawn an ACP agent command, run initialize + session/new, print what comes back.
// No prompt is sent, so no LLM call is made. Usage: node src/client/handshake.ts <cwd> <cmd> [args...]
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [cwd, cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
const show = (label: string, v: unknown) => console.log(`== ${label}\n${JSON.stringify(v, null, 2)}`);

try {
  await acp.client({ name: "ali39-handshake" }).connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "ali39-handshake", version: "0" },
    } as any);
    show("initialize", init);
    try {
      const s = await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
      show("session/new", s);
    } catch (e) {
      show("session/new ERROR", e);
    }
  });
} catch (e) {
  show("connection ERROR", String(e));
} finally {
  child.kill();
  process.exit(0);
}
