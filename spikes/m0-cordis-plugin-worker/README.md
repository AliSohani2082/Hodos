# Spike (b): cordis on Bun, and the plugin worker

**Questions.**

1. Does cordis run cleanly on Bun? Its README says the API is unstable and it is built for Node (PRD §15). The fallback is Node for the plugin host.
2. Where should the server-side hooks of non-first-party plugins run (`apply()`, `validate`, `validateItem`, non-code `grade`, `fallback.text`, `migrate`)? Compare a JS isolate (workerd, isolated-vm or QuickJS-wasm) against a plain worker process, by running a plugin's `validate` and `grade` in each.

**Why it matters.** TM-003 requires that these hooks run with no database, no secrets and no network, over JSON-in/JSON-out RPC with CPU and time limits (see the "Plugin worker" paragraph in [PRD §8](../../docs/PRD.md) and the [threat model](../../docs/hodos-threat-model.md)). cordis stays behind a thin adapter either way.

**Exit.** A written go/no-go on cordis-on-Bun and on the plugin-worker design.

**Status.** ALI-50/51/52 evidence is committed; ALI-53 hostile, limit and recovery tests are complete.

**Verdict.** [ADR-0002](../../docs/adr/0002-cordis-on-bun-and-plugin-worker-isolation.md) proposes **Go with changes** for cordis on Bun and **Go with changes** for a QuickJS-wasm context inside an OS-confined Bun worker.

---

## Layout

| Path | What |
|---|---|
| `src/sdk/types.ts` | The public plugin contract sketch (`BlockSpec`, `ExerciseKindSpec`, `GradeResult`, `PluginContext`…). No cordis imports. |
| `src/host/plugin-host.ts` and friends | ALI-51: the internal `PluginHost` interface, two implementations (cordis, plain Maps) and a conformance suite. Notes in [`ADAPTER.md`](ADAPTER.md). |
| `src/cordis/` | ALI-50: typed registries as cordis `Service`s and the lifecycle check suite. |
| `src/worker/` | ALI-52: `glue.mjs` (the JSON-RPC surface and the `apply()` recorder, identical in every runtime), `engines.mjs` (native / QuickJS / isolated-vm engines), `child.mjs` (the worker child process). |
| `src/host/sandboxes.ts` | ALI-52/53: one `Sandbox` interface over plain process, cgroup, bubblewrap, rootless podman, in-process QuickJS and workerd. |
| `src/bench/latency.ts` | ALI-52: startup and per-call latency, plus a differential check against an in-process reference. |
| `src/bench/compute.ts`, `src/bench/footprint.ts` | ALI-53: interpreter compute cost and worker memory footprint. |
| `src/hostile/run.ts`, `fixtures/hostile-plugin/` | ALI-53: host-grounded capability, resource-limit, recovery and forged-result probes. |
| `fixtures/toy-plugin/` | The toy plugin: one block (`position`, FEN `validate` + `fallback.text`), one layout, one exercise kind (`toy-quiz`: `validateItem` + async `grade`), one preset. |
| `fixtures/cases.mjs` | 16 `validate` / `validateItem` / `grade` / `fallback.text` cases with hand-written expectations. |
| `scripts/` | Diff, compat and report-rendering scripts. |
| `results/` | Committed, curated JSON results. The ADR cites these. |

## Versions under test

| Thing | Version |
|---|---|
| Bun | 1.4.2 (`744846f84`), Linux x64 |
| Node | 24.21.0 |
| cordis | `4.0.0-rc.11` (npm `latest` for `cordis`; deps `cosmokit@1.8.1`, `@standard-schema/spec@1.1.0`) |
| Host | CachyOS, kernel 7.2.8, 8 cores |

Setup: `cd spikes/m0-cordis-plugin-worker && bun install`.

## ALI-50: cordis on Bun (lifecycle, services, disposal)

