#!/usr/bin/env bash
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_LOG="$S/work/logs/proxy.jsonl"
MOCK_LOG="$S/work/logs/mock-llm.jsonl"
# mock-llm.jsonl is append-only across runs, so every canary assertion looks only at lines written by the run under test.
mock_new() { tail -n +$(($1 + 1)) "$MOCK_LOG"; }
assert_canary() { # <lines-before> <field> <true|false>: request_shape seen, and canary true iff expected
  local new; new=$(mock_new "$1")
  grep -q '"event":"request_shape"' <<<"$new" || { echo "no request_shape logged for this run"; exit 1; }
  if [ "$3" = false ]; then
    if grep -q "\"$2\":true" <<<"$new"; then echo "$2 canary leaked"; exit 1; fi
  else
    grep -q "\"$2\":true" <<<"$new" || { echo "$2 canary not visible in positive control"; exit 1; }
  fi
}
for name in job-config-claude-isolated job-config-claude-control job-config-codex-isolated job-config-codex-control; do
  rm -rf "$S/work/checkouts/$name"
  mkdir -p "$S/work/checkouts/$name"
  cp -a "$S/fixtures/config-plant/." "$S/work/checkouts/$name/"
done
result="$S/results/ali58-config-discovery.txt"
mkdir -p "$(dirname "$result")"
{
  echo "ALI-58 configuration discovery probe, $(date -u +%F)"
  echo "Claude isolated: settingSources=[], strictMcpConfig=true; explicit ACP mcpServers only."
  mock_before=$(wc -l < "$MOCK_LOG")
  node "$S/src/client/acp-client.ts" --harness claude --job config-claude-isolated --checkout "$S/work/checkouts/job-config-claude-isolated" --prompt ALI39_RUN_SHELL --no-mcp --policy "$S/policies/allow-all.json"
  test ! -e "$S/work/checkouts/job-config-claude-isolated/ali39-config-hook-marker"
  assert_canary "$mock_before" plantedClaudeSeen false
  echo "claude_isolated=CLAUDE.md canary absent; rogue MCP not connected; hook marker absent"

  echo "Claude positive control: project/local setting sources enabled and strict MCP disabled."
  mock_before=$(wc -l < "$MOCK_LOG")
  node "$S/src/client/acp-client.ts" --harness claude --job config-claude-control --checkout "$S/work/checkouts/job-config-claude-control" --prompt ALI39_RUN_SHELL --no-mcp --allow-project-config --policy "$S/policies/allow-all.json"
  test -e "$S/work/checkouts/job-config-claude-control/ali39-config-hook-marker"
  assert_canary "$mock_before" plantedClaudeSeen true
  echo "claude_control=CLAUDE.md canary visible; planted hook ran"

  echo "Codex isolated: fresh CODEX_HOME trust_level=untrusted, CODEX_CONFIG project_doc_max_bytes=0, empty read-only /workspace/.codex tmpfs."
  local_before=$(wc -l < "$PROXY_LOG")
  mock_before=$(wc -l < "$MOCK_LOG")
  node "$S/src/client/acp-client.ts" --harness codex --job config-codex-isolated --checkout "$S/work/checkouts/job-config-codex-isolated" --prompt 'Say ALI39_MOCK_OK and stop.' --no-mcp
  if tail -n +$((local_before + 1)) "$PROXY_LOG" | rg '"path":"/rogue"'; then echo "rogue route was contacted"; exit 1; fi
  assert_canary "$mock_before" plantedCodexSeen false
  echo "codex_isolated=AGENTS.md canary absent; planted .codex MCP route not contacted"

  echo "Codex positive control: project config test override enables trusted project discovery and removes the mask."
  local_before=$(wc -l < "$PROXY_LOG")
  mock_before=$(wc -l < "$MOCK_LOG")
  node "$S/src/client/acp-client.ts" --harness codex --job config-codex-control --checkout "$S/work/checkouts/job-config-codex-control" --prompt 'Say ALI39_MOCK_OK and stop.' --no-mcp --allow-project-config
  tail -n +$((local_before + 1)) "$PROXY_LOG" | rg '"path":"/rogue"' >/dev/null
  assert_canary "$mock_before" plantedCodexSeen true
  echo "codex_control=AGENTS.md canary visible; planted .codex MCP route attempted and denied"
} | tee "$result"
