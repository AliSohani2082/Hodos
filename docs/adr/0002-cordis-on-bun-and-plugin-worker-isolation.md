# ADR-0002: cordis on Bun and non-first-party plugin workers

| | |
|---|---|
| **Status** | Proposed; M0 exit review (ALI-42) accepts or revises it |
| **Date** | 2026-10-16 |
| **Spike** | M0 (b), [cordis and plugin worker spike](../../spikes/m0-cordis-plugin-worker/README.md) |
| **Issue** | [ALI-38](https://linear.app/ali-inc/issue/ALI-38), with ALI-50, ALI-51, ALI-52 and ALI-53 |
| **Amends** | PRD [§8.1](../PRD.md#81-scopes-and-contributions), [§8.3](../PRD.md#83-sandbox-model), [§9.3](../PRD.md#93-stack), [§9.4](../PRD.md#94-isolation-zones), [§15](../PRD.md#15-risks), [Appendix A](../PRD.md#appendix-a-decision-log); threat model [TM-003](../hodos-threat-model.md). The M0 exit review folds these edits into the source documents. |

## Question

Does cordis provide scoped lifecycle, services and disposal on Bun, or must the plugin host use Node? Should non-first-party `apply`, `validate`, `validateItem`, non-code `grade`, `fallback.text` and `migrate` run in a JS isolate or a plain worker process to meet TM-003?

## Context

The app uses Bun. Plugin registration needs per-course scopes and clean unload, while untrusted server hooks must not reach the app's DB, secrets, network or process. The PRD already assigns first-party trust from the platform and keeps grading policy and mastery gates outside plugins. The [adapter sketch](../../spikes/m0-cordis-plugin-worker/ADAPTER.md) keeps cordis types internal: a platform-written cordis wrapper owns each sandboxed plugin's worker and registrations.

## Options considered

### Host runtime

| Option | Evidence and tradeoff |
|---|---|
| Bun with cordis behind `PluginHost` | 14/14 lifecycle checks match Node; one cosmetic stack-frame discrepancy; one optional CLI peer not exercised. Uses the chosen app runtime. cordis 4 is still a release candidate. |
| Node host fallback | Also passes 14/14, but adds a runtime boundary without fixing a demonstrated lifecycle failure. Retain as contingency if a later cordis or Bun bump regresses. |

### Untrusted hook execution

| Option | Isolation, limits and cost |
|---|---|
| Bare Bun/Node child or cgroup alone | JSON RPC is fast, but process APIs and host resources remain reachable. A cgroup bounds resources, not filesystem or network. **No-go.** |
| Node `--permission` | Blocks selected filesystem and env APIs, yet the tested network paths and `/proc/<ppid>/environ` remain accessible. **No-go as a boundary.** |
| Bun child in rootless container or bubblewrap plus cgroup | Denies tested host canaries, network and sockets. Kernel memory and pid caps work, but plugin code still has Bun builtins, subprocesses and sandbox-local writes. Viable fallback for an explicitly broader SDK. |
| QuickJS-wasm inside the app | No Node/Bun APIs, but synchronous plugin work blocks the app event loop and shares its process/address space. **No-go.** |
| **QuickJS-wasm in a Bun child inside an OS-confined worker** | No host APIs in the JS context; the OS layer supplies an independent failure and syscall boundary. Small wasm package, Bun compatible, sub-ms warm small calls; interpreter cost and restricted bundle contract. **Chosen.** |
| `isolated-vm` in a Node child/container | Passes tested API attacks, but native V8 addon fails to load on Bun, brings a second runtime/native ABI and a larger package. No-go for v1. |
| workerd child/container | Passes tested API attacks; fast for large JSON. Separate 133 MB binary, CA-bundle requirement, no self-contained per-call CPU/wall/memory enforcement. No-go for v1; revisit if Web APIs or JIT performance are required. |

## Verdict

**Cordis on Bun: Go with changes.** Keep Bun as the app and host runtime, pin `cordis@4.0.0-rc.11` with the lockfile, import cordis only inside the internal adapter, and rerun the lifecycle and adapter suites on every runtime or cordis bump. No Node fallback is needed for this tested version. Do not treat fiber states or exact stack text as a stable public SDK contract.

**Plugin-worker mechanism: Go with changes.** Run non-first-party hooks in a QuickJS-wasm context inside a separate, OS-confined Bun worker using the fixed `plugin-worker` profile: read-only package, no network, no secrets, no DB/runner sockets, kernel memory and pid caps, and host-enforced per-call CPU, wall and result-size limits. Kill the whole worker on a breach; restart on the next request and retry a pure hook at most once after a crash. Put deadline supervision outside the app's event loop and verify it under host load. Use JSON-in/JSON-out RPC and validate all returned shapes on the host. The platform assigns trust and retains estimator, gate and checkpoint-policy authority. A bare worker process, Node permissions alone and an in-app isolate are no-go boundaries for TM-003.

## Evidence

Reproduce from [`spikes/m0-cordis-plugin-worker`](../../spikes/m0-cordis-plugin-worker/README.md): `bun install`, then `bun run cordis:diff`, `bun run adapter:test`, `bun run adapter:noleak`, `bun run bench:latency`, `bun run compat:bun`, and `bun run hostile`. The README gives the complete commands and tables. Tested on Bun 1.4.2 (`744846f84`), Node 24.21.0, cordis 4.0.0-rc.11, QuickJS-emscripten 0.32.0, isolated-vm 7.0.1 and workerd 1.20261016.1, Linux x64 kernel 7.2.8. The same toy ES module and 16 hand-checked JSON cases ran in every mechanism. The hostile fixture used only random canaries and local dummy listeners; network results are counted by the host, not by the plugin's report.

- [Cordis results](../../spikes/m0-cordis-plugin-worker/results/cordis-bun.json): 14/14 on Bun and Node, including service injection, scoped registries, rollback, async disposal and 2,000 load/unload cycles. Heap growth after GC was 0.1–0.2 MB; load/unload was about 0.36–0.58 ms on Bun and 0.98–1.26 ms on Node. `cordis:diff` found identical behavior after excluding timing and stack text. The adapter suite passed 21/21 checks across cordis and plain Maps, including confined-worker disposal; a strict import/type check found no cordis leak in platform-facing files.
- [Latency results](../../spikes/m0-cordis-plugin-worker/results/latency.json): all 14 placements matched the reference on 16/16 cases. Warm small-call p50 was about 0.07–0.3 ms for bare process/QuickJS/isolated-vm, about 0.4–1 ms for workerd; 1 MB JSON p50 was 12–16 ms native, 22–40 ms QuickJS and 4–7 ms workerd. Bare cold starts were about 40–110 ms; rootless container starts were mostly 250–500 ms. This shared workstation shifted absolute results up to about 2× between runs.
- [Compatibility results](../../spikes/m0-cordis-plugin-worker/results/bun-compat.json): QuickJS loaded on Bun and adds about 1.45 MB in the minimal release-only package (503 KB wasm). `isolated-vm` failed on Bun with `ERR_DLOPEN_FAILED` for a V8 symbol; Node child succeeded and the package is about 20 MB. workerd is a separate 133 MB binary and needs a CA bundle even with egress denied.
- [Hostile results](../../spikes/m0-cordis-plugin-worker/results/hostile.json): bare Bun, bare Node and Bun+cgroup escaped 10/11 capability attempts; Node `--permission` escaped 6/11, including all four network paths, and the scrubbed child env could still reach the parent canary through `/proc`. Bubblewrap+namespace+cgroup and rootless Podman placements, QuickJS, isolated-vm and workerd escaped 0/11 in these API-level tests. The suite also tests CPU loops, microtask spins, ReDoS, wall hangs, allocations, stack overflow, 20 MB output and 48 subprocesses, then probes recovery. Host CPU budget was 1,000 ms/call, wall limit 1,500 ms/call, result cap 256 KB; QuickJS/isolated-vm engine memory caps were 48 MB and cgroup/container memory 256 MB with 32 pids for the process tiers. Bare Bun and bare workerd depended on a 600 MB emergency host RSS watchdog. In-process QuickJS stalled the host event loop for hundreds to thousands of milliseconds; native allocation/GC near the limit took 8.7 seconds in the final run despite the 1.5-second deadline. The out-of-process worker can be killed independently, but the app-loop watchdog also missed its target under severe host scheduling pressure: bare workerd reached about 4.0 seconds on a 1.5-second wall budget. A production supervisor must be independently schedulable and tested under load.
- [Compute and footprint results](../../spikes/m0-cordis-plugin-worker/results/compute.json): recursive `fib(27)` p50 was 3.5 ms in a Bun child versus 64.8 ms in QuickJS/Bun, an 18.5× interpreter penalty. [Footprint](../../spikes/m0-cordis-plugin-worker/results/footprint.json): QuickJS/Bun in Podman used 47.6 MB idle and 59.2 MB after 1,200 small calls; 20 additional QuickJS contexts in one process added 37.1 MB total, or 1.85 MB each. This is a point measurement, not a soak or throughput result.
- [Host result validation](../../spikes/m0-cordis-plugin-worker/results/hostile.json): out-of-range, NaN and oversized `GradeResult` variants were rejected. A shape-valid forged score of 1 was accepted as evidence, so mastery and gates must stay platform-owned; `revealsAnswer` is subject to platform checkpoint policy. The `__proto__` case did not pollute `Object.prototype`.

The container test used rootless Podman with `--network none --read-only --cap-drop all --security-opt no-new-privileges --memory 256m --pids-limit 32 --cpus 1`, only necessary read-only mounts, an empty guest env, and a host kill watchdog. The bubblewrap path unshared namespaces and added a systemd user cgroup. The [harness](../../spikes/m0-cordis-plugin-worker/src/hostile/run.ts) records the exact options, host CPU/RSS/cgroup counters and per-attack recovery. The 322-row matrix combines a full run with a focused rerun of three candidates that hit the original 10-second startup readiness timeout under another spike's load; the 60-second rerun changed no per-call limits and the JSON records this provenance. These are API-level probes, not a proof against runtime or kernel exploits.

**Not tested:** gVisor/runsc; real third-party bundles such as chess.js or Markdoc validators in QuickJS; more than 100,000 calls of soak/leak behavior; concurrency or throughput; heavy compute beyond recursive fib(27); Windows, macOS or Docker; side-channel or Spectre-class attacks; engine-level exploits; cordis plugin-loader or `bun --hot`; other Bun versions or cordis 3.x. The spike uses a bundled single-file toy module, not npm dependency resolution or install scripts. The toy contracts resemble the PRD's block and exercise APIs, but production schema validation, persistence, UI iframes, runner materializers and real Postgres are deliberately absent.

## Consequences

At the M0 exit review, amend PRD §8.1 to name QuickJS inside the OS-confined worker and explain that sandboxed `apply()` runs there against a recording facade; only registration data crosses into the app. In §8.3, specify a single-file, pure JSON hook bundle with no Node/Bun/Web globals, host-side result validation and platform-assigned trust. In §9.3, retain Bun and pin cordis behind the adapter. In §9.4, give `plugin-worker` fixed read-only mounts, no network/secrets/DB, kernel memory and pid limits, host CPU/wall/result limits and bounded restart/retry behavior. In §15, update cordis compatibility risk with the passing Bun suite and increase the weight of the worker isolation/SDK contract risk. Update the TM-003 mitigation and Appendix A decision row accordingly. The PRD and threat model remain untouched in this spike.

A confined worker costs startup and idle memory; an interpreter slows compute-heavy hooks and disallows Node/Web APIs. The boundary therefore forces plugin authors to package pure functions and puts capability-bearing work in separately reviewed platform services. The host adapter can swap cordis without changing the SDK. The OS profile still needs production verification; passing canary probes does not certify sandbox security.

## Follow-ups

- [ ] [ALI-77](https://linear.app/ali-inc/issue/ALI-77): put the fixed plugin-worker profile, bundle lint, integrity-pinned inert install and adapter packages in the M1 skeleton; choose one process per plugin versus one confined process with one QuickJS context per plugin using measured footprint and throughput.
- [ ] [ALI-181](https://linear.app/ali-inc/issue/ALI-181): implement production worker lifecycle, independently scheduled deadline supervision, host-side schema and size validation, exact retry semantics and telemetry; test actual third-party bundles, concurrent load and longer soak runs, then repeat capability/resource probes on the deployment image.
- [ ] ALI-42 M0 exit review: apply the named PRD/TM-003/Appendix A amendments and add a CI job that reruns cordis lifecycle and adapter conformance on every cordis or Bun upgrade.