```sh
bun run cordis:bun      # bun run src/cordis/lifecycle.ts      -> results/cordis-bun.json
bun run cordis:node     # node --expose-gc src/cordis/lifecycle.ts -> results/cordis-node.json
bun run cordis:diff     # field-by-field comparison of the two result files
bun run cordis:decorators   # Bun-only: the TC39 @Inject class decorator
```

Each script exits non-zero if any check fails. The toy plugin registers a block, a layout, an exercise kind and a preset through three typed registry services (`ctx.lesson`, `ctx.exercise`, `ctx.pedagogy`) declared by module augmentation. A registry method registers through `this.ctx.effect(...)`: cordis rebinds a service's `this.ctx` to the *caller's* context, so the entry belongs to the calling plugin's fiber and disappears with it. Plugin code never calls `ctx.effect` itself.

**Result: 14/14 checks pass on Bun 1.4.2 and on Node 24.21, with identical behaviour** (`cordis:diff` ignores timings and stack text only).

| Check | What it proves |
|---|---|
| C00 | Negative control: a registration that bypasses `ctx.effect` leaks past `dispose()` and the harness sees it. The checks can fail. |
| C01 | Block, layout, exercise kind and preset all register from one plugin through typed registries; plugin reaches `ACTIVE`. |
| C02 | Unload leaves nothing behind: registries empty, event listeners back to baseline, timer stopped. |
| C03 | Duplicate registration fails only the second plugin (`FAILED`), its partial registrations roll back, the first plugin is untouched. |
| C04 | Service dependency: a plugin that `inject`s `lesson` stays inactive until the provider appears, is torn down when the provider is disposed, and re-activates against a new provider. |
| C05 | `update(config)` and `restart()` re-run `apply` with no duplicates and balanced disposers. |
| C06 | Async `apply` and async disposers; `dispose()` waits for them and runs them in reverse order. |
| C07 | `Config` as a Standard Schema object rejects bad config and fails only that plugin. |
| C08 | `ctx.isolate('lesson', Symbol())` gives two courses separate registries (PRD: enablement is per course). |
| C09 | A throwing `apply` ends `FAILED`, keeps its message and its own stack frame, no unhandled rejection. |
| C10 | `on/emit/bail/waterfall/serial/parallel`; listeners die with their plugin. |
| C11 | Plugin as function, object with `apply`, class, and ES module namespace. |
| C12 | 100 plugins loaded and disposed concurrently. |
| C13 | 2000 load/unload cycles: registry size flat, heap growth 0.1 to 0.2 MB after GC. |

Timings from the committed runs (single run each, not a benchmark; they vary about ±30% run to run): one toy-plugin load+unload cycle 0.58 ms on Bun vs 1.26 ms on Node; 100 plugins concurrent load 21 ms vs 24 ms.

### Bun incompatibilities found

| # | Finding | Impact | Workaround |
|---|---|---|---|
| 1 | cordis rewrites `error.stack` with the stack of the code that called `ctx.plugin()` ("outer stack"), slicing at fixed V8 offsets (`buildOuterStack`, `composeError`). On Bun the plugin's own frame survives, but the caller's frames are partly lost (one frame fewer than on Node) and frame labels differ (`at <anonymous>` instead of `at Fiber.execute`). | Diagnostics only. Messages, states and disposal are unaffected (C09). | None needed. Log the plugin name and package version alongside errors instead of relying on stack text. |
| 2 | The `cordis` CLI (`bin.js`) imports the optional peer `@cordisjs/plugin-loader`, which is not installed here. | None for us: we load plugins ourselves through the adapter, we do not use the YAML loader. | Not tested. If the loader is wanted later, test it on Bun first. |

No other incompatibility found. Also checked and fine: `WeakRef`, Proxy-based `ctx` property access, TC39 `@Inject` decorators (`cordis:decorators`), `Service` subclasses, symbol-keyed internals, function-name inference for fiber names (identical on both runtimes).

