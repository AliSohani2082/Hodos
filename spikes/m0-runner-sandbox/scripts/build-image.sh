#!/bin/sh
# Build the learner-code sandbox image with rootless podman and record its ID as the runner's
# image allowlist (DP-3: an allowlist of image digests; callers can never name an image).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
tag=localhost/ali40-learner-py:1
podman build --pull=never -t "$tag" -f "$here/image/Containerfile" "$here/image" >/dev/null 2>&1 \
  || { podman pull docker.io/library/python@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f \
       && podman build -t "$tag" -f "$here/image/Containerfile" "$here/image"; }
podman image inspect "$tag" --format '{{.Id}}' > "$here/image/IMAGE_ID"
echo "built $tag id=$(cat "$here/image/IMAGE_ID")"
