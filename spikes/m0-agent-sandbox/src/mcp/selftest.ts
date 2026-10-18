// ALI-57 acceptance test, run against a live server (MCP_URL / ADMIN_URL / ADMIN_SECRET).
// Exits non-zero if any assertion fails. Output is the recorded evidence.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:7000/mcp";
const ADMIN_URL = process.env.ADMIN_URL ?? "http://127.0.0.1:7001";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failed++;
};

async function mint(job: string, draft: string, teacher: string, ttlSec = 60) {
  const r = await fetch(`${ADMIN_URL}/admin/jobs`, {
    method: "POST",
    headers: { "x-admin-secret": ADMIN_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ job, draft, teacher, ttlSec }),
  });
  return ((await r.json()) as { token: string }).token;
}
async function connect(token: string | null) {
  const c = new Client({ name: "ali39-selftest", version: "0" });
  const t = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  await c.connect(t);
  return c;
}
const text = (r: any) => r.content?.[0]?.text ?? "";

const tokA = await mint("job-A", "draft-A", "teacher-A");
const A = await connect(tokA);
const tools = (await A.listTools()).tools.map((t) => t.name).sort();
check("two stub tools are listed", JSON.stringify(tools) === JSON.stringify(["job.report", "lesson.validate"]), tools.join(","));

const good = await A.callTool({ name: "lesson.validate", arguments: { draftId: "draft-A", path: "lessons/01.md", markdown: "---\ntitle: Hi\n---\nbody" } });
const goodBody = JSON.parse(text(good));
check("lesson.validate in scope -> ok, caller identity echoed FROM TOKEN", goodBody.ok === true && goodBody.caller.teacher === "teacher-A" && goodBody.caller.draft === "draft-A", text(good));

const bad = await A.callTool({ name: "lesson.validate", arguments: { draftId: "draft-B", path: "x", markdown: "x" } });
check("lesson.validate with another draft's id is rejected", bad.isError === true, text(bad));

const rep = await A.callTool({ name: "job.report", arguments: { jobId: "job-A", status: "done", summary: "ok" } });
check("job.report in scope accepted", !rep.isError && JSON.parse(text(rep)).accepted === true, text(rep));
const rep2 = await A.callTool({ name: "job.report", arguments: { jobId: "job-B", status: "done", summary: "x" } });
check("job.report for another job's id is rejected", rep2.isError === true, text(rep2));

// identity smuggling: extra teacherId argument
let smuggled = "no error";
try {
  const r: any = await A.callTool({ name: "job.report", arguments: { jobId: "job-A", status: "done", summary: "x", teacherId: "teacher-B" } });
  smuggled = r.isError ? "isError: " + text(r) : "ACCEPTED";
} catch (e) {
  smuggled = "error: " + String(e).slice(0, 160);
}
check("a teacherId argument is rejected, not honoured", smuggled !== "ACCEPTED" && smuggled !== "no error", smuggled);

// no token / garbage token
for (const [label, tok] of [["no token", null], ["forged token", "hjt_forged"]] as const) {
  let rejected = false;
  try {
    const c = await connect(tok);
    await c.listTools();
  } catch {
    rejected = true;
  }
  check(`${label} -> 401`, rejected);
}

// expiry
const tokShort = await mint("job-S", "draft-S", "teacher-S", 1);
await new Promise((r) => setTimeout(r, 1500));
let expired = false;
try {
  await (await connect(tokShort)).listTools();
} catch {
  expired = true;
}
check("token past its ttl is rejected", expired);

// job end revokes
const tokE = await mint("job-E", "draft-E", "teacher-E");
const E = await connect(tokE);
await E.listTools();
await fetch(`${ADMIN_URL}/admin/jobs/job-E/end`, { method: "POST", headers: { "x-admin-secret": ADMIN_SECRET } });
let revoked = false;
try {
  await (await connect(tokE)).listTools();
} catch {
  revoked = true;
}
check("token is dead as soon as the job ends", revoked);

// admin API refuses without the secret
const noAdmin = await fetch(`${ADMIN_URL}/admin/jobs`, { method: "POST", body: "{}" });
check("admin API refuses requests without the admin secret", noAdmin.status === 403, String(noAdmin.status));

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