**Not tested:** Bun `--hot`/`--watch` reload of plugin modules; the `@cordisjs/plugin-loader`; other Bun versions; Windows/macOS; cordis 3.x (`@cordisjs/core@3.18.1`, `next` tag is `4.0.0-beta.5`).

## ALI-52: `validate` / `validateItem` / `grade` in an isolate vs a plain process

```sh
bun run bench:latency      # bun run src/bench/latency.ts  -> results/latency.json   (about 1 minute; add --only proc-bun,workerd to select)
bun run bench:render       # renders the table below from results/latency.json
bun run compat:bun         # can each option be loaded by Bun? what does it cost to ship? -> results/bun-compat.json
```

**What runs where.** The toy plugin ([`fixtures/toy-plugin/server.mjs`](fixtures/toy-plugin/server.mjs)) is one self-contained ES module. The *same bytes* are run by every mechanism behind [`src/worker/glue.mjs`](src/worker/glue.mjs), which implements the whole RPC as `handle(requestJson) -> responseJson`:

```
{"id":1,"op":"load","config":{}}                                   -> {"id":1,"ok":true,"result":<manifest: blocks, layouts, exerciseKinds, presets, each with hooks:[...]>}
{"id":2,"op":"call","hook":"block:position#validate","args":[node,vctx]} -> {"id":2,"ok":true,"result":[Diagnostic...]}
{"id":3,"op":"call","hook":"exercise:toy-quiz#grade","args":[item,response,gctx]} -> {"id":3,"ok":true,"result":<GradeResult>}
```

`apply(ctx)` runs inside the worker against a recording facade; only data (the manifest) leaves, the hook functions stay behind and are invoked by id. That is the §8.1 split: schemas, guidance and manifest are read in the app, hooks run in the worker.

| Mechanism | How it is hosted | Options measured |
|---|---|---|
| Plain worker process | Bun or Node child process, newline-delimited JSON on stdio, plugin imported natively | bare; Node `--permission`; systemd user cgroup (`MemoryMax`, `TasksMax`, `CPUQuota`); bubblewrap; rootless podman |
| QuickJS-wasm (`quickjs-emscripten` 0.32.0, RELEASE_SYNC) | In the Bun host process, or inside a Bun child, or inside the podman container | memory limit, stack limit, interrupt handler |
| isolated-vm 7.0.1 | Node child only (see Bun compatibility), bare or in podman | `memoryLimit`, per-call `timeout`, wall watchdog |
| workerd 1.20261016.1 | Own process, unix-socket HTTP, `globalOutbound` pointed at a deny worker | bare, cgroup, podman |

All 14 combinations return byte-identical JSON to an in-process reference for all 16 cases (`Diffs vs reference` column). The reference itself is checked against the hand-written expectations in [`fixtures/cases.mjs`](fixtures/cases.mjs) first, so the comparison is not self-consistency.

### Latency

