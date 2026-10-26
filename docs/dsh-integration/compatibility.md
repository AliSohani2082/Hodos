# DeepSeek Harness compatibility report

This report maps every Hodos capability to the DeepSeek Harness (DSH) API it uses, or to the Hodos adapter that fills a gap. It is the source of truth for what the DSH adapter (`@hodos/dsh`) may depend on. The decision behind it is [ADR-0006](../adr/0006-hodos-as-dsh-plugin-ecosystem.md).

## Versions inspected and verified

| Item | Value |
|---|---|
| Source inspected | `deepseek-ai/deepseek-harness` `master` at `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (2026-10-23), `git describe`: `dsh-v0.2.1-rc.3-1533-g22ddee3792` |
| Runtime verified | `@deepseek-ai/dsh@0.2.1-rc.3` from npm (the release nearest the inspected commit), installed into an isolated prefix |
| Supported range declared | `engines.dsh: ">=0.2.1-rc.3 <0.3.0"` |
| Toolchain | Node 24.22.1 (DSH requires `>=24.9`), pnpm 11.28.5 (DSH's pinned package manager) |
| Cordis | `@deepseek-ai/cordis` 4.0.5 (vendored and rescoped by DSH) |

Every API below was checked twice: in the source at the inspected commit, and in the published `lib/types/*.d.ts` of the 0.2.1-rc.3 packages. Where the two differ, the published rc.3 surface wins and the difference is noted.

## Extension-point inventory

| Need | DSH API (owner package) | How Hodos uses it | Status |
|---|---|---|---|
| Plugin format | Cordis function/object/`Service` plugins with `name`, `inject`, `Config`, `apply(ctx, config)` (`@deepseek-ai/cordis`) | Every Hodos host module is a Cordis plugin; sub-plugins are mounted with `ctx.plugin()` | Verified (spike + e2e) |
| Service registration and injection | `class X extends Service { constructor(ctx) { super(ctx, 'hodos') } }`; `inject: ['hodos']` waits for the service | `ctx.hodos` is the Hodos service; environment bundles inject it | Verified (e2e) |
| Lifecycle and disposal | `ctx.effect(() => disposer)`, `ctx.on()`; registries return disposers; dependants unload when an injected service disappears | Environment registration, routes, tools and timers are effects; unloading an environment removes its kinds, graders and renderers | Verified (e2e unload/reload test) |
| Configuration | Exported `Config` Schemastery schema (`@deepseek-ai/schemastery`); `!!js` expressions in `cordis.yml` `config` | `dataDir: !!js dshHomePath('hodos')`, mastery threshold, limits, trusted plugin list | Verified (spike + e2e) |
| Tool registration | `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute(args, exec) }))` (`@deepseek-ai/dsh-tools`) | `hodos_*` tools. Object outputs use per-property `required: true` and mandatory `additionalProperties` | Verified (spike + e2e) |
| Caller identity in tools | `exec.agent` (the calling `Agent`); `Agent.id: SessionId` | Learner binding is looked up by session id; tools take no learner id argument | Verified. The source also has `CreateAgentOptions.sessionId`; the live handle field is `id` |
| System prompt extensions | `ctx.systemPrompt.section({ name, order, text })`; `ctx.systemPrompt.context({ name, order, text })` (`@deepseek-ai/dsh-system-prompt`) | A static tutoring-rules section; a per-agent learner context registered through `agent.ctx.systemPrompt.context()` on `agent/created` | Verified (spike: section; e2e: context) |
| Agent and session events | `agent/created` (serial), `agent/disposed`, `session/event` (durable `SessionEvent`s) | Per-agent context; checkpoint integrity watches `user/message` events in bound sessions | Verified (e2e) |
| Model-facing notices | `agent.inject(createUserMessage({ content, source: { kind, form: 'notice', summary } }))`; `MessageSourceMap` declaration merging (`@deepseek-ai/dsh-llm`) | Rate-limited notices to the tutor when the learner acts in the workspace | Verified (e2e) |
| Persistent storage | `ctx.storage` / `ctx.storageDomain` (KV units, single-call atomicity, `version-mismatch` without migration) | **Not used** for learning data; see the storage adapter row | Inspected |
| Storage adapter (gap) | `node:sqlite` `DatabaseSync` (same engine as `@deepseek-ai/dsh-storage-sqlite`) | Hodos SQLite file under `dshHomePath('hodos')`, WAL, versioned migrations, `BEGIN IMMEDIATE` transactions | Verified (restart test) |
| HTTP routes | `ctx.webServer.register({ kind: 'prefix', path, handler })` (`@deepseek-ai/dsh-host-webserver`); rc.3 accepts handler routes only | `/hodos/api/*`, `/hodos/app/*`, `/hodos/env/*` | Verified (spike + e2e) |
| Route authentication | `ctx.connection.requestRejection({ headers })` → `401 \| 403 \| undefined` (`@deepseek-ai/dsh-client-connection`): Host/Origin checks plus the browser session cookie | Every `/hodos/api/*` request; the DSH owner principal maps to the local learner | Verified (spike: 401 without cookie, 200 with) |
| Web application extension | `dsh.client: { platform: 'web' }` in `package.json` + `exports["./client"]`; the bundle is a CommonJS factory passed to `window.__ModuleLoader__.load({ id, factory })`; platform modules (`react`, `react-dom`, `@deepseek-ai/cordis`, …) come from the injected `require` (`@deepseek-ai/dsh-client-modules`) | `@hodos/dsh/client` is built with esbuild into that format | Verified (spike + e2e) |
| Custom frontend rendering | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` and `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key, inject }, Component))` (`@deepseek-ai/dsh-client-ui-sidebar-right`, `ui-slots`); slot `inject(sessionId)` gives the session | A "Hodos" right-sidebar tab whose body is an iframe of `/hodos/app/?session=<id>` | Verified (spike + e2e) |
| Opening the tab from code | `ctx.sidebarRight.openTab(kind)` | "Open learning workspace" from the tool view | Verified (e2e) |
| Plugin installation | `dsh plugin --profile <p> add <path\|tarball\|spec>`; `remove`; `package.json` `dsh.bundle.patch`; `engines.dsh` checked on install and boot (`@deepseek-ai/dsh-plugin-manager`) | Each Hodos package is a bundle; environments install separately | Verified (spike: link; e2e: tarball) |
| Enable/disable | Profile `cordis.patch.yml` row overrides `- id: hodos-chess\n  disabled: true`; Plugins page toggles | Documented per environment | Verified (e2e) |
| Subagent delegation | `ctx.subagents.startActivation({ provider, label, request: { prompt, parent, outputSchema? }, signal, delivery: 'caller' })`; providers registered by `dsh-subagent-claude-code`, `-codex`, `-acp`, in-process spawn (`@deepseek-ai/dsh-subagent`) | Optional `hodos_delegate_research`; mounted only when `subagents` exists | Inspected; unit-tested with a fake runtime (no real provider credentials here) |
| Human approval | `tools/pre-execute` waterfall may return an `ask` decision answered through `ctx.approval` | Not used: course approval is a learner action in the Hodos workspace, never a model call | Inspected |
| Model provider | Anthropic-Messages-compatible SSE at `$DEEPSEEK_BASE_URL/v1/messages` (`@deepseek-ai/dsh-llm-deepseek`) | Not used by Hodos directly. Keyless tests point DSH at `@hodos/testing`'s scripted mock | Verified (spike + e2e) |

## Packaging rules that DSH imposes

- A bundle is an npm package with `dsh.bundle.patch` pointing at a YAML patch list; the patch inserts rows by `id`. Rows in a bundle patch name packages resolvable from that bundle.
- DSH packages shared with the host (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`) are `peerDependencies` so the running installation's copy is used.
- A browser half must not runtime-import another DSH client plugin; it may import only the platform modules. Hodos's browser half imports `react` only and talks to DSH through injected services.
- Packages installed from git need a `prepare` build and an explicit build allowance; Hodos ships prebuilt tarballs instead.

## Gaps and adapters

| Gap | Adapter | Remaining limitation |
|---|---|---|
| No migratable, transactional storage seam | Hodos SQLite store with its own migrations | Not visible in DSH's storage tooling; backed up by copying the `hodos` directory under `$DSH_HOME` |
| One DSH principal | Owner → `learner:local`; learner-scoped tables | Multi-learner support needs DSH principals first |
| No plugin-worker isolation in DSH | QuickJS-wasm in a killable child process (ADR-0002 mechanism) for untrusted graders/validators | No OS confinement layer; trusted built-ins run in-process |
| `ui-sidebar-browser` refuses the DSH origin | Hodos registers its own tab type | — |
| DSH chat cannot be disabled during a checkpoint | Prompt context forbids help; checkpoint attempts made while the learner messaged the tutor are recorded as assisted | Advisory against a determined learner who uses another tool |
| No secure code runner in this environment | `@hodos/code` ships a non-executing exercise kind and a tested runner adapter contract | Executable code exercises are disabled unless a runner is configured |

## Safe-to-consume services

Hodos consumes only documented Service Definitions: `tools`, `systemPrompt`, `agents`, `webServer`, `connection`, `subagents` (optional), and on the browser `slots`, `sidebarRightTabs`, `sidebarRight`. It never imports a concrete provider (`dsh-agent-loop`, `dsh-bash-local`, …), never writes DSH's own storage units, and never reads DSH credentials.
