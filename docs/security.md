# Security notes

What Hodos protects, how, what tests that, and what it does not cover. It applies to the DeepSeek Harness release (`@hodos/dsh` and the environment bundles). The threat model behind the original platform design is [hodos-threat-model.md](hodos-threat-model.md); [ADR-0006](adr/0006-hodos-as-dsh-plugin-ecosystem.md) records how the design changed for DeepSeek Harness.

Hodos protects three things:

- **The learner's machine**: no plugin code, model output or learner input gets more access than its tier allows.
- **The integrity of mastery**: an answer key never reaches the learner or the model before it is released, and a skill counts as mastered only on unassisted evidence that the engine itself judged.
- **The learner's records**: they stay in a local database and go nowhere else.

## Boundaries

| Boundary | What protects it | Tested by |
|---|---|---|
| Model → Hodos tools | A tool acts for the learner bound to the calling DSH session (`exec.agent.id`). No tool takes a learner id. Checkpoint and placement answers cannot be relayed through the chat. | `adapter.test.ts` ("takes identity from the calling session…", "relays practice answers as assisted…") |
| Tutoring session → other tools | Under `tutorTools: restricted` (the default) a session bound to a journey keeps only Hodos's tools. Global tools are hidden with DSH's `tools.restrict`. Tools that other plugins register in the agent's own scope cannot be hidden: DSH's `subagent` is one. An agent-scoped `tools.guard`, which no later guard can override, refuses them. Hodos's own `hodos_draft_course` starts a subagent, so a tutoring session is not offered it. | `adapter.test.ts`; `tests/e2e/dsh-security.e2e.test.ts` in DeepSeek Harness |
| Browser → Hodos routes | Every API and workspace request passes DSH's own check (`ctx.connection.requestRejection`: sign-in cookie, Host and Origin). The workspace is served with a strict Content Security Policy. Request bodies must be JSON, are size-bounded and validated field by field. | `adapter.test.ts`; `dsh-security.e2e.test.ts` (401 without the sign-in, 200 with it) |
| Workspace → renderer | Environment renderers run in `sandbox="allow-scripts"` iframes: an opaque origin, so no cookies, storage or DOM of the DSH origin. Their files are served with a CSP that is itself a `sandbox` and forbids network access (`connect-src 'none'`). The workspace talks to a renderer only over a `MessageChannel` whose port is handed over once. Both sides parse every message against the protocol: known types only, no extra fields, plain JSON, at most 64 KiB. A renderer only displays and reports a response; it never grades. | `sdk.test.ts` (protocol parsing); renderer e2e tests (malformed messages ignored) |
| Renderer files | `/hodos/env/…` serves plugin assets publicly (they hold no learner data) from inside the renderer's folder only. Encoded `../`, symbolic links out of the folder, NUL bytes, directories and unknown file types are refused. | `adapter.test.ts` ("serves renderer files only from inside the renderer folder") |
| Hodos → plugin code | The trust tiers below. | `registry-sandbox.test.ts`, `example-plugin.test.ts` |
| Grader output → mastery | Grader results are validated (schema, size, only skills the item is tagged with) and are evidence only. The engine's estimators, gates and checkpoint policy decide mastery; no plugin can set a mastery probability, open a gate, skip a checkpoint or mark a skill mastered. A grader that throws, times out or returns something malformed fails closed: the attempt does not count. | `registry-sandbox.test.ts`, `engine.test.ts` |
| Hodos → the network | Hodos makes no outbound requests and sends no telemetry. It reads no credentials. | Source review: the only `fetch` is the workspace calling its own API |

## Plugin trust tiers

| Tier | How a plugin gets it | What Hodos runs |
|---|---|---|
| Built-in | Its manifest id is in the host's `trustedPlugins` setting (default: the four shipped environments). A manifest cannot claim it. | Its in-process hooks, each with a 5 s deadline and validated output |
| Declarative | A directory with `hodos-plugin.json`, listed in `pluginDirs` | No plugin code in the host. Graders and item checks run in the QuickJS sandbox; renderers in sandboxed iframes |
| Other code | Any other package registering through the SDK | None of its hooks; it must ship sandboxed graders |

