# Spike (d): runner sandbox for learner code

**Question.** Can the runner execute a learner's code in a sandbox while the hidden tests run in a separate process and uid, so that the learner's code can't read or tamper with them?

**Why it matters.** EX-5b: the reference solution never enters the learner's sandbox, hidden tests run in a separate process under a different uid, and results come back through a channel learner code can't write. TM-007 is the threat if this fails: students read hidden tests or tamper with the autograder, and mastery gates can be gamed. See [PRD](../../docs/PRD.md) EX-5b, §9.4 (the **learner-code** isolation zone) and the [threat model](../../docs/hodos-threat-model.md).

**Exit.** A written go/no-go on the runner isolation design, recording the sandbox profile that was tested (gVisor or rootless, resource limits, no network by default) against the §9.4 learner-code zone.

**Safety.** This spike runs deliberately hostile code. Use a disposable VM or container host.

**Status.** In progress. ALI-60 (runner prototype and limits) is done; ALI-61 (separate-uid grader, nonce channel) and ALI-62 (adversarial suite, verdict) follow.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).

---

## What is here

| Path | What |
|---|---|
| `image/Containerfile`, `image/sandbox_init.py` | The learner-code sandbox image. `sandbox_init.py` is PID 1 inside the container: it reads one JSON job on stdin, runs learner code as uid 10002 with no capabilities, captures and caps its output, and writes exactly one result frame to the container's stdout. |
| `runner/profiles.py` | The **fixed** `podman run` command line for the `learner-code` profile (network none, read-only rootfs, 16 MiB `/work` tmpfs, pids 64, 256 MiB RAM, 1 CPU, caps dropped, no-new-privileges, image by ID from an allowlist). Callers cannot change any of it. |
| `runner/engine.py` | Runs one job in one container. The runner is the parent: it feeds the job, reads stdout under a byte cap and a deadline, kills on overrun, and fails closed on anything unexpected. No container-engine socket anywhere: it forks the daemonless `podman` CLI as the unprivileged runner user. |
| `runner/service.py`, `runner/server.py` | Closed-schema policy, grading outside the sandbox, job-spec log (`runs/jobs.jsonl`), and the authenticated HTTP API (per-service secret, per-student and global quotas). |
| `runner/exercises/` | Fixtures: the exercises, their public practice tests. |
| `tests/limits_suite.py` | ALI-60 acceptance: 20 recorded checks, expected vs actual, through the real HTTP API. Output: `results/limits.md` / `.json`. |
| `tests/probes/` | The probe submissions the limits suite runs inside the sandbox. |
| `scripts/` | `build-image.sh` (builds the image, writes its ID as the allowlist), `cleanup.sh`. |

## How to run

Prerequisites (this machine): rootless **podman 6.1.2** with `crun`, cgroup v2 with `pids`/`memory`/`cpu` delegated to the user, `/etc/subuid` + `/etc/subgid` ranges, Python 3.12+ on the host (stdlib only, nothing to install). The base image `docker.io/library/python:3.13-slim` (pinned by index digest in the Containerfile) is pulled into the user's own podman store by `build-image.sh` if it is missing.

```sh
cd spikes/m0-runner-sandbox
scripts/build-image.sh                 # builds localhost/ali40-learner-py:1, writes image/IMAGE_ID (the allowlist)
python3 -I tests/limits_suite.py       # ALI-60: limits + API policy, ~35 s, writes results/limits.{md,json}

# run the API by hand:
export ALI40_RUNNER_SECRET=$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')
python3 runner/server.py --port 18740   # 127.0.0.1 only
curl -s -H "Authorization: Bearer $ALI40_RUNNER_SECRET" -d '{"profile":"learner-code","exercise_id":"sum-two","mode":"run","student_id":"s1","submission":"a,b=map(int,input().split());print(a+b)"}' http://127.0.0.1:18740/v1/jobs

scripts/cleanup.sh [--image]           # removes ali40-* containers, runner processes, runs/ (and the images with --image)
```

Environment variables (names only; nothing is committed):

| Variable | Used by | Meaning |
|---|---|---|
| `ALI40_RUNNER_SECRET` | `runner/server.py` | Per-service bearer secret (>= 24 chars). The test drivers generate a random one per run. |
| `ALI40_RUNNER_DEBUG` | `runner/server.py` | `1` makes the response include the raw supervisor frame. Operator-only; never selectable by a request. |
| `ALI40_ENABLE_PROBE_EXERCISE` | `runner/service.py` | `1` registers the single-case `probe-1` exercise used by the probes. Test-only. |

Ports used (other spikes share this machine): `18740` runner API, `18741`/`18742` dummy TCP canary listeners on the host, `18743` insecure-control runner. Everything we create is prefixed `ali40-`.

## Results

- **ALI-60, limits and API policy:** [`results/limits.md`](results/limits.md), 20/20 checks passed. Headline numbers (podman 6.1.2 / crun, cgroup v2, kernel 7.2.8):
  - learner uid 10002, `CapEff=CapPrm=CapBnd=0`, `NoNewPrivs=1`, seccomp filter on; only `/work` (16 MiB tmpfs) is writable;
  - network: interfaces `['lo']`, 0 routes, TCP/UDP/DNS/abstract-unix/raw-socket to host canary listeners and public IPs all fail, 0 listener hits;
  - PID cap: fork loop stopped by `EAGAIN` at 62 children (`pids.max=64`, kernel `pids.events max=1`);
  - memory: 256 MiB cap, allocator OOM-killed at 240 MiB reached, supervisor survived (`oom_kill=1`);
  - disk: ENOSPC after 15 MiB in `/work`; a single file past 8 MiB gets `EFBIG`; 60 000 empty files fit in 69 MiB of RAM (podman cannot set `nr_inodes`; the memory cap bounds inode exhaustion);
  - output: a stdout+stderr flood is cut after about 700 KB read in about 30 ms, 32 KiB kept per stream;
  - time: a busy loop is killed at 2.03 s with a 10 ms kill, a CPU cap of 1 holds 4 spinners to 1.85 CPU-s over 1.5 s wall;
  - API: no or wrong secret gives 401; `mounts`, `volumes`, `network`, `image`, `privileged`, `limits`, `env`, `cap_add`, `docker_socket` each give 400 `unknown_fields`; other profiles give 400 `profile_not_enabled`; every spec is logged;
  - latency: 3-case run end to end p50 690 ms, p95 844 ms (20 sequential runs, cold-ish image cache not included).
