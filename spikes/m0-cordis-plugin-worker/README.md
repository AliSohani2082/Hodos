# Spike (b): cordis on Bun, and the plugin worker

**Questions.**

1. Does cordis run cleanly on Bun? Its README says the API is unstable and it is built for Node (PRD §15). The fallback is Node for the plugin host.
2. Where should the server-side hooks of non-first-party plugins run (`apply()`, `validate`, `validateItem`, non-code `grade`, `fallback.text`, `migrate`)? Compare a JS isolate (workerd, isolated-vm or QuickJS-wasm) against a plain worker process, by running a plugin's `validate` and `grade` in each.

**Why it matters.** TM-003 requires that these hooks run with no database, no secrets and no network, over JSON-in/JSON-out RPC with CPU and time limits (see the "Plugin worker" paragraph in [PRD §8](../../docs/PRD.md) and the [threat model](../../docs/hodos-threat-model.md)). cordis stays behind a thin adapter either way.

**Exit.** A written go/no-go on cordis-on-Bun and on the plugin-worker design.

**Status.** In progress. ALI-50 (cordis on Bun), ALI-52 (isolate vs process) and ALI-51 (adapter) are done. ALI-53 (isolation tests, ADR) follows.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).

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

Result: 20/20 checks pass (10 per adapter), including a sandboxed plugin whose worker is a QuickJS isolate and one whose worker is a plain Bun process (hooks proxied over RPC, results equal to the first-party run, dispose kills the worker), and a worker that forges a `GradeResult` (rejected host-side). Full design notes, the SDK-exposed vs internal table and the cordis mapping are in [`ADAPTER.md`](ADAPTER.md).
