#!/usr/bin/env bash
# Hodos installer: checks and installs Node.js, pnpm and DeepSeek Harness (dsh),
# builds Hodos, installs the core @hodos/dsh plugin, then asks which
# complementary plugins you want.
#
#   ./install.sh                       interactive
#   ./install.sh --yes                 no questions; core plugin + chess
#   ./install.sh --plugins chess,math  choose complementary plugins, no questions
#   curl -fsSL https://raw.githubusercontent.com/AliSohani2082/Hodos/main/install.sh | bash
#
# Options: --profile NAME (default web), --dir PATH (checkout, default ./Hodos
# unless run inside one), --plugins LIST, --yes, --help
# Plugins: chess code math language claude-code codex acp
set -euo pipefail

REPO_URL="https://github.com/AliSohani2082/Hodos.git"
DSH_PACKAGE="@deepseek-ai/dsh@0.2.1-rc.5"
NODE_MIN_MAJOR=24
NODE_MIN_MINOR=9
PROFILE="web"
TARGET_DIR=""
PLUGINS=""
ASSUME_YES=0

# Banner rendered with the figlet npm package (font "ANSI Shadow").
banner() {
  printf '\033[35m'
  cat <<'ART'
██╗  ██╗ ██████╗ ██████╗  ██████╗ ███████╗
██║  ██║██╔═══██╗██╔══██╗██╔═══██╗██╔════╝
███████║██║   ██║██║  ██║██║   ██║███████╗
██╔══██║██║   ██║██║  ██║██║   ██║╚════██║
██║  ██║╚██████╔╝██████╔╝╚██████╔╝███████║
╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝
ART
  printf '\033[0m   ὁδός, the path. Learning plugins for DeepSeek Harness\n\n'
}

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift ;;
    --dir) TARGET_DIR="${2:?--dir needs a value}"; shift ;;
    --plugins) PLUGINS="${2:?--plugins needs a value}"; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

# Questions read from the terminal even when the script is piped from curl.
if [ -r /dev/tty ] && [ -w /dev/tty ]; then TTY=/dev/tty; else TTY=""; fi
ask() { # ask "question" default(y|n)
  local q="$1" def="${2:-n}" reply hint="[y/N]"
  [ "$def" = y ] && hint="[Y/n]"
  if [ "$ASSUME_YES" = 1 ] || [ -z "$TTY" ]; then [ "$def" = y ]; return; fi
  printf '%s %s ' "$q" "$hint" >"$TTY"
  read -r reply <"$TTY" || reply=""
  reply="${reply:-$def}"
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

node_ok() {
  have node || return 1
  local v major minor
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" -gt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; }
}

install_node() {
  say "Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR or later is required."
  ask "Install Node.js $NODE_MIN_MAJOR with nvm (no root needed)?" y || die "Install Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ and run this script again."
  have curl || die "curl is needed to install nvm."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MIN_MAJOR"
  nvm use "$NODE_MIN_MAJOR" >/dev/null
  node_ok || die "Node.js is still older than $NODE_MIN_MAJOR.$NODE_MIN_MINOR."
  warn "nvm was set up for this run. Open a new shell (or source $NVM_DIR/nvm.sh) to use Node afterwards."
}

install_pnpm() {
  say "Installing pnpm."
  if have corepack; then
    corepack enable 2>/dev/null && corepack prepare pnpm@latest --activate 2>/dev/null && have pnpm && return
  fi
  npm install -g pnpm
}

install_dsh() {
  say "Installing DeepSeek Harness ($DSH_PACKAGE)."
  npm install -g "$DSH_PACKAGE"
}

plugin_spec() { # name -> "kind|target"
  case "$1" in
    chess)       echo "local|packages/environments/chess" ;;
    code)        echo "local|packages/environments/code" ;;
    math)        echo "local|packages/environments/math" ;;
    language)    echo "local|packages/environments/language" ;;
    claude-code) echo "npm|@deepseek-ai/dsh-subagent-claude-code" ;;
    codex)       echo "npm|@deepseek-ai/dsh-subagent-codex" ;;
    acp)         echo "npm|@deepseek-ai/dsh-subagent-acp" ;;
    *) return 1 ;;
  esac
}