| Mechanism (id) | Cold start, first / later (ms) | validate p50 / p99 (ms) | grade p50 / p99 (ms) | validateItem 100 KB p50 (ms) | validateItem 1 MB p50 (ms) | RSS (MB)¹ | Diffs vs reference |
|---|---|---|---|---|---|---|---|
| `proc-bun` | 37 / 66 | 0.08 / 0.18 | 0.09 / 0.17 | 1.52 | 13.2 | 71 | 0/16 |
| `proc-node` | 98 / 77 | 0.10 / 0.24 | 0.13 / 0.62 | 1.40 | 12.6 | 103 | 0/16 |
| `proc-node-perm` | 61 / 78 | 0.12 / 0.50 | 0.14 / 0.42 | 1.20 | 12.7 | 108 | 0/16 |
| `proc-bun-cgroup` | 92 / 64 | 0.07 / 0.16 | 0.09 / 0.16 | 0.93 | 15.4 | 60 | 0/16 |
| `proc-bun-bwrap` | 87 / 77 | 0.08 / 0.18 | 0.09 / 0.17 | 0.92 | 16.0 | 75 | 0/16 |
| `proc-bun-podman` | 532 / 333 | 0.20 / 1.33 | 0.17 / 0.38 | 1.68 | 20.5 | 52 | 0/16 |
| `quickjs-inproc` | 201 / 5 | 0.21 / 0.56 | 0.09 / 0.33 | 2.46 | 27.2 | 64 | 0/16 |
| `quickjs-bun` | 94 / 95 | 0.36 / 1.40 | 0.24 / 0.48 | 4.71 | 27.8 | 121 | 0/16 |
| `quickjs-bun-podman` | 273 / 320 | 0.94 / 50.63 | 0.44 / 1.65 | 3.65 | 36.4 | 68 | 0/16 |
| `ivm-node` | 86 / 87 | 0.28 / 0.50 | 0.21 / 0.65 | 1.70 | 13.3 | 134 | 0/16 |
| `ivm-node-podman` | 256 / 261 | 0.34 / 0.66 | 0.29 / 0.63 | 1.97 | 32.5 | 92 | 0/16 |
| `workerd` | 465 / 40 | 0.49 / 1.35 | 0.45 / 1.06 | 1.06 | 5.6 | 84 | 0/16 |
| `workerd-cgroup` | 107 / 71 | 0.65 / 6.23 | 0.37 / 1.26 | 0.87 | 6.1 | 83 | 0/16 |
| `workerd-podman` | 513 / 2303 | 0.53 / 2.11 | 0.58 / 2.09 | 2.50 | 5.9 | 53 | 0/16 |

