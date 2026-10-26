# ADR-0006: Hodos as a DeepSeek Harness plugin ecosystem

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-26 |
| **Spike** | Host-integration spike against DeepSeek Harness `0.2.1-rc.3` (evidence below; throwaway code, not committed) |
| **Amends** | Scopes the PRD platform (§9 stack, §9.4 isolation zones, §8.1 registries) down to a DSH-native release. Does not change the learning model (§6.2–§6.5, §7) or ADR-0005. |

## Question

Can Hodos be delivered as installable plugins for DeepSeek Harness (DSH) — reusing its Cordis runtime, agent loop, model providers, Web UI and plugin manager — instead of the self-hosted Bun/Hono/Postgres platform the PRD describes, without forking DSH and without weakening the PRD's mastery and answer-key guarantees?

## Context

The PRD assumes Hodos owns the whole stack: its own server, Postgres, ACP agent lanes and a React SPA. DSH already provides an all-plugin Cordis host with a model-agnostic agent loop, a tool registry, prompt assembly, durable sessions, subagent providers (Claude Code, Codex, ACP, in-process), a Web UI with extension slots, and a profile/bundle installer. The assignment is a DSH-native learning system: one host-independent pedagogical core, a thin DSH adapter, and environment plugins that third parties can write without touching either.

The full extension-point inventory and the capability mapping are in [the DSH compatibility report](../dsh-integration/compatibility.md). DSH was inspected at commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` (`master`, 2026-10-23); runtime verification used the published `@deepseek-ai/dsh@0.2.1-rc.3`, the release nearest that commit.

## Options considered

| Option | For | Against |
|---|---|---|
| A: Standalone Hodos server (PRD §9) with DSH only as an agent backend over ACP | Matches the PRD; full control of storage and UI | Duplicates DSH's agent runtime, model setup, auth and UI; two products to install; no use of DSH's plugin ecosystem |
| B: Fork DSH and add Hodos packages in-tree | Can change any internal API | Forks a fast-moving pre-stable codebase; contradicts "without requiring a DSH fork" |
| C: **Out-of-tree DSH bundles**: a host-independent core + a DSH adapter bundle + one bundle per environment, installed with `dsh plugin add` | Uses only documented extension points; installs like any third-party plugin; core stays testable without DSH | Must live within DSH's extension points; DSH APIs are pre-stable, so the adapter needs a compatibility range and smoke tests |

## Verdict

**Go with changes** on option C. We will ship Hodos as three kinds of packages: `@hodos/core` and `@hodos/plugin-sdk` with no DSH imports; `@hodos/dsh`, a DSH bundle that registers the Hodos service, tools, prompt context, authenticated HTTP routes and a browser half; and one DSH bundle per environment (`@hodos/chess`, `@hodos/language`, `@hodos/code`, `@hodos/math`) that registers into the Hodos service through a structural host interface defined in the MIT SDK.

The changes relative to the PRD:

1. **Storage.** Hodos keeps its own SQLite database (`node:sqlite`, the engine DSH's `storage-sqlite` already uses) under the DSH home, with versioned migrations and multi-statement transactions. DSH's `ctx.storageDomain` offers single-call atomicity and rejects version changes without migration, which cannot hold an append-only evidence log with derived state.
2. **Identity.** DSH has one principal (`{ kind: 'owner' }`). Hodos maps it to one local learner and derives identity from the authenticated request or the calling agent's session id (`exec.agent.id`), never from tool arguments. Learner-scoped storage keeps multi-learner support possible later.
3. **UI.** The learning workspace is a first-party page served by the Hodos route on the DSH origin and embedded in a DSH right-sidebar tab. Environment renderers run one level deeper in `sandbox="allow-scripts"` iframes with an opaque origin and a validated `MessageChannel` protocol (PRD §8.3, TM-009).
4. **Untrusted plugin hooks.** Built-in environments are trusted by an allowlist in the adapter configuration, never by their manifest. Third-party graders and validators must ship as single-file pure-function bundles and run in QuickJS-wasm inside a separate, killable child process with CPU, wall, memory and result-size limits (ADR-0002's mechanism). The OS-level confinement layer of ADR-0002 is not available in this environment and is recorded as a gap.
5. **Agent lanes.** Hodos does not run its own agent. The DSH agent is the tutor (tools + per-agent prompt context); optional course research delegates through `ctx.subagents`, so Claude Code and Codex are used only when the user installed those DSH bundles.

## Evidence

A throwaway bundle (one tool, one prompt section, one authenticated route, one browser half) was installed into fresh `web` and `headless` profiles of `@deepseek-ai/dsh@0.2.1-rc.3` with `dsh plugin --profile <p> add <dir>` (Node 24.22.1, pnpm 11.28.5, Linux x64). A scripted Anthropic-Messages SSE server stood in for the model (`DEEPSEEK_BASE_URL`).

- `dsh --profile web --dump-config` showed the bundle as its own layer; `!!js dshHomePath('…')` resolved under `$DSH_HOME`.
- `dsh headless "…"`: the model request listed the tool and contained the prompt section; the tool executed through the registry and its canonical result reached the next request.
- The route registered with `ctx.webServer.register({ kind: 'prefix', path: '/hodos', … })` answered 401 without the DSH browser cookie and 200 with it, using `ctx.connection.requestRejection({ headers })`.
- Playwright against `dsh --profile web`: the browser half (a `window.__ModuleLoader__.load` CommonJS factory declared through `dsh.client`) applied; `ctx.sidebarRightTabs.register` plus a keyed `sidebar.right.pane.tab` slot produced a guide entry and a tab whose same-origin iframe fetched the authenticated route (200).
- Two failure modes were observed and are now handled in the adapter: `defineTool` rejects JSON-Schema-style `required` arrays (DSH uses per-property `required: true`) and the fiber failure is only logged; `Agent.id`, not `sessionId`, carries the session identity in 0.2.1-rc.3.

Not tested in the spike: Windows/macOS, the Desktop app, DSH versions other than 0.2.1-rc.3, real DeepSeek models, and DSH's built-in `ui-sidebar-browser` (which refuses the DSH origin, so Hodos needs its own tab type).

## Consequences

- Hodos installs, enables and disables like any DSH plugin; each environment row can be toggled independently in DSH's Plugins page.
- The PRD's teacher/admin roles, Postgres, pgvector retrieval, ACP lanes, Course Studio, hub and xAPI forwarding are out of scope for this release. Learner-scoped tables and a versioned course format keep them addable.
- The adapter depends on pre-stable DSH APIs (`ctx.tools`, `ctx.systemPrompt`, `ctx.webServer`, `ctx.connection`, `ctx.sidebarRightTabs`, `ctx.slots`). Packages declare `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`, and the end-to-end suite runs against the installed DSH so a host change fails loudly.
- Tool authorization cannot rely on DSH approval policy alone; Hodos enforces learner scope, mode policy and evidence provenance in the core.

## Follow-ups

- [ ] OS-level confinement (bubblewrap or rootless container) around the QuickJS worker, per ADR-0002.
- [ ] Re-run the DSH end-to-end suite on each DSH release in the supported range.
- [ ] Revisit storage when DSH's storage seam supports migrations and multi-record transactions.