add_plugin() { # add_plugin name
  local spec kind target
  spec="$(plugin_spec "$1")" || { warn "Unknown plugin '$1', skipped."; return; }
  kind="${spec%%|*}"; target="${spec#*|}"
  [ "$kind" = local ] && target="$ROOT/$target"
  say "Adding plugin: $1"
  dsh plugin --profile "$PROFILE" add "$target" || warn "Could not add '$1'. You can retry: dsh plugin --profile $PROFILE add $target"
}

choose_plugins() {
  [ -n "$PLUGINS" ] && return
  if [ "$ASSUME_YES" = 1 ] || [ -z "$TTY" ]; then PLUGINS="chess"; return; fi
  say "Complementary plugins (the core plugin works without any of them)."
  local chosen=()
  ask "  chess        chess positions on an interactive board?" y && chosen+=(chess)
  ask "  code         predict-the-output and a Python sandbox in the browser?" n && chosen+=(code)
  ask "  math         algebra expressions, graded by evaluation?" n && chosen+=(math)
  ask "  language     Spanish typed answers?" n && chosen+=(language)
  ask "  claude-code  let DSH draft courses through your Claude Code sign-in?" n && chosen+=(claude-code)
  ask "  codex        let DSH draft courses through Codex?" n && chosen+=(codex)
  ask "  acp          connect other ACP agents (Gemini CLI, OpenCode, ...)?" n && chosen+=(acp)
  PLUGINS="$(IFS=,; echo "${chosen[*]:-}")"
}

main() {
  banner

  case "$(uname -s)" in
    Linux|Darwin) ;;
    *) die "This installer supports Linux and macOS. On Windows use WSL, or follow docs/install.md." ;;
  esac
  have git || die "git is required."

  node_ok || install_node
  say "Node.js $(node -v)"
  have pnpm || install_pnpm
  say "pnpm $(pnpm -v)"
  have dsh || install_dsh
  say "DeepSeek Harness: $(dsh --version 2>/dev/null || echo installed)"

  # Use the current checkout if run inside one, otherwise clone.
  if [ -z "$TARGET_DIR" ] && [ -f "$PWD/packages/dsh-adapter/package.json" ]; then
    ROOT="$PWD"
  else
    ROOT="$(cd "${TARGET_DIR:-.}" 2>/dev/null && pwd || true)"
    [ -n "$TARGET_DIR" ] || TARGET_DIR="Hodos"
    if [ ! -f "${ROOT:-/nonexistent}/packages/dsh-adapter/package.json" ]; then
      [ -d "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ] && [ ! -f "$TARGET_DIR/packages/dsh-adapter/package.json" ] && die "$TARGET_DIR exists and is not a Hodos checkout."
      [ -d "$TARGET_DIR/.git" ] || { say "Cloning Hodos into $TARGET_DIR."; git clone --depth 1 "$REPO_URL" "$TARGET_DIR"; }
      ROOT="$(cd "$TARGET_DIR" && pwd)"
    fi
  fi

  say "Building Hodos in $ROOT."
  ( cd "$ROOT" && pnpm install && pnpm build )

  say "Installing the core plugin (@hodos/dsh) into profile '$PROFILE'."
  dsh plugin --profile "$PROFILE" add "$ROOT/packages/dsh-adapter"

  choose_plugins
  if [ -n "$PLUGINS" ]; then
    IFS=',' read -r -a list <<<"$PLUGINS"
    for p in "${list[@]}"; do add_plugin "$p"; done
  fi

  cat <<DONE

$(printf '\033[1;32m')Hodos is installed.$(printf '\033[0m')

  Start it:   dsh web
  Then say what you want to learn, and open the "Hodos learning" tab in the right sidebar.

  Your learning records live in \${DSH_HOME:-~/.dsh}/hodos
  Guide: $ROOT/docs/install.md
DONE
}

main "$@"
