#!/usr/bin/env bash
# Shared helpers for the ali39 spike. Everything this spike creates is prefixed "ali39-".
# Rootless podman only; the host container socket is never mounted anywhere.
set -euo pipefail

S="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$S/work"
LOGS="$WORK/logs"
P=ali39
NET_AGENT=${P}-agent        # --internal: no gateway, no NAT. The sandbox lives here, with the proxy.
NET_APP=${P}-app            # normal bridge with outbound NAT. Proxy, MCP, dummies live here.
SUBNET_AGENT=10.139.0.0/24
SUBNET_APP=10.139.1.0/24
IMG_AGENT=localhost/${P}-agent:dev
IMG_NODE=docker.io/library/node:24-slim
RUNTIME_ARGS=()             # set RUNTIME=/path/to/runsc to run the sandbox under gVisor instead of crun
[[ -n "${RUNTIME:-}" ]] && RUNTIME_ARGS=(--runtime "$RUNTIME")

# the host's LAN address, used as a LAN-reachability canary target
LAN_IP="${LAN_IP:-$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
LAN_DUMMY_PORT=${LAN_DUMMY_PORT:-19939}

# no ambient proxy settings leak into container builds/pulls
noproxy() { env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy "$@"; }

load_env() { # untracked .env: ANTHROPIC_API_KEY / OPENAI_API_KEY (held ONLY by the proxy container)
  if [[ -f "$S/.env" ]]; then set -a; . "$S/.env"; set +a; fi
}

mkdirs() { mkdir -p "$LOGS" "$WORK/checkouts" "$WORK/canary"; }

net_up() {
  podman network exists $NET_AGENT || podman network create --internal --subnet $SUBNET_AGENT $NET_AGENT >/dev/null
  podman network exists $NET_APP || podman network create --subnet $SUBNET_APP $NET_APP >/dev/null
}

# Run a node script from src/ in a throwaway app-side container. Source and deps are read-only.
app_run() { # app_run <name> <network args...> -- <env/other podman args...> -- <script> 
  local name=$1; shift
  podman run -d --name "${P}-${name}" --pull=never --cap-drop=ALL --security-opt=no-new-privileges \
    -v "$S/src:/app/src:ro" -v "$S/node_modules:/app/node_modules:ro" -v "$LOGS:/logs:rw" \
    -w /app --user 0:0 "$@"
}

canary_init() { # fresh random canary values every run; the escape tests grep the transcript for them
  local f="$WORK/canary/canary.env"
  if [[ ! -f "$f" ]]; then
    {
      echo "CANARY_APP_SECRET=CANARY-APP-$(head -c12 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
      echo "CANARY_DB_PASSWORD=CANARY-PGPW-$(head -c12 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
      echo "CANARY_SECRETS_KEY=CANARY-KEY-$(head -c12 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
      echo "CANARY_OTHER_CHECKOUT=CANARY-OTHERJOB-$(head -c12 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
      echo "ADMIN_SECRET=adm-$(head -c18 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
    } > "$f"
    chmod 600 "$f"
  fi
  set -a; . "$f"; set +a
  # canary files on the host: another job's checkout, and an "app .env"
  mkdir -p "$WORK/checkouts/job-OTHER"
  echo "other teacher's draft; $CANARY_OTHER_CHECKOUT" > "$WORK/checkouts/job-OTHER/SECRET.md"
  printf 'DATABASE_URL=postgres://hodos:%s@%s-postgres:5432/hodos\nSECRETS_KEY=%s\nAPP_SECRET=%s\n' \
    "$CANARY_DB_PASSWORD" "$P" "$CANARY_SECRETS_KEY" "$CANARY_APP_SECRET" > "$WORK/canary/app.env"
}

