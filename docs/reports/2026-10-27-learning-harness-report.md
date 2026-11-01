# Hodos as a learning harness: report

| | |
|---|---|
| Date | 2026-10-27 |
| Branch | `claude/relaxed-ptolemy-s0ydt3` |
| Commits | `6e6097a` (ADR-0007) to `d0b0e58`, plus this report |
| Verified at | commit `d0b0e58` (checks below) |
| Tested with | Linux x64, Node.js 24.22.1, pnpm 11.28.5, DeepSeek Harness `@deepseek-ai/dsh@0.2.1-rc.3`, Chromium through Playwright 1.63.0, CPython 3.13.17, Stockfish 17.1 |

## Summary

You asked for LearnHarness's features and process on top of DeepSeek Harness's plugin system, with a graph view in the sidebar, and for the chess, code and math plugins to become optional ways of asking questions rather than the only things Hodos can teach. That is what this change does ([ADR-0007](../adr/0007-learning-harness-on-dsh.md), [ADR-0008](../adr/0008-learning-session-mechanics.md)).

- **Any topic, LearnHarness's process.** A DeepSeek Harness chat becomes a learning session: probe, plan map, teaching one step at a time with predict and check questions, a knowledge graph of what was taught, and practice sessions on picked propositions.
- **Plugins are interfaces.** Without plugins the tutor asks multiple-choice and own-words questions. `@hodos/chess` adds positions solved on a board like a puzzle; `@hodos/code` adds a Python sandbox that runs in the browser; `@hodos/math` adds expressions; `@hodos/language` adds typed Spanish answers. Someone learning to code installs `@hodos/code` and never sees chess.
- **Your three choices are in:** the mastery estimates stay as an extra layer, code runs in the browser, and the old courses are question banks the tutor can ask verified exercises from.
- **Two sidebar tabs:** "Hodos learning" (plan map, questions, practice) and "Knowledge graph".
- **Hodos still grades on the server.** Choice questions and plugin exercises are graded deterministically; keys never reach the browser before the answer, and bank keys never reach the model.
- **The course-journey engine is gone**, about 3,600 lines of core that nothing called any more.
- The redesign found and fixed seven defects, two of them security-relevant ([below](#defects-found-during-the-redesign)).
- Nothing was published, deployed or sent anywhere. No paid API was called; every model in the tests is a local scripted stand-in.

## What was built

| Component | Package | What changed |
|---|---|---|
| Core (AGPL) | `@hodos/core` | New: learning sessions (phases, plan maps as a validated mermaid subset, three question forms, server-side grading, reports for the tutor), the per-node mastery layer (BKT-lite and FSRS), the knowledge graph (validated model findings, a deterministic merger, views, notes import, deletion, a daily budget), practice sessions, a model port, the course library and the question bank. Removed: the journey engine and the modules only it used |
| DSH adapter (AGPL) | `@hodos/dsh` | Global tools to start learning or practice; phase tools swapped on the chat's agent; questions end the turn and answers return as follow-ups; restricted Hodos sessions (DSH's `ask_user_question` allowed); extraction through `ctx.llm` on the default model; new API routes; two sidebar tabs |
| Workspace (AGPL) | `@hodos/ui` | Rewritten: the session panel (plan map, open question with think-out-loud, answered questions with verdict and reveal, practice) and the knowledge-graph view (force-directed graph with source clusters, list, import, deletion, practise selected); math typeset with KaTeX |
| Code (MIT) | `@hodos/code` | New `code.sandbox` kind and `code-sandbox` renderer: Pyodide in a Web Worker inside the sandboxed iframe, an 8 s run limit, self-reported grading |
| SDK (MIT) | `@hodos/plugin-sdk` | `run-code` renderer capability (trusted plugins only), `self-report` grading method |
| Testing kit (MIT) | `@hodos/testing` | `learningScript`, a scripted tutor for whole sessions, extraction replies and tool passthrough |
| Chess, math, language (MIT) | `@hodos/chess`, `math`, `language` | Unchanged code; their courses are now question banks |
| Docs | `docs/`, READMEs | Rewritten for the new flow; [ADR-0008](../adr/0008-learning-session-mechanics.md); third-party notices in [LICENSING.md](../../LICENSING.md) |

Size: about 20,600 lines of source in 122 files, about 5,400 lines of tests.

## Decisions

1. **Reimplement LearnHarness's process, do not port its code.** Its runtime (Next.js, its own agent loop) does not fit DSH plugins, and its AGPL code must stay out of the MIT SDK. Hodos's prompts are its own wording after LearnHarness's design notes.
2. **Questions end the tutor's turn; the graded answer is its next message** ([ADR-0008](../adr/0008-learning-session-mechanics.md)), instead of a tool call that waits. Nothing is held open, and answers survive the chat's agent going away.
3. **Grading stays on the server.** The tutor commits the answer when it asks; the browser gets only what the learner may see. Interface items are validated by their plugin before the learner sees them.
4. **Mastery as an extra layer**, moved only by `check` and `review` answers graded by `deterministic`, `engine` or `oracle` graders. Own-words answers, practice verdicts and self-reported sandbox runs never move it.
5. **Python in the browser.** Learner code never runs in the Harness. The sandbox's result cannot be checked by the server, so it is feedback only. The capability that lets a renderer run WebAssembly is granted to trusted plugins only.
6. **Background model calls through DSH**, on the user's default model, with no tools, under a per-learner daily budget. Hodos never sees a provider key.
7. **Remove the journey engine; keep courses as question banks.** One learning flow to secure and document.

## Tests actually run

On the source of commit `d0b0e58`, after `pnpm clean` and a fresh build. The end-to-end run was made just before that commit, which changed only unit-test titles and documentation; the other checks ran at the commit itself.

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | passed |
| Lint | `pnpm lint` | 0 findings in 165 files |
| Unit and integration | `pnpm test` | 242 passed, 2 skipped (the live Stockfish and CPython checks, which the next two rows ran) |
| The live CPython check | `HODOS_PYTHON=/usr/bin/python3 vitest run … -t CPython` | passed |
| The live Stockfish check | `HODOS_STOCKFISH=… vitest run … -t "engine protocol"` | passed (Stockfish 17.1) |
| Security subset | `pnpm test:security` | 29 passed |
| Python content | `pnpm verify:snippets` (CPython 3.13.17) | 52 of 52 programs print exactly their expected output |
| Chess content | `pnpm verify:puzzles` (Stockfish 17.1) | 27 verified, 0 failed |
| End to end | `HODOS_DSH_BIN=… HODOS_E2E_CLAUDE_CODE=1 pnpm test:e2e` | 8 files, 31 tests passed |

The end-to-end files, all against real DeepSeek Harness 0.2.1-rc.3 with a scripted model unless noted:

| File | What it shows | Tests |
|---|---|---|
| `dsh-learning` | "I want to learn how knight forks win material": the probe question in the panel, the plan map, a graded prediction, a chess position solved on the board, Python run in the browser sandbox (and the sandbox failing to use the Hodos API), an own-words answer, the knowledge graph filled through the default model, a practice session in a new chat | 8 |
| `dsh-security` | Tools before and after the session starts; a refused `subagent`; a failed hidden `bash`; a question whose text gives its key away refused without quoting it; keys absent from the panel's state; 401 without DSH's sign-in | 5 |
| `example-plugin` | The declarative sample plugin from `pluginDirs`: the tutor lists and asks a bank exercise; its draw-only renderer with the panel's answer field; the sandboxed grader's misconception (one test in a plain browser) | 2 |
| `dsh-tarball-install` | `pnpm pack:dsh` tarballs installed with `dsh plugin add`; the installed `hodos` command; a session asking a chess position on the installed board | 3 |
| `dsh-claude-drafting` | Course drafting through DSH's Claude Code subagent, against a local stand-in for Anthropic's API (opt-in) | 1 |
| `chess-renderer`, `code-renderer`, `math-renderer` | The renderers in a browser under their CSP, with malformed messages | 12 |

## Defects found during the redesign

| Defect | Effect | Fix |
|---|---|---|
| **Final grader feedback was not checked for keys** in learning sessions; the old engine had checked it | A plugin's feedback could reveal a bank exercise's key, and the exercise could be asked again | `86758c0`: feedback that reveals more of the key than the verdict does is withheld; integration test with a grader that quotes the key |
| **Renderers that only draw left no way to answer**: `code-view`, `math-view` and the sample plugin's boxes have no `respond` capability, and the panel hid its own form whenever a renderer existed | Code-reading, algebra and sample-plugin questions could not be answered in the panel | `14d1661`: the panel draws with such a renderer and takes the answer in its own field; e2e with the sample plugin |
| Writing a plan back to mermaid corrupted titles containing `]` | A plan with such a title could not be shown to the tutor as it was | Titles are quoted; a round-trip test |
| Option values derived from labels collided (LaTeX labels reduce to the same slug) | A valid question was refused | Derived values get suffixes; explicit duplicates stay an error |
| The key scan of the tutor's question text refused plain words of a key (the theme "fork" in "find the fork") | Fair questions refused | Only distinctive fragments (8+ characters, or with digits or symbols) are scanned in question text |
| Math answers were sent as `{ expression }`, but the plugin expects `{ text }` | Every typed math answer was rejected | The panel takes the field name from the kind's response schema |
| Propositions were ordered by random id | Flaky order in the graph and its tests | Ordered by creation |

Also found and fixed while writing the docs: the tutor's context was said to list due reviews but no test covered it (now tested), and nothing tested a session with no plugins installed (now tested, including a plugin installed mid-session).

## Compared with LearnHarness

| LearnHarness 0.3.8 | Hodos |
|---|---|
| Prober, then teacher, as separate agents | One DSH agent per chat whose tools and instructions change at the seam |
| Quiz questions graded deterministically; free recall against a committed answer; think-out-loud | Same, plus questions in plugin interfaces graded by the plugin |
| Live mermaid plan map, status from tagged questions | Same, with a validated subset of mermaid |
| Knowledge graph: extractor, auditor, deterministic merger; notes import | Same structure, Hodos's own prompts; deletion and source removal |
| Practice sessions with escalating hints and verdicts | Same, in a new chat started from the graph tab |
| No mastery model | A per-node estimate and review schedule on top, from deterministic grades only |
| Background research, visual explanations, demos, dictation | Not built ([limitations](../limitations.md#compared-with-learnharness)) |

## Install verification

| What | How | Result |
|---|---|---|
| Install from a checkout | `dsh plugin --profile web add <absolute path>` for the adapter and plugins | Done by every DSH end-to-end test |
| Install from tarballs | `pnpm pack:dsh`, then `dsh plugin add <file>.tgz` into a fresh Harness home | e2e `dsh-tarball-install` |
| The `hodos` command | From an installed profile | e2e `dsh-tarball-install` |
| Not re-verified since the MVP report | `disabled: true` rows, `dsh plugin remove`, the DSH Plugins page, macOS, Windows, the Desktop app | — |

## Gaps

The full list is in [known limitations](../limitations.md). The ones that matter most:

- **No real model has tutored.** Every session used a scripted model. How precisely a real DeepSeek model probes, how good its plans are, and how often it writes a wrong question or key are unmeasured. A wrong key makes a wrong grade, and the panel's "Written by the tutor" mark is the only signal.
- **Extraction quality is unmeasured** for the same reason; the pipeline's validation and merging are tested.
- **The Python sandbox is self-reported** and Python-only; it is feedback, not evidence.
- **Not everything of LearnHarness is here:** no background research, visuals, demos or dictation.
- **Security gaps carried over:** no OS confinement around the QuickJS worker; third-party DSH bundles run in the Harness process; the key scan misses short and rephrased answers.
- **One platform, one DSH version, one learner.**

## Next step

Run whole sessions with a real DeepSeek model on three topics, one per plugin (chess tactics, a first Python topic, factoring), and keep the transcripts. Check them against what Hodos recorded: probe precision, plan quality, how many questions arrived malformed or with a wrong key, whether the tutor waited for the panel, and what the knowledge graph extracted. That decides what to improve first: the prompts, the tool descriptions, or the bank's role. After that, in order:

1. interactive demos in a dedicated sandboxed renderer, with a review step before the learner sees them;
2. operating-system confinement for the sandbox worker;
3. with your authorization, publishing the packages to npm so `dsh plugin add @hodos/dsh` works without a checkout.
