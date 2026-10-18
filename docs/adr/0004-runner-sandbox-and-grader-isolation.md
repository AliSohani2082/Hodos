# ADR-0004: Runner sandbox and isolated hidden-test grader

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-18 |
| **Spike** | M0 (d), [`spikes/m0-runner-sandbox/`](../../spikes/m0-runner-sandbox/README.md) |
| **Issue** | [ALI-40](https://linear.app/ali-inc/issue/ALI-40) (subtasks ALI-60, ALI-61, ALI-62) |
| **Amends** | None. Confirms PRD **EX-5**, **EX-5b**, **DP-3** and the §9.4 `learner-code` profile as written; nuances for ALI-42 are in [Consequences](#consequences). |

## Question

Can the runner execute a learner's code in a sandbox while the hidden tests run in a **separate process and uid**, so that the learner's code can't read the tests or the reference, and can't forge a pass? And is the runner's own control plane safe (no host engine socket, no caller-chosen mounts/network/limits)? (PRD EX-5, EX-5b, DP-3, §9.4, §14 M0(d); threat model TM-007, TM-013.)

## Context

The oracle-graded code exercise is the v1 showcase. The mastery gate is only honest if a student can neither read the hidden checkpoint tests / reference solution nor tamper with the grader (TM-007, **high**). The same runner hosts every other sandbox profile, so its control plane must also hold (TM-013, medium). EX-5b already prescribes the design (reference never in the learner sandbox; hidden tests in a separate process and uid; results through a channel learner code can't write — parent-collected exit status plus a per-run nonce; prefer I/O tests compared outside; randomized inputs; flag leaks and pass-after-zero-runs). This spike builds a throwaway prototype of that design and tries to break it.

Machine: a personal workstation, kernel `7.2.8-1-cachyos`, 8 CPUs / ~15 GB RAM, cgroup v2 with `cpuset cpu io memory pids` delegated to the user, `kernel.yama.ptrace_scope=1`. No Docker, no system-installed gVisor. gVisor `runsc` was downloaded unprivileged into `.tools/` for the comparison (see Evidence).

## Options considered

| Option | For | Against |
|---|---|---|
| **A: rootless podman + crun, grader as a 2nd uid in the same container** | No daemon, no engine socket (TM-013 by construction); works unprivileged today; one container per grade so cheap; uid + non-dumpable + fd-topology isolate the grader | Learner and grader share a PID/mount/IPC namespace, so defense rests on the uid boundary + kernel `/proc` hardening, not a namespace wall; tmpfs inode cap not settable in podman 6.1.2 |
| **B: gVisor (runsc) as the runtime** | Syscall interception shrinks the host kernel attack surface; strong defense-in-depth | Rootless `runsc` under podman needs `--ignore-cgroups`, so the cgroup PID/mem/CPU caps don't apply as-is; heavier; extra moving part; not needed to meet the isolation bar |
| **C: grader in its OWN container (separate PID/mount/IPC ns), one socket between them** | Strongest isolation; `/proc/<grader>` not even visible to the learner | More orchestration and latency; not required for M0; belongs in production (ALI-184) |

## Verdict

**Go with changes.** We will build the runner on **rootless podman + crun** as the M0 baseline, with the **tier-1 (I/O, compared outside) path preferred** and a **tier-2 (call/RPC) grader running as a separate uid in the same container** where interactive grading is needed. The fd-topology result channel + per-run nonce + fail-closed parsing hold against every adversarial submission tried. **gVisor is an optional hardening layer** (verified to run and to preserve the isolation here, but not a drop-in for the cgroup caps under rootless). The "changes" are the production follow-ups in [Consequences](#consequences)/[Follow-ups](#follow-ups), chiefly: for tier-2, move the grader into its **own container** (Option C) so the learner and grader share no namespace at all.

## Evidence

**Versions / setup (exact):** rootless `podman 6.1.2`, `crun 1.30.1`, cgroup v2 (systemd manager), kernel `7.2.8-1-cachyos`, host `Python 3.14.7`, sandbox image `python:3.13-slim` (`Python 3.13.16`, base index digest `sha256:70729b46…5678c2f`, built image id `12c8f2ba…b98aa`), `runsc release-20261005.0`, `yama.ptrace_scope=1`. Reproduce from [`spikes/m0-runner-sandbox/README.md`](../../spikes/m0-runner-sandbox/README.md): `scripts/build-image.sh` then the drivers below. Raw tables are under `spikes/m0-runner-sandbox/results/`.

**Design, as built.** The runner is the parent; it shells out to the daemonless `podman` CLI (no engine socket anywhere, TM-013). Inside the container, PID 1 (`sandbox_init.py`, container-root = an unprivileged host uid via the rootless userns, caps `SETUID/SETGID/SETPCAP/KILL` only) spawns the **grader (uid 10001)** first — the hidden tests arrive on its **stdin** and its verdict leaves on a **pipe whose only other end is PID 1** — then the **learner (uid 10002)** over an inherited socketpair with a **JSON-only RPC**. The container's stdout is held only by PID 1 (`dup`'d, `close_fds` on every child); the runner accepts a frame only if the container exited 0, stdout is exactly one `ALI40-RESULT` line, the outer nonce matches (constant-time, single-use), the grader exited 0 and echoed the nonce, `done` is true, and the result's test names equal the expected list with real-bool `ok`. Tier-1 ("io") sends only *inputs* into the learner container and runs the **reference in a separate container** to produce expected output, compared outside.

**ALI-60 — limits (`tests/limits_suite.py`, 20/20, `results/limits.{md,json}`).** learner uid 10002, `CapEff=CapBnd=0`, `NoNewPrivs=1`, `Seccomp=2`; only `/work` writable (16 MiB tmpfs; `/`, `/opt`, `/etc`, `/dev/shm` EROFS); env is only `{PATH, LANG}`; no engine socket / host bind mount visible. Network: interfaces `['lo']`, 0 routes, TCP/UDP/DNS/raw/abstract-unix to host canaries and public IPs all fail, 0 canary hits, raw socket EPERM. PID cap 64 (fork loop EAGAIN at ~62, `pids.events max≥1`). Memory 256 MiB no-swap (allocator OOM-killed, `oom_kill≥1`, supervisor survives and still reports). Disk ENOSPC after ~15 MiB, per-file EFBIG at 8 MiB. Output flood cut by the supervisor (≤32 KiB/stream kept). Wall-time cap kills a busy loop and `sleep` at ~2.0 s. API: missing/wrong secret → 401; `mounts/volumes/network/image/privileged/limits/env/cap_add/docker_socket` → 400 `unknown_fields`; `agent-job` → 400 `profile_not_enabled`; 70 KB body → 413; logged argv has `--network none` and no socket/volume/privileged flags.

**ALI-61 — grader isolation (`tests/grader_suite.py`, 13/13, `results/grader.{md,json}`).** Grader uid 10001 ≠ learner 10002; from the learner, `/proc/<grader>/{environ,mem,maps,fd}` are all **EACCES** and no canary/answer-key is found anywhere in `/proc` or the sandbox fs; the baked image contains no hidden-test source. Honest grading (correct submit 7/7, wrong fails). Early `os._exit(0)`, a 30 s hang, and a learner-printed fake `ALI40-RESULT` frame all **cannot forge a pass**. Fail-closed parsing: wrong nonce → `nonce_mismatch`, replay → `nonce_replayed`, non-bool `ok` → `result_not_bool`. Tier-1 learner job carries **only** stdin (no expected, no reference), and the log shows **containers=2** per tier-1 submit (learner + reference), 1 per tier-2.

**ALI-62 — adversarial suite (`attacks/catalog.py`, 28 attacks + 2 white-box; `tests/attack_suite.py`; `results/attacks-*.{md,json}`).** Every secure case is contained — **32/32** (each sort-list attack ends with a deliberately wrong `my_sort`, so a `passed` verdict would mean a forged pass):

| Category | Attacks | Result (secure) |
|---|---|---|
| Read tests/nonce | `/proc/{environ,mem,maps,fd,cmdline}`, filesystem walk, ptrace, `process_vm_readv`, env + `/proc/1/environ`, inherited fds 0–255, IPC/`/dev/shm`/`/proc/net/unix` | all EACCES/blocked; `leaked=False`; canary never found |
| Kill / signal | SIGKILL/STOP/TERM the grader; signal pid 1 | EPERM; grader unaffected; `killed=False` / `sent=False` |
| Forge result | fake `ALI40-RESULT` on stdout (×50), write `/proc/1/fd/1` + `/dev/stdout` + grader fds, early exit, RPC socket junk/oversize/never-reply, NaN / lying `__eq__`, monkeypatch, nonce theft, colocated-style forged frame | never a pass; `wrote=False`; `nonce_found=False` |
| DoS | fork bomb, thread bomb, disk fill, mem bomb, CPU spin, output flood, import hang | contained by the caps; supervisor still returns a frame; verdict failed/error; nothing left behind |
| Network | TCP/UDP/DNS/raw to canaries + public IPs | `net_ok=False`; 0 canary hits |
| Escape | host engine sockets / `/proc/1/root`, `setuid(0)`, `chroot`, `mknod` + use, cgroup / `/proc/sys` / `core_pattern` / `sysrq` / `/proc/self/mem` writes | `sockets_exist=False`, `escaped=False`, `wrote=False` |
| White-box | 100 000 guessed-nonce frames; replay a valid frame 1000× | 0 accepted; replay 0 accepted |

**Controls (`results/attacks-colocated.{md,json}`, `attacks-same-uid.{md,json}`) — the same attacks when the isolation is removed:** `colocated` (tests in a file, nonce in the learner's env, verdict on shared stdout) **leaks the canary, leaks the nonce, and a crafted submission forges a full `passed` verdict** (reads the nonce + hidden test names, prints a valid frame, exits before the honest grader runs). `same-uid` (grader shares the learner's uid): the learner **can signal/kill the grader** (grading DoS). These are exactly what the secure design prevents.

**Teacher signals (`tests/flags_suite.py`, 7/7, `results/flags.{md,json}`).** `output_contains_test_source` fires (unit + end-to-end) when the learner's captured output contains the hidden canary or a ≥24-char hidden-source line, with a clean true-negative; `pass_after_zero_passing_runs` fires on a passing submit with no prior passing run and not otherwise; `resource_limit_hit`/`output_flood` fire on a flood. All are teacher-only (never in the student view).

**Performance (`tests/measure.py`, `results/perf.json`), under concurrent load from another spike:** secure tier-2 `call` run p50 **969 ms** / p95 1592 ms (n=20); tier-1 submit (2 containers) p50 **1224 ms** / p95 1802 ms; 3 concurrent submits completed in ~2.6 s (global cap is 3). The 20/20 limits run end-to-end latency was p50 ~690–790 ms earlier; CPU accounting (`L-CPU-1`) and the memory probe are sensitive to host load and occasionally need a retry when another spike saturates the machine.

**gVisor comparison (`tests/gvisor_compare.py`, 5/5, `results/gvisor.{md,json}`).** `runsc` was downloaded from the official release bucket and its **published SHA512 verified** (`gvisor.tar.zstd: OK`) before use. It runs rootless on this kernel. Running the **same supervisor + grader/learner design under `runsc`** (via `podman --cgroup-manager=cgroupfs --runtime … --runtime-flag ignore-cgroups`): honest grading holds (correct passes, wrong fails), the hidden tests stay **EACCES** from the learner with no forged pass, no network is reachable (0 canary hits), and no host socket is reachable. **Caveat:** rootless `runsc` under podman required `--ignore-cgroups`, so the cgroup-based PID/memory/CPU caps are **not** applied in that configuration — gVisor would need its own resource controls (or a cgroup-delegation fix) before it could replace crun for limit enforcement.

**What was NOT tested.** gVisor's *limit enforcement* (only its isolation was re-checked, with cgroups ignored); the grader in its own container (Option C); running the runner itself inside a container / podman-in-podman / rootless nesting; hosts without cgroup delegation; hosts with `yama.ptrace_scope=0` (where same-uid memory reads could differ — see below) or with SELinux/AppArmor; other kernels (this is a custom cachyos 7.2.8); non-Python languages; Windows/macOS; CPU/timing side channels (e.g. reading `/proc/<grader>/stat`); multi-tenant concurrency beyond 3; host-level memory pressure (the whole container can be OOM-killed, which still fails closed — no forged pass — but was not characterised); the other §9.4 profiles; podman's unavailable tmpfs `nr_inodes`.

## Consequences

- **EX-5b, DP-3 and the §9.4 `learner-code` profile are validated as written** — no PRD amendment is required for M0. The prototype meets every "Done when" for ALI-40.
- **Honest framing of the load-bearing controls (for ALI-42 and ALI-184):** confidentiality of the hidden tests rests on (1) the **fd-topology result channel** + fail-closed parsing, (2) the **separate uid**, and (3) the kernel's **non-dumpable flag + Yama `ptrace_scope=1`**, which together made `/proc/<grader>/{mem,environ}` unreadable **even in the `same-uid` control** on this host. The **per-run nonce is defense-in-depth**: it only becomes load-bearing if the channel ever degrades to a shared stream (e.g. reading container logs). On a host with `ptrace_scope=0`, the uid separation becomes the primary memory barrier — so it must stay.
- **Known gaps to carry forward:** podman 6.1.2 can't set a tmpfs `nr_inodes`, so inode exhaustion is bounded only by the 256 MiB memory cap; `mknod` of a char device *succeeds* on this kernel's tmpfs but the node is inert (`/work` is `nodev,noexec,nosuid`), so it is not an escape. Both should be revisited in production.
- Easier: the runner needs no daemon, no privilege, and no engine socket, and the tier-1 path is simple and fast. Harder: interactive (tier-2) grading in one container shares namespaces, so it needs the extra `/proc` hardening or a second container to reach "namespace-wall" strength.

## Follow-ups

What **ALI-184 "36.2 Production grader isolation"** should inherit:

- [ ] Keep **tier 1** (compare expected outside, reference in a separate sandbox) as the **default** grading path.
- [ ] For **tier 2**, move the grader into its **own container** (separate PID/mount/IPC namespaces) reachable only through a single socket, so `/proc/<grader>` isn't shared at all (Option C).
- [ ] Inherit the **fd-topology result channel + per-run single-use nonce + fail-closed parsing**, and never pass tests via file/argv/env; randomize inputs per attempt.
- [ ] Keep seccomp default, cap-drop-all + minimal adds, `no-new-privileges`, `--network none`, read-only rootfs, image **allowlist by id**, and job-spec logging with **alerts on rejected specs**.
- [ ] Decide the tmpfs **inode** cap (podman can't set `nr_inodes`; consider a runtime that can, or a per-job overlay quota) and keep the PID/disk/output caps.
- [ ] Ship the teacher flags (`output_contains_test_source`, `pass_after_zero_passing_runs`, plus integrity/resource flags) and per-student queues/quotas.
- [ ] Evaluate **gVisor** as a hardening layer once its resource controls (or cgroup delegation) are sorted; run the runner **rootless** in production, never on the host engine socket.
- [ ] Characterise behaviour under host memory pressure and on hosts with `ptrace_scope=0` / LSMs before relying on the same-container tier-2 path.
