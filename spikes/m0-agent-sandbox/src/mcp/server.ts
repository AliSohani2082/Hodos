// ALI-57 / 04.4: minimal MCP server with per-job tokens scoped to (job, draft, teacher).
//
//   /mcp      (port MCP_PORT)    Streamable HTTP MCP endpoint. Bearer token required.
//   /admin/*  (port ADMIN_PORT)  Stand-in for "the app": mints and ends job tokens.
//                                NOT exposed through the egress proxy.
//
// Rules from PRD AI-2 / TM-008:
//   * caller identity (job, draft, teacher) comes ONLY from the token;
//   * tools never accept a teacher/learner id, and reject draft/job ids outside the token's scope;
//   * the token dies when the job ends (or at its exp);
//   * every scope violation and auth failure is logged.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { makeLogger } from "../lib/log.ts";

const MCP_PORT = Number(process.env.MCP_PORT ?? 7000);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 7001);
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const log = makeLogger("mcp", process.env.LOG_FILE);

if (!ADMIN_SECRET) {
  console.error("ADMIN_SECRET is required");
  process.exit(2);
}

interface Claims {
  job: string;
  draft: string;
  teacher: string;
  exp: number; // epoch ms
  ended: boolean;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tokens = new Map<string, Claims>(); // sha256(token) -> claims

type Verdict =
  | { ok: true; claims: Claims }
  | { ok: false; reason: "missing" | "unknown" | "expired" | "job_ended" };

function verify(req: IncomingMessage): Verdict {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m) return { ok: false, reason: "missing" };
  const claims = tokens.get(sha(m[1]));
  if (!claims) return { ok: false, reason: "unknown" };
  if (claims.ended) return { ok: false, reason: "job_ended" };
  if (Date.now() >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

// ---- tools -----------------------------------------------------------------
// Input schemas are .strict(): an extra field such as `teacherId` is rejected, not ignored,
// so an injected agent that tries to pick its own identity gets an error and a log line.
const validateInput = z
  .object({
    draftId: z.string().describe("The course draft id this lesson belongs to."),
    path: z.string().describe("Path of the lesson inside the checkout, e.g. lessons/01.md"),
    markdown: z.string().describe("Lesson source to validate."),
  })
  .strict();
const reportInput = z
  .object({
    jobId: z.string().describe("The id of the current job."),
    status: z.enum(["running", "done", "failed"]),
    summary: z.string().max(2000),
  })
  .strict();

function buildServer(c: Claims): McpServer {
  const s = new McpServer({ name: "hodos-mcp-stub", version: "0.0.1" });
  const caller = { job: c.job, draft: c.draft, teacher: c.teacher }; // from the token only

  s.registerTool(
    "lesson.validate",
    {
      description: "Validate a lesson file (stub: checks that front matter has a title and the body is non-empty).",
      inputSchema: validateInput,
    },
    async (args) => {
      if (args.draftId !== c.draft) {
        log("scope_violation", { tool: "lesson.validate", job: c.job, tokenDraft: c.draft, askedDraft: args.draftId });
        return { isError: true, content: [{ type: "text", text: "forbidden: draftId is outside this job's scope" }] };
      }
      const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(args.markdown);
      const errors: string[] = [];
      if (!fm) errors.push("missing front matter");
      else {
        if (!/^title:\s*\S/m.test(fm[1])) errors.push("front matter has no title");
        if (!fm[2].trim()) errors.push("empty body");
      }
      log("tool_call", { tool: "lesson.validate", job: c.job, draft: c.draft, teacher: c.teacher, path: args.path, ok: errors.length === 0 });
      return { content: [{ type: "text", text: JSON.stringify({ ok: errors.length === 0, errors, caller }) }] };
    },
  );

  s.registerTool(
    "job.report",
    { description: "Report job status back to the platform (stub: appends to the audit log).", inputSchema: reportInput },
    async (args) => {
      if (args.jobId !== c.job) {
        log("scope_violation", { tool: "job.report", job: c.job, askedJob: args.jobId });
        return { isError: true, content: [{ type: "text", text: "forbidden: jobId is outside this token's scope" }] };
      }
      log("tool_call", { tool: "job.report", job: c.job, draft: c.draft, teacher: c.teacher, status: args.status, summary: args.summary.slice(0, 200) });
      return { content: [{ type: "text", text: JSON.stringify({ accepted: true, caller }) }] };
    },
  );
  return s;
}

// McpServer validates args with the strict schema but hides rejections inside the SDK; wrap
// to log "unexpected argument" attempts explicitly (TM-008 detection).
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
}

const mcp = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
  const v = verify(req);
  if (!v.ok) {
    log("auth_fail", { reason: v.reason, remote: req.socket.remoteAddress });
    res.writeHead(401, { "www-authenticate": 'Bearer realm="hodos-mcp"', "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "unauthorized", reason: v.reason }));
  }
  try {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    // flag tool calls that try to smuggle identity through arguments
    const calls = Array.isArray(body) ? body : body ? [body] : [];
    for (const m of calls as any[]) {
      if (m?.method === "tools/call") {
        const a = m.params?.arguments ?? {};
        const bad = Object.keys(a).filter((k) => /teacher|user|learner|student|owner|account/i.test(k));
        if (bad.length) log("identity_argument_rejected", { tool: m.params?.name, job: v.claims.job, keys: bad });
      }
    }
    const server = buildServer(v.claims);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log("error", { message: String(e) });
    if (!res.headersSent) json(res, 500, { error: "internal" });
  }
});

const admin = createServer(async (req, res) => {
  const given = Buffer.from(String(req.headers["x-admin-secret"] ?? ""));
  const want = Buffer.from(ADMIN_SECRET);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 403, { error: "forbidden" });
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && url.pathname === "/admin/jobs") {
    const b = (await readBody(req)) as { job: string; draft: string; teacher: string; ttlSec?: number };
    const token = "hjt_" + randomBytes(24).toString("base64url");
    const exp = Date.now() + (b.ttlSec ?? 900) * 1000;
    tokens.set(sha(token), { job: b.job, draft: b.draft, teacher: b.teacher, exp, ended: false });
    log("token_minted", { job: b.job, draft: b.draft, teacher: b.teacher, exp: new Date(exp).toISOString() });
    return json(res, 200, { token, exp });
  }
  const end = /^\/admin\/jobs\/([^/]+)\/end$/.exec(url.pathname);
  if (req.method === "POST" && end) {
    let n = 0;
    for (const c of tokens.values()) if (c.job === end[1]) ((c.ended = true), n++);
    log("job_ended", { job: end[1], tokensRevoked: n });
    return json(res, 200, { revoked: n });
  }
  json(res, 404, { error: "not found" });
});

mcp.listen(MCP_PORT, "0.0.0.0", () => log("listening", { port: MCP_PORT, role: "mcp" }));
admin.listen(ADMIN_PORT, "0.0.0.0", () => log("listening", { port: ADMIN_PORT, role: "admin" }));
