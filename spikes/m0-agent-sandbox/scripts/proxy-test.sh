#!/usr/bin/env bash
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$S/work/checkouts/job-proxy-test"
out="$S/results/ali56-proxy-test.txt"
mkdir -p "$(dirname "$out")"
"$S/scripts/sandbox-exec.sh" proxy-test "$S/work/checkouts/job-proxy-test" -- sh -ec '
  status() { curl -sS --max-time 5 -o /tmp/ali39-body -w "%{http_code}" "$@"; }
  code=$(status http://ali39-proxy:8080/healthz); echo "healthz=$code"; test "$code" = 200
  code=$(status -H "content-type: application/json" -H "x-api-key: placeholder-sandbox-key" -d "{\"model\":\"mock\",\"messages\":[],\"stream\":false}" http://ali39-proxy:8080/anthropic/v1/messages); echo "anthropic_gateway=$code"; test "$code" = 200
  code=$(status -H "content-type: application/json" -H "authorization: Bearer placeholder-sandbox-key" -d "{\"model\":\"mock\",\"input\":[],\"stream\":false}" http://ali39-proxy:8080/openai/v1/responses); echo "openai_gateway=$code"; test "$code" = 200
  code=$(status http://ali39-proxy:8080/admin/jobs); echo "admin_route=$code"; test "$code" = 403
  code=$(status -X POST http://ali39-proxy:8080/anthropic/v2/messages); echo "anthropic_disallowed_path=$code"; test "$code" = 403
  code=$(status http://ali39-proxy:8080/rogue); echo "unknown_gateway_route=$code"; test "$code" = 403
  code=$(curl -sS --max-time 5 -o /tmp/ali39-body -w "%{http_code}" -x http://ali39-proxy:8080 http://example.com/); echo "absolute_http_forward=$code"; test "$code" = 403
  for host in example.com 127.0.0.1 169.254.169.254 ali39-postgres:5432; do
    curl -sv --max-time 5 -x http://ali39-proxy:8080 "https://$host/" -o /dev/null 2>&1 | grep -m1 "403 Forbidden" >/dev/null
    echo "connect_$host=denied"
  done
' | tee "$out"

grep '"decision":"deny"' "$S/work/logs/proxy.jsonl" | tail -12 > "$S/results/ali56-proxy-denials.jsonl"
grep '"injectedAnthropicKey":true\|"injectedOpenaiKey":true' "$S/work/logs/mock-llm.jsonl" | tail -2 > "$S/results/ali56-key-injection.jsonl"
test -s "$S/results/ali56-proxy-denials.jsonl"
rg '"injectedAnthropicKey":true' "$S/results/ali56-key-injection.jsonl" >/dev/null
rg '"injectedOpenaiKey":true' "$S/results/ali56-key-injection.jsonl" >/dev/null
