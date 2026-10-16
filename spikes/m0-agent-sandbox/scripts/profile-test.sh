#!/usr/bin/env bash
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$S/work/checkouts/job-profile"
"$S/scripts/sandbox-exec.sh" profile "$S/work/checkouts/job-profile" -- sh -ec '
  id
  grep -E "CapEff|NoNewPrivs" /proc/self/status
  printf "cpu.max="; cat /sys/fs/cgroup/cpu.max
  printf "memory.max="; cat /sys/fs/cgroup/memory.max
  printf "pids.max="; cat /sys/fs/cgroup/pids.max
  ip route
  env | sort
  test -w /workspace && echo checkout_writable=yes
  if touch /etc/ali39-profile-test 2>/dev/null; then echo rootfs_writable=yes; exit 1; else echo rootfs_writable=no; fi
  test ! -e /workspace/../job-OTHER/SECRET.md && echo other_checkout_visible=no
  test ! -e /workspace/../canary/app.env && echo app_secret_visible=no
  test ! -e /var/run/docker.sock && echo host_socket_visible=no
  getent hosts ali39-proxy
  if getent hosts example.com; then echo external_dns_visible=yes; exit 1; else echo external_dns_visible=no; fi
'
set +e
JOB_TIMEOUT_S=2 "$S/scripts/sandbox-exec.sh" profile-time "$S/work/checkouts/job-profile" -- sleep 10
code=$?
set -e
echo "time_limit_exit=$code"
test "$code" -ne 0
