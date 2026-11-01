# Security notes

What Hodos protects, how, what tests that, and what it does not cover. It applies to the DeepSeek Harness release (`@hodos/dsh` and the plugin bundles). The threat model behind the original platform design is [hodos-threat-model.md](hodos-threat-model.md). [ADR-0006](adr/0006-hodos-as-dsh-plugin-ecosystem.md) records how the design changed for DeepSeek Harness, and [ADR-0007](adr/0007-learning-harness-on-dsh.md) how it changed again for LearnHarness's process.

Hodos protects three things:

- **The learner's machine.** No plugin code, model output or learner input gets more access than its tier allows, and no learner code runs in the Harness process.
- **The integrity of grading.** An answer key never reaches the learner's browser before the answer, and the key of a question-bank exercise never reaches the model. Only Hodos's own grading of an answer can move a mastery estimate.
- **The learner's records.** They stay in a local database. Hodos sends them nowhere, except that the tutor's own teaching prose goes to the user's default DSH model for knowledge-graph extraction.

## Boundaries

| Boundary | What protects it | Tested by |
|---|---|---|
| Model → Hodos tools | A tool acts on the Hodos session bound to the calling DSH chat (`exec.agent.id`). No tool takes a session or learner id from the model. | `adapter.test.ts` ("takes the session from the calling chat, never from arguments") |
| Hodos session → other tools | Under `tutorTools: restricted` (the default) a chat that is a learning or practice session keeps only the Hodos tools of its phase, Hodos's global tools and DSH's own `ask_user_question`: no shell, file, network or credential tools. Global tools are hidden with DSH's `tools.restrict`. Tools that other plugins register in the agent's own scope cannot be hidden: DSH's `subagent` is one. An agent-scoped `tools.guard`, which no later guard can override, refuses them. `hodos_draft_course` starts a subagent, so a Hodos session is not offered it. | `adapter.test.ts`; `tests/e2e/dsh-security.e2e.test.ts` in DeepSeek Harness (tools offered before and after, a refused `subagent`, a failed hidden `bash`) |
| Browser → Hodos routes | Every API and workspace request passes DSH's own check (`ctx.connection.requestRejection`: sign-in cookie, Host and Origin). The workspace is served with a strict Content Security Policy. Request bodies must be `application/json`, are size-bounded and validated field by field. A question, session or problem must belong to the learner. | `adapter.test.ts`; `dsh-security.e2e.test.ts` (401 without the sign-in, 200 with it) |
| Workspace → renderer | Plugin renderers run in `sandbox="allow-scripts"` iframes: an opaque origin, so no cookies, storage or DOM of the DSH origin. Their files are served with a CSP that is itself a `sandbox` and forbids network access (`connect-src 'none'`); the exception is below. The workspace talks to a renderer only over a `MessageChannel` whose port is handed over once. Both sides parse every message against the protocol: known types only, no extra fields, plain JSON, at most 64 KiB. A renderer only displays and reports a response; it never grades. | `sdk.test.ts` (protocol parsing); renderer e2e tests (malformed messages ignored) |
| Code sandbox renderer | A renderer granted `run-code` (trusted plugins only: the code plugin's sandbox) is served with `script-src 'self' 'wasm-unsafe-eval'`, `worker-src blob:` and `connect-src 'self'`, so it can run Pyodide in a Web Worker and fetch Pyodide's files from the Hodos server. It is still sandboxed in an opaque origin. Python code run there, including test code the tutor wrote, cannot use the Hodos API: a credentialed request from the sandbox fails. | `adapter.test.ts` ("serves only the code sandbox renderer with the policy that lets it run Python"); `registry-sandbox.test.ts` (no grant to untrusted plugins); `dsh-learning.e2e.test.ts` (Python in the sandbox tries to read the state and close the session with credentials; both fail and the session stays open) |
| Renderer files | `/hodos/env/…` serves plugin assets publicly (they hold no learner data) from inside the renderer's folder only. Encoded `../`, symbolic links out of the folder, NUL bytes, directories and unknown file types are refused. | `adapter.test.ts` ("serves renderer files only from inside the renderer folder") |
| Hodos → plugin code | The trust tiers below. | `registry-sandbox.test.ts`, `example-plugin.test.ts` |
| Grader output → verdict and mastery | Grader results are validated (schema, size, only skills the item is tagged with). Only `check` and `review` answers graded by a `deterministic`, `engine` or `oracle` grader move a plan node's estimate; `self-report` and `ai-rubric` grades never do, and neither do the tutor's judgments of answers in the learner's own words or of practice problems. No plugin and no tool can set an estimate. A grader that throws, times out or returns something malformed fails closed. | `learn.test.ts`, `registry-sandbox.test.ts`; `dsh-learning.e2e.test.ts` (a sandbox answer is not evidence) |
| Hodos → models and the network | Hodos makes no outbound requests of its own and sends no telemetry. Its only model calls are knowledge-graph extraction, through DSH's `ctx.llm` on the user's default model, with no tools, under a daily budget (below). It reads no credentials. | `knowledge.test.ts` (budget); `dsh-learning.e2e.test.ts` (the extraction request carries no tools) |

## Remote access

Opening DeepSeek Harness from another device ([self-hosting](self-hosting.md)) moves the whole boundary onto DSH's own sign-in. Hodos adds no sign-in of its own: its routes pass DSH's check like everything else.

- **What protects it.** A random launch token, redeemed once for a signed cookie that is bound to the host name and port it was issued for (30 days by default). API and app requests are refused (403) unless their `Host` header is the listening address, a loopback name or a host named as trusted. Tested in `tests/e2e/selfhost.e2e.test.ts` on a network address and over TLS.
- **What `serve.sh` enforces.** It never listens on all addresses (DSH refuses that as well), accepts no wildcard trusted host, and refuses plain HTTP on a network address unless TLS is configured, the public address is `https://`, or `HODOS_ALLOW_PLAIN_HTTP=1` says the network is private and encrypted. Tested in `tests/integration/serve-script.test.ts`.
- **What it does not do.** Plain HTTP on a network sends the cookie unencrypted, which is why the opt-in exists. The token is in the printed line, so anyone who can read the log can sign in. DSH has no logout: revoking every browser means deleting the owner credential record and restarting. The Harness's shell tool runs as the user that started it; running it in the container or as a dedicated user limits what that reaches.
- **Model key.** Passed in the environment, never stored by Hodos. DSH's shell tool scrubs it from the agent's environment (tested with an `env` command through the mock model).

## Plugin trust tiers

| Tier | How a plugin gets it | What Hodos runs |
|---|---|---|
| Built-in | Its manifest id is in the host's `trustedPlugins` setting (default: the four shipped plugins). A manifest cannot claim it. | Its in-process hooks, each with a 5 s deadline and validated output. Only this tier can be granted the `run-code` renderer capability. |
| Declarative | A directory with `hodos-plugin.json`, listed in `pluginDirs` | No plugin code in the host. Graders and item checks run in the QuickJS sandbox; renderers in sandboxed iframes without network access |
| Other code | Any other package registering through the SDK | None of its hooks; it must ship sandboxed graders |

**A DeepSeek Harness bundle is code that the Harness loads into its own process.** Hodos cannot sandbox that. Installing a third-party Hodos plugin as a DSH bundle means trusting it as you would trust any DSH plugin; the "other code" tier only stops Hodos from calling its hooks. For a plugin you do not trust, use the declarative format, which never runs plugin code in the host. The [plugin guide](plugin-guide.md#trust-tiers) has the details.

### The QuickJS sandbox

Sandboxed graders and item checks run in QuickJS (compiled to WebAssembly) inside a separate child process. The process starts with an empty environment and a 256 MB heap cap. Each call gets a fresh interpreter with a 48 MiB heap, a stack cap, 1 s of CPU time, and a 1.5 s wall-clock deadline after which the host kills the process. Results are capped at 256 KiB. The interpreter has no filesystem, network, timers, `process`, `require` or host objects. Tests run a hostile grader that probes for host objects and one that loops forever: the first sees none, the second fails closed.

**Gap:** there is no operating-system confinement (seccomp, namespaces or a container) around that child process. A QuickJS escape would run with the Harness user's rights. [ADR-0002](adr/0002-cordis-on-bun-and-plugin-worker-isolation.md) describes the layer that would add it.

## Answer keys

Server-only until the learner answers: the committed option of a multiple-choice question and its explanation, the tutor's committed answer to an own-words question, the key of an interface exercise, payload fields marked `"x-visibility": "server"`, and a bank item's explanation and misconception texts. A practice problem's committed solution stays on the server until the tutor concludes the problem.

The tutor writes most questions, so it knows their keys; the guarantee for those is that the learner's browser does not see them first. Question-bank exercises are different: `hodos_bank` lists what the learner would see and how the item was verified, never its key, and the report of an answer carries the verdict and what the learner was shown, not the key itself.

1. **By construction.** The open question's view is built from the plugin's projection of the payload, schema-filtered. Keys, committed answers and explanations are never part of it.
2. **The tutor's question text.** An interface question whose text (or details) contains a distinctive part of its key is refused with "the question text gives away the answer", without quoting the key.
3. **Grader feedback.** Feedback that reveals more of the key than the verdict itself does (the explanation, or a trusted kind's solution) is withheld, and so is the feedback of a stepwise step that is still in progress. A bank item can be asked again, so its key stays withheld after the answer unless the verdict reveals it.
4. **Errors.** Plugin and grading failures reach the learner and the model as fixed messages; details, which may quote a key, go only to the server log.

**Limits of the scan.** It is a backstop, not the main protection.

- Fragments shorter than 4 characters are not scanned: option ids such as `a` and short numeric answers such as `12`. Matching them would flag ordinary text constantly.
- Fragments of 4 to 7 characters match only as whole words; 8 characters or more match anywhere, ignoring case.
- A paraphrase or another notation of the answer (spelled out, reordered, a different move notation) is not detected.

## Questions the model writes

Hodos cannot verify that a question the tutor writes is correct. It checks what it can:

- interface questions are validated by their plugin before the learner sees them (a chess position by chess.js: a legal position, a legal line that does what its theme says; a math key equal to its formula);
- choice questions are checked for shape only: 2 to 8 distinct options, a committed answer among them;
- the panel marks every question the tutor wrote ("Written by the tutor"); questions asked from a bank are not marked.

A deterministic grade of a model-written question shows that the learner matched the tutor's key. If the key is wrong, the grade is wrong, and so is any mastery estimate it moved. Bank exercises do not have this problem to the same degree: their checks ran when the course was validated.

## Model calls

| Source | Bound |
|---|---|
| Tutor turns | The user's own chat. Hodos adds at most one turn per learner action in the panel: starting a session, answering a question, submitting or dismissing a practice problem, asking for the next one. A stepwise step is graded on the server without a model call. Plugins cannot start a turn. |
| Knowledge-graph extraction | `backgroundCallsPerDay` per learner per rolling 24 hours (default 60; 0 turns it off). One run per learner at a time. Automatic runs need 1,500 new characters of teacher prose. At most 24,000 characters of source and 8,000 output tokens per call. |
| Model-written course proposals (`hodos_propose_course`) | 20 at once, refilling at 20 per hour |
| Course drafting through a DSH subagent | 3 at once, refilling at 3 per day |

## Code execution

No learner code runs in the Harness process. The code plugin offers two kinds:

- **Predict the output**: the learner reads a program and types what it prints; nothing runs.
- **The Python sandbox**: the learner writes code and runs it with the exercise's tests in their own browser, with Pyodide (CPython compiled to WebAssembly) in a Web Worker inside the sandboxed renderer. A run that exceeds 8 seconds is stopped by terminating the worker. The submission carries the code and the number of tests that passed; Hodos cannot check that number, so the grader's method is `self-report`, the outcome is feedback, and it never counts as mastery evidence.

Code-writing exercises graded on the server (`code.write`) need an isolated runner that a host provides; none ships, and the DSH bundle offers none.

## Credentials and data

- Hodos reads, stores and forwards no credentials. Extraction uses DSH's model service, which holds the user's provider configuration; Hodos never sees keys. Course drafting through Claude Code uses whatever Claude Code itself is signed in with; see [course authoring](course-authoring.md#which-sign-in-to-use).
- Learner records live in a SQLite database under `$DSH_HOME/hodos`. It is not encrypted; the operating system's file permissions protect it. Back it up or delete it like any file.
- The teacher's prose of a learning session is sent to the user's default DSH model for extraction, which is the same provider the chat itself uses. Imported notes are sent the same way. The learner's answers and thinking are not.
- DeepSeek Harness has one owner principal, so Hodos has one local learner. Anyone who can use the Harness can use that learner's workspace.

## What was not tested

- Platforms other than Linux x64, DeepSeek Harness versions other than 0.2.1-rc.3, browsers other than Playwright's Chromium, and the Desktop app.
- A real DeepSeek model as the tutor: every end-to-end run uses a scripted model, so the prompt rules were never exercised against a model that might ignore them, and how often a real model writes wrong questions is unknown. The tool policy, the key handling and the grading do not depend on the model behaving.
- Extraction quality with a real model: the end-to-end test checks the pipeline with scripted replies.
- Real Claude sign-ins or Anthropic's servers: the drafting test uses a local stand-in with a dummy key.
