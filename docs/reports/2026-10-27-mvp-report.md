# Hodos MVP: final report

| | |
|---|---|
| Date | 2026-10-27 |
| Branch | `claude/relaxed-ptolemy-s0ydt3` |
| Verified at | commit `f118443` (checks below), plus the README and report commit that follows it |
| Tested with | Linux x64, Node.js 24.22.1, pnpm 11.28.5, DeepSeek Harness `@deepseek-ai/dsh@0.2.1-rc.3`, Chromium through Playwright 1.63.0, Stockfish 17.1, CPython 3.13.17 |

## Summary

- Hodos is a set of DeepSeek Harness (DSH) plugins, as [ADR-0006](../adr/0006-hodos-as-dsh-plugin-ecosystem.md) decided:
  - a host-independent engine (`@hodos/core`);
  - an MIT plugin SDK;
  - a DSH adapter with a learning workspace;
  - four environments: chess, Spanish, Python tracing and algebra.
- The demo journey runs end to end in a real DeepSeek Harness, with a scripted model in place of DeepSeek: "Teach me chess tactics. I know the basic rules but struggle with knight forks." It goes through placement, a knight-fork lesson, board practice with a miss, a hint and the right move, a failed checkpoint, remediation, a passed checkpoint, a restart, resuming from a new chat, and a missing environment.
- Grading is deterministic: chess.js (and optionally Stockfish), program output, expression evaluation. No model judges an answer or decides mastery.
- Hardening found and fixed six defects, two of them security-relevant ([below](#defects-found-while-hardening)).
- Nothing was published to npm. The packages install from a checkout or from tarballs that `pnpm pack:dsh` builds; both paths are tested.

## What was built

| Component | Package | Highlights |
|---|---|---|
| Plugin SDK (MIT) | `@hodos/plugin-sdk` | Manifest and course schemas, exercise and grader contracts, server-only fields (`x-visibility`), the renderer protocol with message parsers, `createCordisEntry` |
| Engine (AGPL) | `@hodos/core` | Learning-protocol state machine; adaptive placement; BKT-lite, Elo, Beta and FSRS estimators per learning loop; mastery gates with unassisted checkpoints; item selection; plugin registry with trust tiers; QuickJS sandbox in a child process; Markdoc lessons; course validation and authoring guide; student-view projection and leak guard; token-bucket limits; SQLite store with migrations |
| DSH adapter (AGPL) | `@hodos/dsh` | 18 `hodos_*` tools bound to the calling session; tutoring rules and learner context in the prompt; notices about workspace activity; restricted tutoring sessions (restriction plus guard); authenticated routes; sidebar tab; course drafting through DSH subagents; course inbox; the `hodos` command |
| Workspace (AGPL) | `@hodos/ui` | React app: mode banner, lessons with checks, exercise forms, sandboxed renderer frames, path and progress, draft approval |
| Chess (MIT) | `@hodos/chess` | 53 exercises, 7 skills; puzzles and spot-the-tactic; multi-move lines with opponent replies; misconception feedback; keyboard-accessible board; optional Stockfish for equal alternatives |
| Language (MIT) | `@hodos/language` | Spanish basics: 61 exercises, 6 skills, 6 exercise kinds; accent-tolerant grading with partial credit; gender, word-order and ser/estar feedback |
| Code (MIT) | `@hodos/code` | Python tracing: 42 exercises, 6 skills; output prediction with misreading feedback; highlighted code view; a runner contract for code writing (no runner ships) |
| Math (MIT) | `@hodos/math` | Two algebra courses (35 exercises); expression equivalence by evaluation; form checks; MathML formulas and SVG graphs |
| Testing kit (MIT) | `@hodos/testing` | Scripted Anthropic-Messages model server and tutor script; a fixture plugin that can misbehave on purpose |
| Sample plugin (MIT) | `examples/binary-numbers` | A third-party plugin in the declarative format: sandboxed grader, plain-JavaScript renderer, no host code |
| Tooling | `scripts/`, `.oxlintrc.json` | Build, `pack:dsh` tarballs, `clean`; oxlint with type-aware rules and no inline suppressions |
| Docs | `docs/`, package READMEs | [Architecture](../architecture.md), [install](../install.md), [security](../security.md), [limitations](../limitations.md), [plugin guide](../plugin-guide.md), [course authoring](../course-authoring.md), [compatibility report](../dsh-integration/compatibility.md) |

Size: about 20,000 lines of source in 121 files, about 5,500 lines of tests. Where things live is in [architecture](../architecture.md#repository-layout).

## Decisions

1. **DSH plugins, not a separate server** ([ADR-0006](../adr/0006-hodos-as-dsh-plugin-ecosystem.md)). Hodos uses only documented DSH extension points: tools, prompt, routes, sidebar tabs and subagents. It needs no DSH fork and changes no DSH files.
2. **Its own SQLite database**, because DSH's storage has no migrations or multi-record transactions.
3. **Trust by host allowlist, not by manifest.** Built-in environments run in-process. Anything else runs its graders in a QuickJS sandbox in a separate process, or uses the declarative format. A third-party DSH bundle is trusted like any DSH plugin, and the docs say so.
4. **Renderers are untrusted.** They run in `sandbox="allow-scripts"` iframes under a CSP that forbids network access, and speak a validated `MessageChannel` protocol. They never grade.
5. **Deterministic grading only**; the model is a teaching component. Checkpoints are unassisted and answered in the workspace.
6. **Tutoring sessions keep only Hodos's tools.** DSH's `subagent` survives DSH's own restriction, so an agent-scoped guard refuses it, and course drafting moves out of tutoring sessions.
7. **Course authoring through Claude Code without touching credentials** (see [the Claude section](#your-claude-subscription-and-course-generation)).
8. **Tarballs carry the unpublished `@hodos` packages** as `bundleDependencies`, so they install with `dsh plugin add` without a registry and without publishing.
9. **oxlint instead of ESLint**, with type-aware rules from the TypeScript checker. Biome's formatter was measured and declined: it would rewrite 131 of 190 files.
10. **Licensing:** AGPL core, adapter and workspace; MIT SDK, testing kit and environments. MIT code imports nothing AGPL.

## Tests actually run

All at commit `f118443` from a clean build (`pnpm clean`, `pnpm install --frozen-lockfile`, `pnpm build`).

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | passed |
| Lint | `pnpm lint` | 0 findings in 150 files |
| Unit and integration | `pnpm test` | 226 passed, 2 skipped (the live Stockfish and CPython checks) |
| Same, with the live checks | `HODOS_STOCKFISH=… HODOS_PYTHON=… pnpm test` | 228 passed |
| Security subset | `pnpm test:security` | 27 passed |
| Chess content | `pnpm verify:puzzles` (Stockfish 17.1, depth 18) | 27 verified, 0 failed |
| Python content | `pnpm verify:snippets` (CPython 3.13.17) | 52 of 52 programs print exactly their expected output |
| End to end | `HODOS_DSH_BIN=… HODOS_E2E_CLAUDE_CODE=1 pnpm test:e2e` | 11 files, 33 tests passed |

The end-to-end files, all against real DeepSeek Harness 0.2.1-rc.3 unless noted:

| File | What it shows | Tests |
|---|---|---|
| `dsh-journey` | The demo chess journey, restart and resume, a missing environment | 7 |
| `dsh-vocabulary` | Spanish from the chat to a scheduled review; partial credit for a missing accent | 1 |
| `dsh-code` | Code and math bundles; Python tracing with the code view and misreading feedback | 1 |
| `example-plugin` | The declarative sample plugin from `pluginDirs`: sandboxed grading, its renderer (one test in a plain browser) | 2 |
| `dsh-claude-drafting` | Course drafting through DSH's Claude Code subagent, against a local stand-in for Anthropic's API (opt-in) | 1 |
| `dsh-tarball-install` | `pnpm pack:dsh` tarballs installed with `dsh plugin add`; the installed `hodos` command; a journey from them | 3 |
| `dsh-security` | Tools offered before and after a session tutors; a refused `subagent` call; a failed hidden-tool call; 401 without DSH's sign-in | 4 |
| `dsh-tutor-context` | Learner context only after binding; a workspace answer reaching the model; tutor contact from a chat message | 2 |
| `chess-renderer`, `code-renderer`, `math-renderer` | The renderers in a browser under their CSP, with malformed messages | 12 |

## Install verification

| What | How | Result |
|---|---|---|
| Install from a checkout | `dsh plugin --profile web add <absolute path>` for the adapter and each environment | Done by every DSH end-to-end test |
| Install from tarballs | `pnpm pack:dsh`, then `dsh plugin add <file>.tgz` into a fresh Harness home | e2e `dsh-tarball-install`; also by hand for the adapter, chess and language |
| The `hodos` command | From the checkout (`pnpm exec hodos course guide`) and from an installed profile | Both work. The second failed before a fix ([below](#defects-found-while-hardening)) |
| Disable an environment | A `disabled: true` row in a `--patch` overlay, and in the profile's patch file | e2e (`dsh-journey`) and `dsh --dump-config` by hand |
| Remove | `dsh plugin --profile web remove @hodos/language` | By hand: removed from the profile's dependencies and bundle list |
| Not verified | `npm install -g` of DSH itself (tests used `npm install --prefix`), the DSH Plugins page, macOS, Windows, the Desktop app | — |

## Defects found while hardening

Each was found by a check written to verify a claim in the docs, then fixed with a test that fails without the fix.

| Defect | Effect | Fix |
|---|---|---|
| The workspace re-requested a failed next exercise immediately, in a tight loop | Request storm against the API | `28226c9`: requests that fail or find nothing wait 10 s; retries happen on later polls |
| The `hodos` command imported a module that loads `@deepseek-ai/schemastery`, which only DSH provides | The command failed from an installed bundle (a dev dependency hid it in the repository) | `1a75302`: the trusted-environment list moved to its own module; a test walks the command's import graph |
| Math validation did not check that a key equals the formula it rewrites | A wrong key, for example from a drafted course, would mark right answers wrong | `9543be5`: `math/answer-not-equivalent` |
| **DSH's `subagent` tool stayed callable in tutoring sessions**, because restrictions do not reach tools in the agent's own scope | A tutor, or text that steers it, could reach shell, file and network tools through a subagent | `6660bb0`: an agent-scoped guard refuses every non-Hodos tool; no drafting in tutoring sessions |
| Placement answers produced no tutor notice; a notice summary could carry a checkpoint result | The tutor missed placement activity; results meant to be withheld could reach it | `335a415` |
| The compatibility report listed `sidebarRight.openTab` as verified | No code calls it | `f118443`: corrected, and every status re-checked against the e2e suite |

## Your Claude subscription and course generation

**A correction.** When you asked for DeepSeek Harness to generate courses with your Claude subscription, I said that "Anthropic only allows Pro/Max sign-in to be used inside Claude Code and claude.ai, not by other products." That was too broad. Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page bars third-party developers from offering Claude.ai login or routing requests through Free, Pro or Max credentials on behalf of their users. It also says that this does not prevent an end user from signing in to the unmodified Claude Code binary with their own subscription, including where a platform hosts Claude Code. The [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) note against offering claude.ai login is addressed to developers, here DeepSeek's bundle; whether it constrains that bundle is between DeepSeek and Anthropic. An Anthropic API key is the unambiguous option. This session's own credentials were never used for any of it.

Both routes work without Hodos touching a credential:

1. **Claude Code writes the course** (on your subscription or an API key, as you signed it in). Open Claude Code in this repository and ask for a course; the `hodos-course` skill has it read the authoring guide, write `courses/<id>.json`, validate it and submit it with `pnpm exec hodos course submit`. The running Hodos service imports it as a draft you approve in the workspace.
2. **DeepSeek Harness drafts it through its Claude Code subagent.** Enable DSH's Claude Code subagent bundle, sign in to Claude Code yourself, and set `delegateProvider: claude-code` in the Hodos row of your profile patch. Then, in a chat that is not running a learning journey, ask for a course on an uncovered topic. Hodos validates the answer and keeps it as a draft.

Details and the exact quotes are in [course authoring](../course-authoring.md#which-sign-in-to-use). The second route was tested only against a local stand-in for Anthropic's API with a dummy key, never against a real sign-in.

## Gaps

The full list is in [known limitations](../limitations.md). The ones that matter most:

- **No real model has tutored.** Every journey used a scripted model. Tutoring quality and how well DeepSeek follows the prompt rules are unmeasured. Keys, mastery and the tool policy do not depend on the model.
- **The QuickJS worker has no operating-system confinement**, and third-party DSH bundles run in the Harness process.
- **The leak guard misses answers under 4 characters and rephrased answers**; it backs up a projection that never includes keys.
- **Checkpoint integrity is advisory:** the DSH chat stays open, and other tools exist.
- **Content:** written with an AI coding assistant. Chess positions and lines are checked by chess.js (all) and Stockfish (27 of 53 items); Python outputs by CPython; math keys against their formulas. The Spanish and algebra material and all lesson texts have had no expert review.
- **One platform, one DSH version, one learner.**

## Next step

Run a short evaluation with a real DeepSeek model and a few real learners on the chess course: transcripts of whole journeys, checked against the tutoring rules (no help during checkpoints, no answers given away) and against what Hodos recorded. It is the largest untested part, and it decides what to improve next: the prompt, the notices, or the course matching. After that, in order:

1. operating-system confinement for the sandbox worker;
2. expert review of the Spanish and algebra content;
3. with your authorization, publishing the packages to npm so `dsh plugin add @hodos/dsh` works without a checkout.