**A DeepSeek Harness bundle is code that the Harness loads into its own process.** Hodos cannot sandbox that. Installing a third-party Hodos environment as a DSH bundle means trusting it as you would trust any DSH plugin; the "other code" tier only stops Hodos from calling its hooks. For a plugin you do not trust, use the declarative format, which never runs plugin code in the host. The [plugin guide](plugin-guide.md#trust-tiers) has the details.

### The QuickJS sandbox

Sandboxed graders and item checks run in QuickJS (compiled to WebAssembly) inside a separate child process. The process starts with an empty environment and a 256 MB heap cap. Each call gets a fresh interpreter with a 48 MiB heap, a stack cap, 1 s of CPU time, and a 1.5 s wall-clock deadline after which the host kills the process. Results are capped at 256 KiB. The interpreter has no filesystem, network, timers, `process`, `require` or host objects. Tests run a hostile grader that probes for host objects and one that loops forever: the first sees none, the second fails closed.

**Gap:** there is no operating-system confinement (seccomp, namespaces or a container) around that child process. A QuickJS escape would run with the Harness user's rights. [ADR-0002](adr/0002-cordis-on-bun-and-plugin-worker-isolation.md) describes the layer that would add it.

## Answer keys

Server-only data: answer keys, payload fields marked `"x-visibility": "server"`, unreleased hints, explanations and misconception feedback, and the items of a checkpoint pool that are not presented yet.

1. **By construction.** The student-view projection builds everything the learner or the model sees from the item's payload, schema-filtered. Keys are never part of it.
2. **By scanning.** Before any exercise view, hint, step result, attempt result, lesson view or tutor context leaves the engine, it is scanned for the item's withheld fragments. A leak in grader feedback replaces the feedback with a neutral message and records a security event. A leak anywhere else stops the response (fail closed).
3. **Errors.** Hook failures reach the learner as a fixed message; details, which may quote a key, go only to the server log.

**Limits of the scan.** It is a backstop, not the main protection.

- Fragments shorter than 4 characters are not scanned: option ids such as `a` and short numeric answers such as `12`. Matching them would flag ordinary text constantly.
- Fragments of 4 to 7 characters match only as whole words; 8 characters or more match anywhere, ignoring case.
- A paraphrase or another notation of the answer (spelled out, reordered, a different move notation) is not detected.

A plugin whose feedback restates a short answer can therefore leak it. The built-in graders write feedback that names the mistake, not the answer, and their tests check that.

## Checkpoints

A checkpoint is answered in the workspace: no hints, one attempt per item, score-only feedback, no grader feedback, and the tutor's prompt tells it not to help. Answers relayed through the chat are refused. A chat message during a checkpoint marks the open items as assisted. Mastery needs unassisted checkpoint successes.

**Limit:** DeepSeek Harness cannot switch the chat off, and nothing stops a learner from asking another tool or website. Checkpoint integrity is advisory against a learner who wants to cheat themselves.

## Model calls

Hodos never calls a model itself, and plugins cannot. Every source of extra model work is bounded per learner by token buckets:

| Bucket | Burst | Refill |
|---|---|---|
| Tutor notices (`notices: proactive`; the default `quiet` makes no extra calls) | 6 | 1 per minute |
| Hints | 12 | 1 per 30 s |
| Course drafting delegations | 3 | 3 per day |
| Answer submissions | 60 | 1 per second |

## Code execution

No learner code runs in the Harness process. The code environment ships output prediction only: the learner reads a program and types what it prints. Code-writing exercises need an isolated runner that a host provides; none ships, and the DSH bundle offers none.

## Credentials and data

- Hodos reads, stores and forwards no credentials. Course drafting through Claude Code uses whatever Claude Code itself is signed in with; see [course authoring](course-authoring.md#which-sign-in-to-use).
- Learner records live in a SQLite database under `$DSH_HOME/hodos`. It is not encrypted; the operating system's file permissions protect it. Back it up or delete it like any file.
- DeepSeek Harness has one owner principal, so Hodos has one local learner. Anyone who can use the Harness can use that learner's workspace.

## What was not tested

- Platforms other than Linux x64, DeepSeek Harness versions other than 0.2.1-rc.3, and the Desktop app.
- A real DeepSeek model as the tutor: every end-to-end run uses a scripted model, so the prompt rules were never exercised against a model that might ignore them. The tool policy and the leak guard do not depend on the model behaving.
- Real Claude sign-ins or Anthropic's servers: the drafting test uses a local stand-in with a dummy key.
