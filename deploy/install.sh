#!/usr/bin/env bash
# Install DeepSeek Harness and the Hodos bundles on this machine.
#
#   deploy/install.sh [all|build|plugins]
#
#   build    build Hodos from this checkout and install DeepSeek Harness
#   plugins  add the Hodos bundles to the Harness profile (safe to repeat)
#   all      both (the default)
#
# Settings, all optional:
#   DSH_VERSION    DeepSeek Harness version to install   (default 0.2.1-rc.3)
#   DSH_PREFIX     where DeepSeek Harness is installed   (default ~/.local/share/hodos/dsh)
#   DSH_HOME       the Harness home with its profiles    (default ~/.dsh)
#   DSH_PROFILE    the profile that gets the bundles     (default web)
#   HODOS_PLUGINS  interface plugins to add, space separated, from
#                  chess code math language, or "none"   (default all four)
#
# Nothing is published or sent anywhere. Packages come from the npm registry.
set -euo pipefail

die() { echo "install.sh: $*" >&2; exit 1; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dsh_version=${DSH_VERSION:-0.2.1-rc.3}
prefix=${DSH_PREFIX:-${XDG_DATA_HOME:-$HOME/.local/share}/hodos/dsh}
profile=${DSH_PROFILE:-web}
plugins=${HODOS_PLUGINS:-chess code math language}
step=${1:-all}

dsh_bin="$prefix/node_modules/.bin/dsh"

build() {
  command -v node >/dev/null || die "Node.js 24.9 or later is required"
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)' \
    || die "Node.js 24.9 or later is required (found $(node --version))"
  command -v pnpm >/dev/null || die "pnpm 11 is required (for example: corepack enable, or npm install -g pnpm@11.28.5)"
  command -v npm >/dev/null || die "npm is required to install DeepSeek Harness"

  echo "==> Building Hodos in $root"
  (cd "$root" && pnpm install --frozen-lockfile && pnpm build)

  local installed=""
  if [[ -f "$prefix/node_modules/@deepseek-ai/dsh/package.json" ]]; then
    installed=$(node -p "require('$prefix/node_modules/@deepseek-ai/dsh/package.json').version")
  fi
  if [[ "$installed" == "$dsh_version" && -x "$dsh_bin" ]]; then
    echo "==> DeepSeek Harness $dsh_version is already installed in $prefix"
  else
    echo "==> Installing DeepSeek Harness $dsh_version into $prefix"
    mkdir -p "$prefix"
    npm install --prefix "$prefix" --no-audit --no-fund "@deepseek-ai/dsh@$dsh_version"
  fi
}

add_plugins() {
  local dsh=${HODOS_DSH_BIN:-$dsh_bin}
  [[ -x "$dsh" ]] || die "DeepSeek Harness is not installed at $dsh (run: deploy/install.sh build)"
  [[ -f "$root/packages/core/lib/index.js" ]] || die "Hodos is not built (run: deploy/install.sh build)"

  local bundles=("$root/packages/dsh-adapter")
  if [[ "$plugins" != "none" ]]; then
    local name
    for name in $plugins; do
      case "$name" in
        chess|code|math|language) bundles+=("$root/packages/environments/$name") ;;
        *) die "unknown plugin '$name' (choose from: chess code math language, or none)" ;;
      esac
    done
  fi

  # The adapter goes first: the plugins register through the service it provides.
  local bundle
  for bundle in "${bundles[@]}"; do
    echo "==> Adding ${bundle#"$root"/} to the $profile profile"
    "$dsh" plugin --profile "$profile" add "$bundle" >/dev/null
  done
}

case "$step" in
  build) build ;;
  plugins) add_plugins ;;
  all) build; add_plugins ;;
  *) die "usage: deploy/install.sh [all|build|plugins]" ;;
esac
