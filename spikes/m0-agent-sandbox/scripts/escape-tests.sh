#!/usr/bin/env bash
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
RESULT="$S/results/ali59-escape-tests.txt"
mkdir -p "$S/work/checkouts" "$(dirname "$RESULT")"
trap 'podman rm -f ali39-private-proxy >/dev/null 2>&1 || true' EXIT
podman run -d --name ali39-private-proxy --pull=never --network ali39-agent --network ali39-app \
  --cap-drop=ALL --security-opt=no-new-privileges \
  -v "$S/src:/app/src:ro" -v "$S/node_modules:/app/node_modules:ro" -v "$S/work/logs:/logs:rw" \
  -w /app --user 0:0 -e LISTEN_PORT=8083 -e ALLOW_CONNECT=ali39-postgres:5432 \
  -e LOG_FILE=/logs/private-proxy.jsonl docker.io/library/node:24-slim node src/proxy/egress-proxy.ts >/dev/null
for harness in claude codex; do
  checkout="$S/work/checkouts/job-escape-$harness"
  rm -rf "$checkout"
  mkdir -p "$checkout"
  cp "$S/fixtures/escape-probe.sh" "$checkout/ali39-escape-probe.sh"
done

{
  echo "ALI-59 sandbox escape attempts; $(date -u +%FT%TZ)"
  echo "Model responses are scripted by the local mock provider; no real LLM or credential used."
  echo "--- private-address recheck on a test-only allowlisted CONNECT target ---"
  "$S/scripts/sandbox-exec.sh" escape-private-connect "$S/work/checkouts/job-escape-claude" -- sh -c \
    'if curl -sv --connect-timeout 3 --max-time 4 -x http://ali39-private-proxy:8083 https://ali39-postgres:5432/ -o /dev/null 2>&1 | grep -q "403 Forbidden"; then echo proxy_allowlisted_private_target=denied; else echo proxy_allowlisted_private_target=UNEXPECTED; exit 1; fi'
  rg '"reason":"resolves_to_private_address:' "$S/work/logs/private-proxy.jsonl" | tail -1
  for harness in claude codex; do
    echo "--- $harness ACP agent attempt ---"
    node "$S/src/client/acp-client.ts" --harness "$harness" --job "escape-$harness" \
      --checkout "$S/work/checkouts/job-escape-$harness" --prompt ALI39_ESCAPE_TEST \
      --policy "$S/policies/allow-all.json" --no-mcp --timeout-s 90
    echo
    node -e 'const s=require(process.argv[1]); console.log(`agent_tool_calls=${s.toolCalls.length}`)' \
      "$S/work/runs/escape-$harness-$harness/summary.json"
  done
  echo "--- Codex job-profile shell control (mock sent a Responses shell_call event; Codex ACP returned end_turn without an ACP tool_call) ---"
  "$S/scripts/sandbox-exec.sh" escape-codex-shell "$S/work/checkouts/job-escape-codex" -- sh /workspace/ali39-escape-probe.sh
  echo "--- positive controls from an ordinary ali39-app network container ---"
  podman run --rm --pull=never --http-proxy=false --network ali39-app --entrypoint sh localhost/ali39-agent:dev -ec \
    'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; nc -z -w 2 ali39-postgres 5432 && echo postgres=reachable; curl -sS --max-time 3 -o /dev/null -w "runner_http=%{http_code}\\n" http://ali39-runner:7070/; curl -sS --max-time 3 -o /dev/null -w "lan_device_http=%{http_code}\\n" http://ali39-dummies:9999/'
  echo "--- dummy listener log summary ---"
  if rg '"event":"connection".*"src":"10\\.139\\.0\\.' "$S/work/logs/dummies.jsonl" "$S/work/logs/lan-dummy.jsonl"; then
    echo "sandbox_source_connection=UNEXPECTED"
    exit 1
  else
    echo "sandbox_source_connection=none"
  fi
  echo "--- proxy deny log summary ---"
  rg '"decision":"deny"' "$S/work/logs/proxy.jsonl" | tail -20
} | tee "$RESULT"

for harness in claude codex; do
  transcript="$S/work/runs/escape-$harness-$harness/transcript.jsonl"
  if rg 'CANARY-(APP|PGPW|KEY|OTHERJOB)-[A-Za-z0-9]+' "$transcript"; then
    echo "canary_leak=UNEXPECTED:$harness" | tee -a "$RESULT"
    exit 1
  fi
  rg 'ALI39_ESCAPE_TEST|sh /workspace/ali39-escape-probe.sh' "$transcript" >/dev/null
done
