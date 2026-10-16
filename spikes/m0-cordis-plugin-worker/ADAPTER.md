# Plugin-host adapter sketch (ALI-51)

Goal: the platform never imports cordis. cordis is pre-stable (`4.0.0-rc.11`; PRD §15, §18 item 4), so everything that touches it lives in one file, and a second implementation proves it can be replaced.

| File | Role | May import cordis? |
|---|---|---|
| [`src/sdk/types.ts`](src/sdk/types.ts) | Public plugin contract. Becomes `@hodos/plugin-sdk` (MIT). | No |
| [`src/host/plugin-host.ts`](src/host/plugin-host.ts) | Internal `PluginHost` interface and the async `Resolved*` types the platform reads. | No |
| [`src/host/resolve.ts`](src/host/resolve.ts), [`validate-result.ts`](src/host/validate-result.ts) | Turns SDK specs (in-process) or worker manifests (RPC) into `Resolved*`; shape-checks everything a worker returns. | No |
| [`src/host/map-adapter.ts`](src/host/map-adapter.ts) | `PluginHost` on plain Maps. 61 lines. Doubles as the in-memory host the SDK's contract-test harness would use. | No |
| [`src/host/cordis-adapter.ts`](src/host/cordis-adapter.ts) | `PluginHost` on cordis. 100 lines. | **Yes, the only one** |

Checks: `bun run adapter:test` runs one conformance suite (10 checks) against both adapters, 20/20 pass. `bun run adapter:noleak` scans imports and then compiles the five platform-facing files with `tsc --strict` in a directory that has no `node_modules`, so a cordis type anywhere in them fails the build. A negative control (inject `import type { Context } from 'cordis'` into `resolve.ts`) makes both fail.

## The interface

```ts
interface PluginHost {
  readonly registry: HostRegistry                       // blocks(), layouts(), exerciseKinds(), presets(): per-scope read side
  scope(scopeId: string): Promise<PluginHost>           // one scope per course: own registries, same plugin code
  loadFirstParty(id, plugin: PluginModule, config?): PluginHandle      // in-process; allowlisted plugins only
  loadSandboxed(id, worker: PluginWorker, config?): PluginHandle       // code never runs here; host registers data + RPC stubs
  onEvent(listener): () => void
  dispose(): Promise<void>
}
interface PluginHandle { id; state: 'pending'|'active'|'failed'|'disposed'; error; settled(); dispose(); update(config) }
```

The shapes it covers are exactly the ones the PRD lists: `ctx.lesson.layout`, `ctx.lesson.block`, `ctx.exercise.kind`, `ctx.pedagogy.preset`. Plugin authors see them as `PluginContext` (a facade; `ctx.effect` is the only lifecycle primitive).

Four decisions worth keeping, all surfaced by writing it:

1. **Trust is a method, not a field.** `loadFirstParty` vs `loadSandboxed` is chosen by the platform from its allowlist. A manifest cannot ask for `first-party` because there is nowhere to say so (PRD §8.3, TM-003).
2. **Hooks are always async at the platform boundary** (`ResolvedBlock.validate(): Promise<Diagnostic[]>`). A sandboxed hook is an RPC, so a sync platform contract would force first-party plugins to be a different kind of thing. Plugin authors may still write sync or async hooks.
3. **For sandboxed plugins `apply()` runs in the worker, and cordis still owns the lifecycle.** The cordis plugin that gets loaded is a platform-written wrapper (`cordis-adapter.ts` `loadSandboxed`): it starts the worker, reads the manifest, registers data plus RPC stubs through `ctx.effect`, and registers `worker.stop()` as the first effect so it runs last on unload. Conformance check A09 shows dispose removes every registration and kills the worker process. Third-party code is never a real cordis plugin and never receives a cordis `Context`.
4. **Everything a worker returns is validated host-side** (`validate-result.ts`): allowlisted keys, finite numbers in range, length caps. Check A10: a worker that returns `score: 99` is rejected. A `grade()` result is evidence, not authority (PRD §8.2).

## What the SDK (MIT) exposes vs what stays internal

| Exposed in `@hodos/plugin-sdk` | Internal to the platform (AGPL) |
|---|---|
| `PluginModule { name, apply(ctx, config) }` | `PluginHost`, `PluginHandle`, `Resolved*`, `PluginWorker`, `WorkerManifest` |
| `PluginContext` facade: `lesson.block/layout`, `exercise.kind`, `pedagogy.preset`, `effect` | cordis `Context`, `Service`, `Fiber`, `inject`, `isolate`, `ctx.on/emit`, `ctx.logger` |
| Spec types: `BlockSpec`, `LayoutSpec`, `ExerciseKindSpec`, `PresetSpec`, `Item`, `GradeResult`, `Diagnostic`, `LessonNode`, `ValidationContext`, `GradeContext`, `Json` | Trust assignment, allowlist, sandbox profiles and limits, worker spawn/kill, RPC protocol (`glue.mjs`) |
| Contract-test harness (an in-memory host like `map-adapter.ts`, plus fixtures) so authors test without Bun, cordis or a worker | Result validators (`parseGradeResult`…), student-view projection, `x-visibility` stripping, estimators and gates |
| A bundled single-file server entry convention (`server.mjs`, no imports, no Node/Bun globals) | npm install policy: exact versions, integrity hashes, no lifecycle scripts |

Deliberately **not** in the SDK for v1: `ctx.on/emit` and plugin-to-plugin dependency injection. Untrusted hooks run in a worker with no shared heap, so they cannot subscribe to host events or call other plugins' services, and exposing cordis semantics would bind the SDK to cordis. If plugin-to-plugin services are ever needed they belong to first-party plugins and to the host side.

## cordis mapping (what a swap has to re-implement)

| Platform concept | cordis | Map adapter |
|---|---|---|
| scope (course) | `ctx.isolate('hodos', Symbol(scopeId))` + a `HodosRegistry` service in it | child `MapPluginHost` |
| plugin lifecycle | `Fiber`: `ctx.plugin()`, `.await()`, `.dispose()`, `.update(config)`; `FiberState` 0 to 5 mapped to four states | `MapHandle` with a disposer stack |
| registration + unload | `this.ctx.effect(...)` inside the registry service: cordis rebinds the service's `ctx` to the *caller's*, so entries belong to the calling plugin | `register` pushes a disposer on the handle |
| rollback on failure | automatic: a throwing `apply` disposes its earlier effects (check A03/A04) | explicit `teardown()` |
| required boilerplate | `inject: ['hodos']` on every wrapper, else `cannot get property "x" without inject` | none |
| not reproduced by the Map adapter | service hot-swap (dependents torn down and re-activated when a provider restarts, ALI-50 check C04), event bus, typed config schemas, logger | |

The swap cost is therefore: re-implement lifecycle + scoping + rollback in about 60 to 100 lines, plus whatever the platform later starts to rely on from the list in the last row. Nothing in the SDK changes.

## Known simplifications

- Config: cordis validates config with a Standard Schema; here the adapter passes config through. In the product the manifest's JSON Schema would be compiled and checked before `apply`.
- Hook-level timeouts and the circuit breaker (kill the worker after N timeouts) are not in the adapter; the `Sandbox` classes enforce the wall limit per call and the adapter surfaces `HookError`.
- `scope()` is async only because cordis registers its service through a fiber; the interface hides that, and the Map adapter resolves immediately.
- Layout and preset entries are stored as data; their `renderer` / `data` are never executed server-side.
