// Copy this file into a throwaway checkout, then run it inside the agent-job profile.
// It uses only Node's fetch; the bearer token is supplied by the host-side test driver.
import assert from "node:assert/strict";
const url = "http://ali39-proxy:8080/mcp";
const token = process.env.JOB_TOKEN;
assert(token, "JOB_TOKEN missing");
const admin = await fetch("http://ali39-proxy:8080/admin/jobs", { method: "POST" });
assert.equal(admin.status, 403);
console.log("admin_route=denied");
async function call(id, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await r.text();
  assert.equal(r.status, 200, `${method}: HTTP ${r.status} ${body}`);
  const data = body.startsWith("event:") ? body.match(/^data: (.+)$/m)?.[1] : body;
  assert(data, `${method}: no response data`);
  const parsed = JSON.parse(data);
  assert(!parsed.error, `${method}: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}
await call(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ali39-sandbox-probe", version: "1" } });
const listed = await call(2, "tools/list", {});
assert.deepEqual(listed.tools.map((t) => t.name).sort(), ["job.report", "lesson.validate"]);
console.log("listed=job.report,lesson.validate");
const lesson = await call(3, "tools/call", { name: "lesson.validate", arguments: { draftId: "d1", path: "lessons/01.md", markdown: "---\ntitle: Test\n---\nBody" } });
assert.equal(JSON.parse(lesson.content[0].text).caller.teacher, "t1");
console.log("lesson.validate=allowed scoped teacher=t1");
const report = await call(4, "tools/call", { name: "job.report", arguments: { jobId: "mcp-probe", status: "done", summary: "sandbox test" } });
assert.equal(JSON.parse(report.content[0].text).caller.job, "mcp-probe");
console.log("job.report=allowed scoped job=mcp-probe");
const denied = await call(5, "tools/call", { name: "lesson.validate", arguments: { draftId: "other", path: "lessons/01.md", markdown: "# X" } });
assert.equal(denied.isError, true);
console.log("out_of_scope_draft=rejected");