appside_up() {
  mkdirs; net_up; load_env; canary_init
  app_run mock-llm --network $NET_APP --network-alias ${P}-mock-llm \
    -e LOG_FILE=/logs/mock-llm.jsonl $IMG_NODE node src/canary/mock-llm.ts >/dev/null
  # app-side services: these (and only these) carry app secrets in their environment
  app_run mcp --network $NET_APP --network-alias ${P}-mcp \
    -e ADMIN_SECRET -e LOG_FILE=/logs/mcp.jsonl -e CANARY_APP_SECRET -e CANARY_SECRETS_KEY \
    $IMG_NODE node src/mcp/server.ts >/dev/null
  app_run dummies --network $NET_APP --network-alias ${P}-postgres --network-alias ${P}-runner \
    -e CANARY="$CANARY_APP_SECRET" -e LOG_FILE=/logs/dummies.jsonl \
    $IMG_NODE node src/canary/dummies.ts >/dev/null
  # the proxy straddles both networks; it is the only holder of the provider keys
  local up=()
  [[ -n "${UPSTREAM_PROXY:-}" ]] && up=(-e UPSTREAM_PROXY -e NODE_USE_ENV_PROXY=1 -e "HTTPS_PROXY=$UPSTREAM_PROXY" -e NO_PROXY=${P}-mcp)
  app_run proxy --network $NET_AGENT:alias=${P}-proxy --network $NET_APP \
    -e LOG_FILE=/logs/proxy.jsonl -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-mock-anthropic-provider-key}" -e OPENAI_API_KEY="${OPENAI_API_KEY:-mock-openai-provider-key}" \
    -e ANTHROPIC_UPSTREAM="${ANTHROPIC_UPSTREAM:-http://${P}-mock-llm:9000}" -e OPENAI_UPSTREAM="${OPENAI_UPSTREAM:-http://${P}-mock-llm:9000}" -e MCP_UPSTREAM=http://${P}-mcp:7000 \
    -e ALLOW_CONNECT="${ALLOW_CONNECT:-}" -e MAX_LLM_REQUESTS="${MAX_LLM_REQUESTS:-300}" -e CANARY_SECRETS_KEY \
    "${up[@]}" $IMG_NODE node src/proxy/egress-proxy.ts >/dev/null
}

# Host-side "LAN device": a canary listener on the host's LAN address (never 0.0.0.0, never 5432).
lan_dummy_up() {
  mkdirs
  ( cd "$S" && CANARY="${CANARY_APP_SECRET:-x}" LOG_FILE="$LOGS/lan-dummy.jsonl" LAN_BIND="$LAN_IP" LAN_PORT=$LAN_DUMMY_PORT \
      setsid node src/canary/lan-dummy.ts >/dev/null 2>&1 </dev/null & echo $! > "$WORK/lan-dummy.pid" )
}
lan_dummy_down() { [[ -f "$WORK/lan-dummy.pid" ]] && { kill "$(cat "$WORK/lan-dummy.pid")" 2>/dev/null || true; rm -f "$WORK/lan-dummy.pid"; }; }

# The agent-job profile (PRD §9.4). Callers pick a profile; they cannot change mounts/network/limits.
#   sandbox_args <job-id> <abs checkout dir>
sandbox_args() {
  local job=$1 checkout=$2
  SANDBOX_ARGS=(
    run --rm -i --name "${P}-job-${job}" --pull=never --env-host=false --http-proxy=false "${RUNTIME_ARGS[@]}"
    --network $NET_AGENT --hostname ${P}-sandbox
    --userns "keep-id:uid=10001,gid=10001" --user 10001:10001
    --cap-drop=ALL --security-opt=no-new-privileges
    --read-only
    --tmpfs /tmp:rw,nosuid,nodev,size=128m
    --tmpfs /home/agent:rw,nosuid,nodev,size=512m,mode=1777
    -v "$checkout:/workspace:rw"
    --tmpfs /workspace/.codex:ro,nosuid,nodev,notmpcopyup,size=16m,mode=0555
    --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --ulimit nofile=2048:2048
    --timeout "${JOB_TIMEOUT_S:-900}"
    -w /workspace
  )
}

teardown() {
  for c in $(podman ps -a --format '{{.Names}}' | grep "^${P}-" || true); do podman rm -f "$c" >/dev/null 2>&1 || true; done
  lan_dummy_down
  podman network exists $NET_AGENT && podman network rm -f $NET_AGENT >/dev/null 2>&1 || true
  podman network exists $NET_APP && podman network rm -f $NET_APP >/dev/null 2>&1 || true
}
