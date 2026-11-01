#!/usr/bin/env bash
# Serve DeepSeek Harness's web UI, with Hodos, so another device (a phone) can open it.
#
#   deploy/serve.sh
#
# It prints one line, "dsh web: <url>", whose URL carries a one-time token. Open
# that URL on the phone once; the browser then keeps a signed cookie (30 days).
# Anyone who holds the URL or the cookie can use the Harness, shell included,
# as the user this runs as: treat it like an SSH key. See docs/self-hosting.md.
#
# Settings, all optional unless noted:
#   DEEPSEEK_API_KEY      the model key (set in the environment; never stored by Hodos)
#   HODOS_PORT            listen port                                   (default 8787)
#   HODOS_HOST            the one local IP address to listen on         (default: this
#                         machine's first non-loopback IPv4 address)
#   HODOS_LOCAL_ONLY=1    listen on 127.0.0.1 only (for an SSH tunnel or a local proxy); wins over HODOS_HOST
#   HODOS_PUBLIC_URL      the address the phone uses, e.g. https://box.example:8787/ ;
#                         its host is trusted automatically
#   HODOS_TRUSTED_HOSTS   more host names or IPs the phone may use, comma separated
#                         (host or host:port; no wildcards)
#   HODOS_TLS_CERT, HODOS_TLS_KEY
#                         serve HTTPS from this certificate chain and unencrypted key
#   HODOS_ALLOW_PLAIN_HTTP=1
#                         accept plain HTTP on a network address. Only for a private,
#                         encrypted network (a VPN) or when a proxy adds TLS in front
#   HODOS_WORKSPACE       the directory the agent works in               (default: the current one)
#   HODOS_DSH_BIN         the dsh launcher                               (default: the one install.sh installs)
#   DSH_HOME, DSH_PROFILE the Harness home and profile                   (defaults ~/.dsh, web)
#   HODOS_DRY_RUN=1       print the command instead of running it
set -euo pipefail

die() { echo "serve.sh: $*" >&2; exit 1; }

port=${HODOS_PORT:-8787}
profile=${DSH_PROFILE:-web}
public_url=${HODOS_PUBLIC_URL:-}
tls_cert=${HODOS_TLS_CERT:-}
tls_key=${HODOS_TLS_KEY:-}

[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || die "HODOS_PORT must be a port number from 1 to 65535"

# The first non-loopback IPv4 address of this machine.
default_address() {
  { hostname -I 2>/dev/null || true; hostname -i 2>/dev/null || true; } \
    | tr ' ' '\n' | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true; } | { grep -v '^127\.' || true; } | head -n1
}

if [[ "${HODOS_LOCAL_ONLY:-}" == "1" ]]; then
  host=127.0.0.1
elif [[ -n "${HODOS_HOST:-}" ]]; then
  host=$HODOS_HOST
else
  host=$(default_address)
  [[ -n "$host" ]] || die "found no network address to listen on; set HODOS_HOST to this machine's address, or HODOS_LOCAL_ONLY=1"
fi
case "$host" in
  0.0.0.0|::|'[::]') die "DeepSeek Harness does not listen on all addresses; set HODOS_HOST to one address of this machine" ;;
esac

# TLS: both files or neither.
if [[ -n "$tls_cert" || -n "$tls_key" ]]; then
  [[ -n "$tls_cert" && -n "$tls_key" ]] || die "set both HODOS_TLS_CERT and HODOS_TLS_KEY"
  [[ -r "$tls_cert" ]] || die "cannot read HODOS_TLS_CERT ($tls_cert)"
  [[ -r "$tls_key" ]] || die "cannot read HODOS_TLS_KEY ($tls_key)"
fi

# The public address, and the host names the browser may use.
trusted=()
authority_pattern='^[][A-Za-z0-9.:-]+$'
if [[ -n "$public_url" ]]; then
  [[ "$public_url" =~ ^https?://[^/@?#[:space:]]+(/[^[:space:]?#]*)?$ ]] \
    || die "HODOS_PUBLIC_URL must be an http:// or https:// address without credentials, query or fragment"
  authority=${public_url#*://}
  authority=${authority%%/*}
  trusted+=("$authority")
fi
if [[ -n "${HODOS_TRUSTED_HOSTS:-}" ]]; then
  IFS=',' read -r -a extra <<< "$HODOS_TRUSTED_HOSTS"
  for entry in "${extra[@]}"; do
    entry=${entry#"${entry%%[![:space:]]*}"}   # trim leading blanks
    entry=${entry%"${entry##*[![:space:]]}"}   # trim trailing blanks
    [[ -n "$entry" ]] || continue
    [[ "$entry" =~ $authority_pattern ]] || die "HODOS_TRUSTED_HOSTS entry '$entry' is not a host name or address (no wildcards, schemes or paths)"
    trusted+=("$entry")
  done
fi

# Plain HTTP carries the session cookie unencrypted. Allow it on loopback, behind
# an HTTPS public address (a proxy terminates TLS), or when the owner says the
# network is private and encrypted.
loopback=0
case "$host" in 127.*|::1|'[::1]') loopback=1 ;; esac
if [[ -z "$tls_cert" && "$loopback" == 0 && "$public_url" != https://* && "${HODOS_ALLOW_PLAIN_HTTP:-}" != "1" ]]; then
  die "refusing to serve plain HTTP on $host: the session cookie would travel unencrypted.
  Use one of:
    HODOS_TLS_CERT and HODOS_TLS_KEY      serve HTTPS from a certificate
    HODOS_PUBLIC_URL=https://...          a proxy in front adds TLS
    HODOS_LOCAL_ONLY=1                    listen on this machine only (reach it through an SSH tunnel)
    HODOS_ALLOW_PLAIN_HTTP=1              only if every device reaches this over a VPN or another encrypted private network"
fi

args=(--profile "$profile" --no-open --host "$host" --port "$port")
[[ -n "$public_url" ]] && args+=(--public-url "$public_url")
for entry in "${trusted[@]+"${trusted[@]}"}"; do args+=(--trusted-host "$entry"); done
[[ -n "$tls_cert" ]] && args+=(--tls-cert "$tls_cert" --tls-key "$tls_key")

dsh=${HODOS_DSH_BIN:-}
if [[ -z "$dsh" ]]; then
  prefix=${DSH_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/hodos/dsh}
  if [[ -x "$prefix/node_modules/.bin/dsh" ]]; then dsh="$prefix/node_modules/.bin/dsh"; else dsh=$(command -v dsh || true); fi
fi

if [[ "${HODOS_DRY_RUN:-}" == "1" ]]; then
  printf '%q' "${dsh:-dsh}"
  printf ' %q' "${args[@]}"
  printf '\n'
  exit 0
fi

[[ -n "$dsh" && -x "$dsh" ]] || die "DeepSeek Harness is not installed (run: deploy/install.sh)"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "serve.sh: DEEPSEEK_API_KEY is not set. Without it the chat has no model, unless you configured one in DeepSeek Harness's settings." >&2
fi

if [[ -n "${HODOS_WORKSPACE:-}" ]]; then
  mkdir -p "$HODOS_WORKSPACE"
  cd "$HODOS_WORKSPACE"
fi

exec "$dsh" "${args[@]}"
