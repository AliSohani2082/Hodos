# ADR-0007: Hodos as a learning harness for any topic, on DeepSeek Harness

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-28 |
| **Amends** | [ADR-0006](0006-hodos-as-dsh-plugin-ecosystem.md) consequences on course delivery; the course-journey flow of the MVP ([report](../reports/2026-10-27-mvp-report.md)) |

## Question

The MVP teaches only from prepared courses: a learner picks a goal, Hodos finds a matching course, and the journey runs over its fixed skills and items. Should Hodos instead teach any topic the learner names, the way [LearnHarness](https://github.com/amosblomqvist/learnharness) does, with the environment plugins as optional ways of asking questions rather than as the only things Hodos can teach?

## Context

The owner's request (2026-10-28): the functionality and process of LearnHarness, built on DeepSeek Harness (DSH) and its plugin system, with a knowledge-graph view in the sidebar. The chess, code and math plugins should complement the core. Each adds interfaces for quizzes between teaching steps, such as a chess position to solve or a small code sandbox, and none of them is needed to learn anything else.

LearnHarness 0.3.8 (AGPL-3.0, read at commit `3dc8847`) works as follows. Its design notes are [`docs/teaching-methodology.md`](https://github.com/amosblomqvist/learnharness/blob/main/docs/teaching-methodology.md), [`docs/probe-teach-split.md`](https://github.com/amosblomqvist/learnharness/blob/main/docs/probe-teach-split.md) and [`docs/architecture.md`](https://github.com/amosblomqvist/learnharness/blob/main/docs/architecture.md).

1. **Probe.** A prober agent asks quiz questions that bracket where the learner's understanding ends on each strand the goal depends on, then concludes with an assessment (`probe_done`).
2. **Plan.** A teacher agent writes a dependency map from the current understanding to the goal as a small mermaid graph, which is validated as a DAG and shown live. Where the lesson stands is derived from which plan node the latest question was about.
3. **Teach.** One reasoning step at a time, as predict → teach → check. Choice questions are graded deterministically; free-recall answers are compared with an answer the teacher committed before asking. The learner can think out loud in a text field. Research, visual explanations and demos run in the background.
4. **Knowledge graph.** A background pipeline extracts propositions and reasoning chains from the teacher's prose. An extractor writes them, an auditor links duplicates, and a deterministic merger is the only writer. The graph is the home view; notes can be imported into it.
5. **Practice.** Problem sets are built from selected parts of the graph, by rung, cue distance and presentation. A model writes each problem with its solution and rubric first, and grades one attempt 0–10. Practice is feedback only: LearnHarness keeps no mastery model and no spaced repetition.

What DSH offers for this ([compatibility report](../dsh-integration/compatibility.md), checked again in 0.2.1-rc.3 for this ADR):

- A tool may wait for the learner, since tool time limits are opt-in. DSH's own `ask_user_question` uses the same pattern and turns a long wait into a "continued" question whose answer later arrives as a message.
- `ctx.llm.prepareCall(...).stream(...)` makes a model call with no tools on the user's default model (`ctx.agentDefaultModel`). DSH's session-title generator does the same, which fits background extraction, generation and grading.
- `sidebarRightTabs.register` may be called more than once, so the knowledge graph can have its own sidebar tab.

## Options considered

| Option | For | Against |
|---|---|---|
| A: Keep course journeys; add a graph view | Small change; keeps every MVP guarantee | Not what was asked: nothing without a course can be learned |
| B: **LearnHarness's process as the core, Hodos's guarantees where they fit** | Any topic; the plugins become optional interfaces; mastery and review can still be offered | A large rewrite of the adapter and the workspace; model-written questions replace verified items in most lessons |
| C: Port LearnHarness itself into DSH | Fastest to "exact" behaviour | Its runtime (Next.js, the pi engine, its own agent loop) does not fit DSH plugins; copying would also bring its code into the MIT SDK boundary |

## Verdict

**Go** on option B. We will reimplement LearnHarness's process as Hodos's core learning flow on DeepSeek Harness. We will keep the MVP's plugin system, sandboxing and mastery estimates, and change their roles:

- **Sessions for any topic.** A learning session is a DSH chat bound to Hodos. Its agent works first as the prober and then as the teacher. Hodos swaps the session's tools and prompt context at the seam: `hodos_quiz`, `hodos_ask` and `hodos_probe_done` while probing; `hodos_plan`, `hodos_quiz` (role `predict` or `check`, tagged with a plan node), `hodos_explain`, `hodos_ask`, `hodos_research` and `hodos_visual` while teaching. Questions are shown in the Hodos workspace; the tool waits for the answer.
- **Answers are graded on the server.** The browser never receives a correct option or a committed answer before the learner answers. Choice questions are graded deterministically. Interface questions are graded by their plugin's grader after the plugin's validator has accepted the item, so a model-written chess position is checked by chess.js before the learner sees it. Free-recall answers go back to the teacher with the committed answer.
- **The knowledge graph and practice** follow LearnHarness's model: propositions and chains, an extractor, an auditor and a deterministic merger, practice sets with named levels and one graded attempt. Background model calls go through `ctx.llm` with no tools, under per-learner budgets.
- **Plugins are interfaces.** An environment plugin contributes exercise kinds that the teacher may use as quiz interfaces (chess position, Python sandbox, math expression), plus renderers for lessons. None is required. Their prepared courses stay installed as **question banks** the teacher can draw verified items from.
- **Code runs in the browser.** The code plugin's sandbox runs Python with Pyodide inside the sandboxed renderer iframe. The result is self-reported, so it gives feedback but never counts as unassisted evidence.
- **Mastery and review are an extra layer** (owner's choice, 2026-10-28). Deterministically graded answers about a plan node update a per-node estimate (BKT-lite) and schedule its review (FSRS). The tutor offers due reviews. Nothing in the LearnHarness process depends on this layer.

## Evidence

- LearnHarness's process and contracts were read from its documentation and source at `3dc8847`. No code is copied: its runtime does not fit DSH, and the MIT SDK must not take in AGPL code.
- DSH 0.2.1-rc.3, as installed for the end-to-end suite:
  - `@deepseek-ai/dsh-tools` applies a tool timeout only when the definition sets `timeoutMs`.
  - `@deepseek-ai/dsh-user-questions` documents the waiting-question pattern.
  - `@deepseek-ai/dsh-session-title-llm` shows the tool-free `ctx.llm` call.
  - `@deepseek-ai/dsh-agent-default-model` exposes `currentSelection()`.

## Consequences

- **Replaced:** the MVP's course journey (course matching, diagnostic, path approval, lessons per course skill, checkpoints per skill) and the tools and workspace screens built for it.
- **Kept:**
  - the plugin registry and trust tiers, the QuickJS sandbox, renderer isolation and the leak guard;
  - the store, the rate limits and the mastery estimators;
  - tutoring-session tool restriction, the `hodos` command and the course inbox (for question banks).
- **Changes in the security model:**
  - Most questions are now model-written. Hodos guarantees that answers are graded deterministically and that keys stay server-side; it cannot guarantee that a model-written question is correct.
  - Interface questions are validated by their plugin; choice questions are checked only for shape. The workspace says when a question was written by the model.
  - Background jobs are new model usage. Each kind of job has a per-learner budget, and jobs run only for sessions bound to Hodos.
- **Not part of this change:** dictation (DSH has no speech-to-text service to reuse), web research beyond what the user's own DSH tools provide, and interactive HTML demos. Demos would need a renderer that runs model-written scripts, which this release does not take on.

## Follow-ups

- [ ] Evaluate tutoring with a real DeepSeek model: prober precision, plan quality, how often questions arrive malformed.
- [ ] Dictation for think-out-loud fields, if DSH gains a speech-to-text service.
- [ ] Interactive demos in a dedicated sandboxed renderer, with a review step before the learner sees them.
