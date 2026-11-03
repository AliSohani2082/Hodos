# Security and product review

| | |
|---|---|
| Date | 2026-11-02 |
| Branch | `claude/epic-turing-ejlue8` |
| Reviewed | the whole repository at `5cb7332` (`main`); `spikes/` only for committed secrets |
| Tested with | Linux x64, Node.js 24.22.1, pnpm 11.28.5, Playwright's Chromium 153. No DeepSeek Harness binary (installing it from npm was not permitted in this environment), no Stockfish, `HODOS_PYTHON` unset |

## Summary

- **Security: no vulnerability reached the reporting bar.** Each part of the code was reviewed separately, and every candidate finding got its own false-positive check. Only findings scored 8/10 or higher count; none did. The main boundaries hold: the HTTP API, the renderer sandbox, the QuickJS grader sandbox, answer keys, tool identity, SQL and file handling ([below](#checked-and-found-sound)).
- **Five candidates scored 2 to 7.** They are real defects in safety controls or in grading, not exploitable vulnerabilities by that bar. This change fixes four of them in code. For the fifth, WebRTC, no fix is possible in Chromium, so this change corrects the docs instead.
- **Two more hardening gaps were found and fixed.** The answer-key projection did not follow `$ref`s, combinators or conditionals, and a schema marked `$async` passed every value.
- **Every fix has a regression test that fails on the old code.** Unit tests: 254 passed (242 before), 2 skipped as before. Browser end-to-end: 13 passed. The DeepSeek Harness end-to-end tests could not run here.
- **Product: it does what the current goal asks.** That goal is LearnHarness's process on DeepSeek Harness ([ADR-0007](../adr/0007-learning-harness-on-dsh.md), [ADR-0008](../adr/0008-learning-session-mechanics.md)).
  - It has drifted from the original PRD on three of the PRD's four differentiators, and the PRD was never updated after the two changes of direction.
  - The largest product risk is unchanged: no real model has ever tutored.

## Security review

### Method

This used the security-review method, applied to the whole codebase rather than to a diff:

1. Four reviews ran in parallel, one per area:
   - the DSH adapter and the build scripts;
   - `@hodos/core`;
   - the browser side (workspace, renderers, renderer protocol);
   - the environment plugins, the plugin SDK and the sample plugin.

   Each review read the project's own threat model first.
2. Each candidate finding then got a separate false-positive check, with the standard exclusions (denial of service, missing hardening, theoretical issues and so on).
3. Only findings scored 8/10 or higher are reported as vulnerabilities.

On top of this, I scanned the tree and the git history for secrets (none found), confirmed two gaps by experiment, and tested what the browser enforces in Chromium.

### Candidate findings

| # | Candidate | Where | Score | Verdict | Done in this change |
|---|---|---|---|---|---|
| 1 | A renderer can reach the network through WebRTC | `dsh-adapter/src/http.ts` (renderer CSP) | 7/10 | Below the bar. The behaviour is real: Chromium sent UDP to a host the renderer chose | Docs and comments corrected. A CSP fix is not possible: Chromium 153 reports `webrtc 'block'` as an unrecognized directive and still sends the packets (tested) |
| 2 | The tutor's tool restriction fails open if DSH refuses it | `dsh-adapter/src/tutor-sessions.ts` | 4/10 | Hardening. It needs a profile without `ask_user_question` plus a prompt-injection chain | **Fixed: fails closed** |
| 3 | A declarative plugin can claim a built-in's ids, renderer and course ids, and ship false `verifiedBy` claims | `core/src/registry/registry.ts`, `core/src/courses/library.ts` | 3/10 | Hardening. The plugin still runs no code in the host | **Partly fixed.** Trusted renderers are preferred, and untrusted claims are dropped. The rest is documented and recommended |
| 4 | Math "factored" and "expanded" answers can be forged: `1(x^2+5x+6)`, `(x+1)/(1/(x+2))` | `environments/math/src/expr.ts`, `kinds.ts` | 2/10 | A correctness bug: the learner only fools their own mastery estimate | **Fixed** |
| 5 | The tutor can test guesses at a bank key: a refusal says "the question text gives away the answer" | `core/src/learn/service.ts` (`checkInterface`) | 2/10 | A quality issue: the learner can read the key locally anyway | **Fixed** |

### Fixes

All fixes are small and local. Each has a test that fails on the old code and passes now.

| Fix | What changed | Test |
|---|---|---|
| Tutor sessions fail closed | The deny-by-default guard is installed before the restriction and the tools. If setup fails, the guard stays and the next change retries. A host tool missing from the composition (`ask_user_question`) is dropped from the restriction instead of making it throw | `adapter.test.ts` "keeps a Hodos session closed to other tools when DSH refuses the restriction". Its fake `restrict()` now throws on unknown names, like DSH's |
| Answer-key projection follows the whole schema | `stripServerFields` removes a value when any subschema that applies to it is marked server-only: combinators, conditionals, `dependentSchemas`, `patternProperties`, and local `$ref`/`$dynamicRef` targets. It withholds a value behind a reference it cannot follow (remote, anchor, nested `$id`), and no longer looks properties up through the prototype chain. `serverOnlyPaths` follows the same rules | `sdk.test.ts` "honours server-only markers behind references, combinators and conditionals"; "looks up declared properties without the prototype chain" |
| `$async` schemas refused | An async validator returns a promise, which read as "valid" for any input, and its rejection went unhandled. `compileSchema` now refuses such schemas | `sdk.test.ts` "refuses asynchronous schemas" |
| Text views from the projection | `registry.fallbackText` builds an exercise's plain text (shown to the learner and the tutor) from the projected payload. Before, it read the raw payload, including server-only fields. The text of all 191 built-in exercises is unchanged (checked) | `registry-sandbox.test.ts` "builds text views from what the learner may see" |
| Math forms | When the key is a polynomial, "factored" needs at least two polynomial factors of degree one or more, or a whole number other than 0 and ±1 taken out of one factor with whole-number coefficients. "Expanded" needs a polynomial with no sum inside a product, a quotient or a power. Keys that are not polynomials keep the old check | `math.test.ts` "does not take a wrapped copy of the formula as factored or expanded", plus grading on shipped items |
| Bank-key oracle closed | A bank exercise's question text is no longer scanned against its key: the tutor never sees the key, so a refusal could only confirm a guess. A bank item that no longer validates gets a fixed message instead of the plugin's findings | `learn.test.ts` "asks a bank exercise whatever the tutor's text guesses" |
| Trusted renderer preferred | `rendererFor` picks a trusted plugin's renderer before a sandboxed one that lists the same environment | `registry-sandbox.test.ts` "draws an environment with a trusted plugin's renderer…" |
| Untrusted packs make no verification claims | A sandboxed plugin's `provenance.verifiedBy` is dropped on import, as is already done for drafts | `courses.test.ts` "keeps the verification claims of trusted plugins' packs only" |
| Drafts cannot be swapped | A proposal from another source can no longer replace a waiting draft with the same id and version. Before, the tutor could replace an inbox draft's content while it still showed as "imported" | `courses.test.ts` "does not let a proposal from another source replace a waiting draft" |
| Renderer folders hold no keys | A declarative plugin whose renderer folder contains its description, graders or content packs is refused at load. That folder is served without sign-in, to any origin | `registry-sandbox.test.ts` "refuses a renderer folder that would serve…" |
| Engine command stream | `UciEngine.analyse` refuses a FEN with a line break. Every current caller passes a canonical FEN, so nothing was exploitable | `chess.test.ts` "refuses a FEN with a line break" |

Docs updated to match: [security notes](../security.md) (boundaries, trust tiers, answer keys), the [plugin guide](../plugin-guide.md) (how server-only markers are treated, renderer folders, the network caveat) and [known limitations](../limitations.md) (WebRTC, first-come plugin ids).

### Checked and found sound

- **HTTP.** DSH's own request check runs before every API and workspace request: Host header, Origin, `Sec-Fetch-Site`, and a signed `HttpOnly; SameSite=Strict` cookie. State changes are POST-only, `application/json` only, capped at 64 KiB, and must be a JSON object. Responses carry no keys and no tutor reports.
- **Renderer files.** The path is decoded once. NUL bytes, `..` (encoded or not), symbolic links out of the folder, directories and unknown file types are all refused. Every file is served with a `sandbox` CSP and `nosniff`.
- **Browser.**
  - There is no unsafe DOM sink anywhere in the source (`innerHTML`, `dangerouslySetInnerHTML`, `eval` and the like).
  - The Markdown renderer builds React elements only. KaTeX runs with `trust: false`.
  - Renderers run in `sandbox="allow-scripts"` iframes without `allow-same-origin`.
  - The `MessageChannel` protocol is parsed strictly on both sides, and each renderer accepts its port only from its parent.
  - Python in the code sandbox cannot use the Hodos or DSH API.
- **Grader sandbox.**
  - Every call gets a fresh QuickJS runtime with memory, stack and CPU limits, and no host objects.
  - It runs in a child process with an empty environment, killed at the wall-clock deadline.
  - Results are size-capped and validated, and failures fail closed.
  - Trust comes from the host's allowlist, never from the manifest.
- **Answer keys and grading.** Open questions carry no key. An answer is graded once, under a status check inside a transaction. Ownership is checked on every learner operation. Ids come from `randomUUID`. Only `check` and `review` answers graded by a deterministic, engine or oracle grader move mastery.
- **Model tools.** The session always comes from `exec.agent.id`, never from arguments. Only the workspace channel can approve a draft.
- **Storage and files.** Every SQL statement uses bound parameters. Inbox reads use `O_NOFOLLOW` and check name patterns and size. The CLI sanitizes file names.
- **Environments.**
  - The math evaluator is a custom parser that never evaluates text as code.
  - The chess engine is started with `shell: false` and an empty environment.
  - The code plugin runs nothing on the server.
- **Secrets.** None in the tree or in the git history. The only key-like string is a labelled placeholder in a spike.

### Not fixed here (recommended)

1. **Plugin id ownership.** Reserve the ids of `trustedPlugins`, or let a trusted registration evict an untrusted plugin that holds its ids. Namespace pack course ids by plugin. Until then, [known limitations](../limitations.md#security) says to install only declarative plugins whose ids don't clash with the built-ins'.
2. **WebRTC.** Add the CSP `webrtc` directive once Chromium supports it. Until then, treat a declarative renderer as able to send out what it is shown.
3. **Workspace CSP.** It allows any same-origin script (`script-src 'self'`), and that includes plugin renderer JavaScript under `/hodos/env/`. Use a hash or a nonce for the workspace's own bundle.
4. **Code sandbox.** Give the code sandbox renderer its own folder (today it shares one with `code-view`, so both are served under the run-code policy), and narrow its `connect-src` to the Pyodide path.
5. **Choice order.** Choice options are shuffled with a seed taken from the public question id, and the option values are the ones the model chose (often `a`, `b`, `c`). Together these let anyone recover the order the model wrote. Shuffle with a random order kept on the server, and show opaque option tokens.
6. **Grader worker.** Start the QuickJS worker with Node's permission model, or add OS confinement (the documented gap). Give each plugin its own Ajv instance, because `$id`s are shared across plugins today.
7. **Approval.** Tie draft approval to a digest of the content the learner saw.

## Product review

### What "the goal" is

| When | Statement | Product |
|---|---|---|
| 2026-10-10 | [PRD](../PRD.md) v0.2, the original goal | A self-hosted, multi-role platform. A teacher steers any agent harness to build a course and approves it like a pull request; students learn with a mastery model the platform guarantees. It competes on four things: (1) a versioned blueprint the teacher approves; (2) a platform-owned mastery model; (3) sandboxed plugins with server-side graders and secret keys; (4) class-level tracing |
| 2026-10-26 | [ADR-0006](../adr/0006-hodos-as-dsh-plugin-ecosystem.md) | Delivered as DeepSeek Harness plugins. Teacher and admin roles, Course Studio, Postgres, retrieval, ACP lanes, the hub and xAPI are out of scope |
| 2026-10-27 | [ADR-0007](../adr/0007-learning-harness-on-dsh.md) and [ADR-0008](../adr/0008-learning-session-mechanics.md) | Any topic, through LearnHarness's process: probe, plan, teach, a knowledge graph and practice. Plugins become optional ways to ask questions, courses become question banks, and mastery is an extra layer |

### Against the current goal (ADR-0007): met

| LearnHarness process | Status in the code |
|---|---|
| Probe that brackets each strand, then an assessment | Built (`hodos_probe`, `hodos_recall`, `hodos_probe_exercise`, `hodos_probe_done`); the method is in the prompt (`dsh-adapter/src/doctrine.ts`) |
| A live plan map, validated as a DAG | Built: a mermaid subset with at most 30 nodes; status comes from tagged questions |
| Teaching as predict → teach → check, choices graded deterministically, own-words answers against a committed answer, think-out-loud | Built, and graded on the server |
| Knowledge graph: extractor, auditor, deterministic merger; notes import | Built (`core/src/knowledge/*`), with deletion and source removal on top |
| Practice sessions with escalating hints and verdicts | Built, rungs R0 to R5; never moves mastery |
| Plugins as optional question interfaces | Built: chess, Python sandbox, math, Spanish, and a declarative SDK with a sample plugin |
| Background research, visual explanations, demos, dictation | Not built (documented) |

All of this runs end to end against DeepSeek Harness 0.2.1-rc.3, but only with a scripted model.

### Against the original PRD: three of four differentiators weakened or gone

| PRD differentiator | Now | Evidence |
|---|---|---|
| (1) A versioned blueprint the teacher approves, reviewed structure first and then as a diff | **Mostly gone.** Courses are question banks, approved with one button. The card shows a title, an item count and where it came from, with no skills, items or diff | `ui/src/App.tsx:70-85` |
| (2) A platform-owned mastery model: "mastered" means the same everywhere | **Weakened** (see below) | `core/src/learn/mastery.ts:88` |
| (3) Sandboxed plugins, server-side graders, secret keys | **Kept; the strongest part.** This review tightened it further | the security review above |
| (4) Class-level tracing | **Gone.** One learner, no teacher role | ADR-0006 |

**Why (2) is weakened:**
- The tutor writes most questions and their keys.
- A plan node counts as "mastered" once its BKT-lite estimate reaches θ. That takes 3 consecutive correct checks on an exercise or a 5-option question, 4 on a 4-option question, or 6 on a 2-option question (computed with the shipped parameters).
- There is no rule about distinct items and no unassisted-checkpoint gate, though the MVP had both ([ADR-0005](../adr/0005-bkt-lite-and-fsrs-defaults.md): "≥3 unassisted distinct checkpoint successes").
- So PRD goal G2, "mastery is real, not inflated by hints or guessing", depends on the tutor asking good, varied questions.

**PRD goals:**
- **G1** (teacher course creation): replaced by tutoring on demand.
- **G2** (real mastery): weakened, as above.
- **G3** (trustworthy content: citations, no key disagreements): citations and retrieval were dropped. Model-written choice questions are checked for shape only (documented).
- **G4** (different subjects through plugins): met.
- **G5** (safe self-hosting): replaced by a local DeepSeek Harness install.
- **G6** (any agent harness): partly met through DSH subagents. Drafting with Claude Code was tested only against a local stand-in.

### Product issues

1. **The PRD no longer describes the product, and was never amended.** The ADR process says: "If the decision changes the PRD, edit the PRD in the same change" (`docs/adr/README.md:10`). The PRD was last edited in `2f879c1` (2026-10-18), before both changes of direction, and still says "Draft v0.2". Anyone judging the project against "the original goal" will judge it against a different product.
2. **No real model has tutored.** The product's value lies in teaching quality driven by the prompt, and that is unmeasured. The previous report's next step, three real sessions, has not happened.
3. **The "mastered" label is easy to earn**, as described above. The plan map shows it next to the node (`ui/src/plan-map.tsx:117-129`).
4. **Approval has nothing to review.** The workspace asks the learner to approve question banks without showing their content, so the "approval" in "waits for your approval" is in name only (`ui/src/App.tsx:70-85`).
5. **The authoring contract is out of date.** The course guide that authors and the Claude Code drafting subagent read still asks for lessons, `diagnostic` items and `checkpoint` items, and promises that "a skill is mastered only after evidence from three distinct items and an unassisted checkpoint success" and that placement uses diagnostic items (`core/src/content/guide.ts:82-85`; `docs/plugin-guide.md:142-143`). None of that exists since ADR-0008: lessons are validated but never shown. The `hodos-course` skill also sends users to a "Proposed courses" heading, but the workspace calls it "Question banks to review" (`.claude/skills/hodos-course/SKILL.md:25`).
6. **Grading-integrity bugs (fixed here).** Forgeable math forms and the bank-key oracle both worked against G2.
7. **Hard to adopt.** The packages are not on npm, only Linux is tested, it depends on a pre-stable DSH (0.2.x), and there is one learner per install.

### Recommendations, in order

1. **Replace or amend the PRD.** Write a short PRD v0.3, or put a status banner on the PRD, that names the current product. It should say which PRD goals still hold (G2, G3, G4), which are dropped, and success metrics that fit: probe precision, plan quality, rate of malformed questions, rate of wrong keys.
2. **Run real sessions before adding features.** Three topics with a real DeepSeek model, transcripts kept, checked against what Hodos recorded.
3. **Make "mastered" honest.** Require at least three distinct questions (by normalized text), at least one of them validated by a bank or a plugin. Or rename the indicator to something like "tutor checks passed".
4. **Give approval something to look at.** Show the skills, item prompts (keys hidden) and each item's verification in the draft card, or drop approval for tutor-proposed banks.
5. **Update the authoring contract to the question-bank model.** That means the guide, the plugin guide and the `hodos-course` skill: drop or explain the lesson, diagnostic and checkpoint requirements, and fix the "Proposed courses" heading.
6. **Make it installable.** Publish to npm when approved, test macOS, and follow DSH 0.3.

## Tests run

At the working tree of this change, after `pnpm clean` and `pnpm build`:

| Check | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | passed |
| Lint | `pnpm lint` | 0 findings |
| Build | `pnpm build` | passed |
| Unit and integration | `pnpm test` | 254 passed, 2 skipped (the live Stockfish and CPython checks); 242 passed before this change |
| Security subset | `pnpm test:security` | 39 passed (29 before) |
| Browser end-to-end | `vitest run --project e2e` | 13 passed. The 18 DeepSeek Harness tests were skipped: `HODOS_DSH_BIN` is unset because DSH could not be installed here |
| Content checks | `pnpm verify:puzzles`, `pnpm verify:snippets` | not run (no Stockfish; course content unchanged) |

Before merging, run `HODOS_DSH_BIN=… pnpm test:e2e` against DeepSeek Harness 0.2.1-rc.3. The tutor-session change alters the order in which the restriction, guard and tools are set up. In the default `web` profile the resulting tool set is the same, but only the DSH suite shows that in a real host.
