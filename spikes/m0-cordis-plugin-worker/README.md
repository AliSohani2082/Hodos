# Spike (b): cordis on Bun, and the plugin worker

**Questions.**

1. Does cordis run cleanly on Bun? Its README says the API is unstable and it is built for Node (PRD §15). The fallback is Node for the plugin host.
2. Where should the server-side hooks of non-first-party plugins run (`apply()`, `validate`, `validateItem`, non-code `grade`, `fallback.text`, `migrate`)? Compare a JS isolate (workerd, isolated-vm or QuickJS-wasm) against a plain worker process, by running a plugin's `validate` and `grade` in each.

**Why it matters.** TM-003 requires that these hooks run with no database, no secrets and no network, over JSON-in/JSON-out RPC with CPU and time limits (see the "Plugin worker" paragraph in [PRD §8](../../docs/PRD.md) and the [threat model](../../docs/hodos-threat-model.md)). cordis stays behind a thin adapter either way.

**Exit.** A written go/no-go on cordis-on-Bun and on the plugin-worker design.

**Status.** In progress. ALI-50 (cordis on Bun) is done. ALI-51, ALI-52 and ALI-53 follow.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).

---

## Layout

| Path | What |
|---|---|
| `src/sdk/types.ts` | The public plugin contract sketch (`BlockSpec`, `ExerciseKindSpec`, `GradeResult`, `PluginContext`…). No cordis imports. |
| `src/cordis/` | ALI-50: typed registries as cordis `Service`s and the lifecycle check suite. |
| `fixtures/toy-plugin/` | The toy plugin: one block (`position`, FEN `validate` + `fallback.text`), one layout, one exercise kind (`toy-quiz`: `validateItem` + async `grade`), one preset. |
| `scripts/` | Diff and check scripts. |
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
