#!/bin/sh
# Remove everything this spike created: ali40-* containers, stray runner/test processes, run state.
# Usage: scripts/cleanup.sh [--image]   (--image also removes the built image and the pulled base)
here=$(cd "$(dirname "$0")/.." && pwd)
podman ps -a --filter label=ali40=1 -q | xargs -r podman rm -f >/dev/null 2>&1
podman ps -a --format '{{.Names}}' | grep '^ali40-' | xargs -r podman rm -f >/dev/null 2>&1
pkill -f "$here/runner/server.py" 2>/dev/null
rm -rf "$here/runs" "$here/results/raw"
if [ "${1:-}" = "--image" ]; then
  podman rmi -f localhost/ali40-learner-py:1 >/dev/null 2>&1
  podman rmi -f docker.io/library/python:3.13-slim >/dev/null 2>&1
fi
echo "ali40 cleanup done; remaining ali40 containers: $(podman ps -a --format '{{.Names}}' | grep -c '^ali40-')"
