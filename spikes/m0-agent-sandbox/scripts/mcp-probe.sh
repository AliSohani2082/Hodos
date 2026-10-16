#!/usr/bin/env bash
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$S/work/checkouts/job-mcp-probe"
cp "$S/src/mcp/sandbox-probe.mjs" "$S/work/checkouts/job-mcp-probe/"
token="$(podman exec ali39-mcp node -e 'fetch("http://127.0.0.1:7001/admin/jobs",{method:"POST",headers:{"content-type":"application/json","x-admin-secret":process.env.ADMIN_SECRET},body:JSON.stringify({job:"mcp-probe",draft:"d1",teacher:"t1",ttlSec:300})}).then(r=>r.json()).then(x=>console.log(x.token))')"
trap 'podman exec ali39-mcp node -e '\''fetch("http://127.0.0.1:7001/admin/jobs/mcp-probe/end",{method:"POST",headers:{"x-admin-secret":process.env.ADMIN_SECRET}}).catch(()=>{})'\'' >/dev/null 2>&1 || true' EXIT
"$S/scripts/sandbox-exec.sh" mcp-probe "$S/work/checkouts/job-mcp-probe" -e JOB_TOKEN="$token" -- node sandbox-probe.mjs
