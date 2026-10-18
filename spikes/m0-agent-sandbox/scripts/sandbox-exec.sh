#!/usr/bin/env bash
# Single source of truth for the agent-job profile: exec a command inside the sandbox.
#   sandbox-exec.sh <job-id> <abs-checkout> [-e K=V ...] -- <cmd> [args...]
# stdin/stdout are passed through, so ACP (ndjson over stdio) crosses the container boundary.
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
job=$1; checkout=$2; shift 2
envs=()
while [[ $# -gt 0 && $1 != -- ]]; do envs+=("$1"); shift; done
shift  # --
for e in "${envs[@]}"; do
  [[ "$e" == ALI39_CONFIG_TEST=1 ]] && export ALI39_CONFIG_TEST=1
done
sandbox_args "$job" "$checkout"
exec podman "${SANDBOX_ARGS[@]}" "${envs[@]}" "$IMG_AGENT" "$@"