¹ Process RSS of the worker (container tiers: the container's init PID); for quickjs-inproc, the host's RSS growth since start.

_14 mechanisms, 300 calls per hook, bun 1.4.2, Node 24.21.0 (child runtime), 8 cores, load average at end 4.36 6.88 6.48, 2026-10-16._

How to read it: `validate` is a ~100 B node, `grade` a ~1 KB item, `validateItem` is run at ~1 KB, ~100 KB and ~1 MB payloads (the last two stress JSON encode/decode, not compute). "Cold start" is spawn (or isolate creation) to first answered `load`, including running `apply()`. The first start in a run pays disk-cache and, for `quickjs-inproc`, one-time wasm compilation (about 85 to 200 ms); creating a further QuickJS runtime and context in the same process costs about 5 ms. This workstation was shared with other spikes (load average 4 to 8), so absolute numbers moved by up to 2x between two full runs (compare `results/latency.json` with the first run quoted in the ADR); the orders of magnitude did not.

### Bun compatibility and packaging cost

| Option | Loads on Bun 1.4.2? | Ships as | Cost to ship |
|---|---|---|---|
| Plain worker process | Yes (Bun child, Node child) | the runtime binary you already have | nothing extra; confinement comes from the container or namespace around it |
| QuickJS-wasm (`quickjs-emscripten`) | **Yes**, in-process and in a child | JS + one 503 KB wasm file | 1.45 MB with only `@jitl/quickjs-wasmfile-release-sync` and `quickjs-emscripten-core` (8 MB with the meta package, which pulls the debug and asyncify variants). No compiler, no postinstall |
| isolated-vm | **No.** `ERR_DLOPEN_FAILED ... undefined symbol: _ZN2v815ValueSerializer8Delegate19HasCustomHostObjectEPNS_7IsolateE`: it is a native addon linked against V8 symbols, and Bun runs on JavaScriptCore. Works only in a Node child (`ivm-node`) | native addon with prebuilds per Node ABI and libc | 20 MB package (about 1 MB per prebuild); needs a Node 24+ runtime in the worker image as well as Bun; a different Node major needs a new prebuild or a node-gyp build with a C++ toolchain; install ran a lifecycle script (`node-gyp-build`) |
| workerd | Yes, as a separate process (the npm package is a launcher for a binary) | one 133 MB binary per platform | 133 MB; has an npm postinstall script (Bun 1.4.2 ran it without asking: `bun pm untrusted` reports 0); refuses to start without a CA bundle even with no network, so a slim container image needs `ca-certificates` or a mount |

## ALI-51: the plugin-host adapter

```sh
bun run adapter:test      # one conformance suite, two PluginHost implementations (cordis and plain Maps) -> results/adapter-conformance.json
bun run adapter:noleak    # import scan + isolated `tsc --strict` proving the platform-facing files need no cordis types -> results/no-leak.json
```

Result: 21/21 checks pass (11 cordis, 10 plain Maps), including a sandboxed plugin whose worker is a QuickJS isolate and one whose worker is a plain Bun process (hooks proxied over RPC, results equal to the first-party run, dispose kills the worker), and a worker that forges a `GradeResult` (rejected host-side). A11 loads QuickJS in rootless Podman through cordis and checks that disposing the fiber removes registrations and the container. Full design notes, the SDK-exposed vs internal table and the cordis mapping are in [`ADAPTER.md`](ADAPTER.md).

## ALI-53: hostile plugin, hard limits and the decision

```sh
bun run hostile                   # all 14 candidates, about 8 minutes -> results/hostile.json
bun run hostile --only workerd-podman
bun run hostile --attacks env,net-loopback,cpu-loop
bun run hostile:render            # renders capability, resource and recovery tables from the JSON result
bun run bench:compute             # fib(27) inside validate() -> results/compute.json
bun run bench:footprint           # worker RSS and 20 extra QuickJS contexts -> results/footprint.json
```

Partial hostile runs write `results/hostile-*.json`, leaving the full result intact. The harness creates only random dummy canaries and local dummy TCP/unix listeners. It measures connection/file effects on the host, so a plugin cannot claim its attempt failed after actually reaching the dummy service. A canary file sits outside the package mounts; an env canary exists in the harness at process exec time, making the `/proc/<ppid>/environ` attempt meaningful. It also checks that a benign call succeeds after each resource attack. Every container, socket and canary directory is removed on exit.

The per-call limits are 1,000 ms host-accounted CPU, 1,500 ms wall, 256 KB response, and a 600 MB emergency host RSS watchdog. QuickJS and isolated-vm use a 48 MB engine cap; Node uses `--max-old-space-size=64`. Confined process tiers use a 256 MB cgroup/container memory cap and 32 pids. The container uses `--network none`, a read-only root and plugin mount, dropped capabilities, no new privileges and no host credentials. Bubblewrap unshares namespaces and runs in a user cgroup. The worker is killed on a limit breach, and the next call restarts it; a pure hook may be retried once after a crash. The test is a probe of API-level attacks, not an exploit-resistance certification.

The capability test covers env and `/proc` reads; file reads and writes outside the package; loopback, LAN, unix-socket and fetch connections; workerd's socket API; subprocesses; process-object access; and privileged imports. Bare Bun/Node and Bun+cgroup escaped 10 of 11; Node `--permission` escaped 6 of 11 including all four network attempts. The OS-confined candidates and the JS isolates escaped 0 of 11. Bare processes spawned all 48 requested subprocesses; cgroup/container tiers capped them. In-process QuickJS blocked the host event loop for the duration of synchronous attacks and took over 5 seconds on an allocation test with a 1.5-second deadline. Out-of-process kills kept the host responsive and made recovery possible.

Host-side parsing rejected NaN, negative/out-of-range scores and oversized feedback. A shape-valid `score: 1` was accepted, demonstrating why `grade()` remains evidence and why estimators and gates stay in the platform. A `revealsAnswer: true` result also parses, so checkpoint disclosure policy must be enforced by the platform. The prototype-pollution case did not modify `Object.prototype`.

### Capability, resource and recovery results

The following tables are rendered from `results/hostile.json` by `bun run hostile:render`.
**Capability attacks** (can the plugin obtain something TM-003 says it must not have?)

| Mechanism | env | fs-outside | fs-write | net-loopback | net-lan | net-unix | fetch | cf-connect | spawn | escape | imports | Escaped |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `proc-bun` | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | blocked | **ESCAPED** | **ESCAPED** | **ESCAPED** | 10 of 11 |
| `proc-node` | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | blocked | **ESCAPED** | **ESCAPED** | **ESCAPED** | 10 of 11 |
| `proc-node-perm` | blocked | blocked | blocked | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | blocked | blocked | **ESCAPED** | **ESCAPED** | 6 of 11 |
| `proc-bun-cgroup` | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | **ESCAPED** | blocked | **ESCAPED** | **ESCAPED** | **ESCAPED** | 10 of 11 |
| `proc-bun-bwrap` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | in sandbox | in sandbox | in sandbox | 0 of 11 |
| `proc-bun-podman` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | in sandbox | in sandbox | in sandbox | 0 of 11 |
| `quickjs-inproc` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `quickjs-bun` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `quickjs-bun-podman` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `ivm-node` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `ivm-node-podman` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `workerd` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `workerd-cgroup` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |
| `workerd-podman` | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked | 0 of 11 |

**Resource attacks** (is the limit enforced, by what, how fast, and did the worker recover?)

| Mechanism | cpu-loop | async-spin | redos | hang-promise | sleep-wall | mem-array | mem-string | mem-buffer | stack | flood | fork |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `proc-bun` | ok: host cpu, 1.0s | ok: host cpu, 1.0s | ok: finished, 0.9s | ok: host wall, 1.5s | ok: host wall, 1.5s | ok: host RSS wd, 0.4s | ok: in-guest err, 0.0s | ok: host RSS wd, 0.4s | ok: in-guest err, 0.0s | ok: host size cap, 0.1s | **UNCONTAINED**: pids cap, 0.1s |
| `proc-node` | ok: host cpu, 1.1s | ok: host cpu, 1.0s | ok: host cpu, 1.0s | ok: host wall, 1.5s | ok: host wall, 1.5s | ok: heap limit, 1.5s | ok: in-guest err, 0.0s | ok: host RSS wd, 0.7s | ok: in-guest err, 0.0s | ok: host size cap, 0.6s | **UNCONTAINED**: pids cap, 0.1s |
| `proc-node-perm` | ok: host cpu, 1.1s | ok: host cpu, 1.0s | ok: host cpu, 1.0s | ok: host wall, 1.5s | ok: host wall, 1.5s | ok: heap limit, 1.5s | ok: in-guest err, 0.0s | ok: host RSS wd, 0.5s | ok: in-guest err, 0.0s | ok: host size cap, 0.7s | n/a: API absent, 0.0s |
| `proc-bun-cgroup` | ok: host cpu, 1.1s | ok: host cpu, 1.2s | ok: host cpu, 1.2s | ok: host wall, 1.5s | ok: host wall, 1.5s | ok: kernel OOM, 0.4s | ok: in-guest err, 0.0s | ok: kernel OOM, 0.3s | ok: in-guest err, 0.1s | ok: host size cap, 0.3s | ok: pids cap, 0.0s |
| `proc-bun-bwrap` | ok: host cpu, 1.1s | ok: host cpu, 1.0s | ok: host cpu, 1.0s | ok: host wall, 1.5s | ok: host wall, 1.5s | ok: kernel OOM, 0.2s | ok: in-guest err, 0.0s | ok: kernel OOM, 0.5s | ok: in-guest err, 0.0s | ok: host size cap, 0.3s | ok: pids cap, 0.0s |
| `proc-bun-podman` | ok: host cpu, 1.3s | ok: host cpu, 1.1s | ok: host cpu, 1.2s | ok: host wall, 1.5s | ok: host wall, 1.5s | ok: kernel OOM, 0.4s | ok: in-guest err, 0.0s | ok: kernel OOM, 0.4s | ok: in-guest err, 0.0s | ok: host size cap, 0.2s | ok: pids cap, 0.0s |
| `quickjs-inproc` | ok: engine, 1.5s **(host loop blocked)** | ok: in-guest err, 1.5s **(host loop blocked)** | ok: engine, 1.5s **(host loop blocked)** | ok: engine, 0.0s | ok: in-guest err, 0.0s | **SLOW**: engine, 8.7s **(host loop blocked)** | ok: in-guest err, 0.0s | ok: in-guest err, 0.3s | ok: in-guest err, 0.0s | ok: host size cap, 1.6s **(host loop blocked)** | n/a: API absent, 0.0s |
| `quickjs-bun` | ok: engine, 2.3s | ok: in-guest err, 1.9s | ok: host wall, 1.9s | ok: engine, 0.0s | ok: in-guest err, 0.0s | ok: host cpu, 1.1s | ok: in-guest err, 0.0s | ok: host RSS wd, 0.7s | ok: in-guest err, 0.0s | ok: host wall, 1.9s | n/a: API absent, 0.0s |
| `quickjs-bun-podman` | ok: host cpu, 1.3s | ok: host cpu, 1.2s | ok: host cpu, 1.2s | ok: engine, 0.0s | ok: in-guest err, 0.0s | ok: kernel OOM, 0.8s | ok: in-guest err, 0.0s | ok: kernel OOM, 0.6s | ok: in-guest err, 0.0s | ok: host cpu, 1.6s | n/a: API absent, 0.0s |
| `ivm-node` | ok: host cpu, 1.1s | ok: host cpu, 1.1s | ok: host cpu, 1.0s | ok: engine, 1.8s | ok: in-guest err, 0.0s | ok: engine, 0.6s | ok: in-guest err, 0.0s | ok: in-guest err, 0.1s | ok: in-guest err, 0.0s | ok: host size cap, 0.3s | n/a: API absent, 0.0s |
| `ivm-node-podman` | ok: host cpu, 1.1s | ok: host cpu, 1.0s | ok: host cpu, 1.0s | ok: engine, 1.8s | ok: in-guest err, 0.0s | ok: engine, 0.6s | ok: in-guest err, 0.0s | ok: in-guest err, 0.1s | ok: in-guest err, 0.0s | ok: host size cap, 0.6s | n/a: API absent, 0.0s |
| `workerd` | **SLOW**: host wall, 3.7s | **SLOW**: host wall, 4.0s | ok: host wall, 1.5s | ok: in-guest err, 0.3s | ok: host wall, 2.5s | ok: host wall, 1.8s | ok: in-guest err, 1.2s | ok: host wall, 1.6s | ok: in-guest err, 0.1s | **SLOW**: host wall, 3.7s | n/a: API absent, 1.7s |
| `workerd-cgroup` | ok: host wall, 1.9s | ok: host cpu, 1.3s | ok: host cpu, 1.0s | ok: in-guest err, 0.0s | ok: host wall, 1.5s | ok: crash, 0.3s | ok: in-guest err, 0.0s | ok: crash, 0.3s | ok: in-guest err, 0.0s | ok: host size cap, 0.1s | n/a: API absent, 0.0s |
| `workerd-podman` | ok: host cpu, 1.1s | ok: host cpu, 1.0s | ok: host cpu, 1.1s | ok: in-guest err, 0.0s | ok: host wall, 1.5s | ok: crash, 0.3s | ok: in-guest err, 0.0s | ok: crash, 0.2s | ok: in-guest err, 0.0s | ok: host size cap, 0.1s | n/a: API absent, 0.0s |

**Host impact and recovery** (worst case over the resource attacks)

| Mechanism | Max host event-loop stall (ms) | Max time to next good answer after a kill (ms) | Peak memory seen by kernel cgroup (MB) |
|---|---|---|---|
| `proc-bun` | 13 | 55 | n/a |
| `proc-node` | 336 | 132 | n/a |
| `proc-node-perm` | 422 | 149 | n/a |
| `proc-bun-cgroup` | 75 | 210 | 256 |
| `proc-bun-bwrap` | 28 | 647 | 256 |
| `proc-bun-podman` | 89 | 101363 | 256 |
| `quickjs-inproc` | 8745 | 15 | n/a |
| `quickjs-bun` | 1349 | 9939 | n/a |
| `quickjs-bun-podman` | 44 | 632 | 256 |
| `ivm-node` | 50 | 86 | n/a |
| `ivm-node-podman` | 499 | 1218 | 149.4 |
| `workerd` | 3392 | 15635 | n/a |
| `workerd-cgroup` | 513 | 2759 | 256 |
| `workerd-podman` | 19 | 2831 | 256 |

**Forged results** (host-side validator on what a worker returns)

| Variant | Host verdict |
|---|---|
| `always-correct` | ACCEPTED score=1 revealsAnswer=false |
| `out-of-range` | REJECTED by host validator: grade.score: expected a finite number in [0, 1], got 99 |
| `nan` | REJECTED by host validator: grade.score: expected a finite number in [0, 1], got null |
| `negative` | REJECTED by host validator: grade.score: expected a finite number in [0, 1], got -5 |
| `huge-feedback` | REJECTED by host validator: grade.feedback.text: expected string up to 2000 chars |
| `proto` | ACCEPTED score=1 revealsAnswer=false |
| `reveal` | ACCEPTED score=0 revealsAnswer=true |

### Compute and memory cost

The recursive `fib(27)` hook (~630,000 calls) exposes the QuickJS interpreter cost. Five measured calls after one warmup gave these medians; see `results/compute.json`.

| Mechanism | fib(27) p50 | Relative to Bun child |
|---|---:|---:|
| Bun child | 3.5 ms | 1× |
| Node child | 4.6 ms | 1.3× |
| QuickJS in app | 57.7 ms | 16.5× |
| QuickJS in Bun child | 64.8 ms | 18.5× |
| isolated-vm in Node child | 5.8 ms | 1.7× |
| workerd | 4.9 ms | 1.4× |

Worker RSS (`results/footprint.json`) is measured after startup and after 1,200 small RPCs; it is a point measurement, not a long soak test.

| Mechanism | Idle RSS | RSS after 1,200 calls |
|---|---:|---:|
| Bun child | 27.4 MB | 43.3 MB |
| Node child | 49.4 MB | 61.1 MB |
| QuickJS in Bun child | 54.1 MB | 74.3 MB |
| isolated-vm in Node child | 55.4 MB | 64.1 MB |
| workerd | 47.9 MB | 68.3 MB |
| Bun in Podman | 26.7 MB | 41.6 MB |
| QuickJS/Bun in Podman | 47.6 MB | 59.2 MB |

Twenty additional QuickJS runtime/context pairs in one Bun process added 37.1 MB, about **1.85 MB each** with the toy plugin loaded. This suggests a shared confined process could be economical, but sharing workers between mutually untrusted plugins needs a separate fault and resource-isolation test.

### Limits of the spike

The 322-row hostile matrix combines the full run with a focused rerun of `quickjs-bun-podman`, `ivm-node` and `ivm-node-podman`. Those candidates missed the original 10-second *startup readiness* window while another spike saturated the workstation; their complete rows were rerun with a 60-second startup allowance and substituted. Per-call limits were unchanged. The full run also saw host scheduling delays: bare workerd missed the nominal 1.5-second wall target by as much as about 2.5 seconds while the machine load average exceeded 20. A production limit supervisor must be independently schedulable and tested under load. This is a reason to enforce kernel limits and kill the whole worker, and not to treat a JS timer in the app as a hard deadline.

The toy plugin is a single self-contained ES module. It mirrors the PRD's registries, block `validate`/`fallback.text`, exercise `validateItem`/`grade` and `apply` manifest, but does not exercise real npm dependency bundles, schemas against persistence, UI iframes, materializers, real Postgres or install scripts. The suite probes API access and resource exhaustion, not runtime, kernel or side-channel exploits. It did not test gVisor, other operating systems, throughput under concurrency, or a 100,000+ call soak.
