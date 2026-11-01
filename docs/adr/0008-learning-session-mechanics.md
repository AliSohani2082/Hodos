# ADR-0008: How learning sessions run on DeepSeek Harness

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-27 |
| **Amends** | [ADR-0007](0007-learning-harness-on-dsh.md): the question round trip, the tool set, practice, and what is kept of the course-journey engine |

## Question

ADR-0007 decided to rebuild Hodos around LearnHarness's process. Building it settled four things ADR-0007 described differently or left open: how a question gets its answer back to the tutor, which tools each phase has, how practice works, and what happens to the course-journey engine. This ADR records them.

## Context

- ADR-0007 planned question tools that **wait** for the learner's answer inside the tool call, as DSH's own `ask_user_question` does.
- It described LearnHarness's practice as **problem sets** built from the graph, with one attempt graded 0–10. Reading LearnHarness 0.3.8 further (`3dc8847`), its practice runs as **sessions**: a tutor poses one problem at a time on chosen propositions, the learner's work arrives as messages, hints escalate by rung, and the tutor concludes each problem with a verdict and its committed solution.
- After the adapter moved to learning sessions, the course-journey API of `@hodos/core` (diagnostic, path approval, lessons, practice selection, checkpoints) was reachable only from tests.

## Options considered

**The question round trip**

| Option | For | Against |
|---|---|---|
| A: The tool waits for the answer | One tool call per question; the model sees the answer as the tool result | A tool call held open for minutes or hours; DSH turns long waits into a "continued" question, and a restart in between loses the call |
| B: **The tool stores the question and ends the turn; the answer arrives as the next user message** | Nothing waits; the answer survives restarts (held in the database and delivered when the chat's agent exists); the learner can still chat meanwhile | Two model messages per question; the answer message must be clearly marked as coming from Hodos |

**The course-journey engine**

| Option | For | Against |
|---|---|---|
| A: Keep it beside learning sessions | No deletions | About 3,600 lines of source that no host calls, and a second learning model to keep secure and documented |
| B: **Remove it; keep courses as question banks** | One learning flow; smaller core | Course lessons become unused data; journey tests go |

## Verdict

**Go** on option B for both.

- **Questions end the turn.** A question tool stores the question and calls DSH's `exec.concludeTurn()`. When the learner answers in the panel, Hodos grades it and delivers the result with `agent.followup(createUserMessage(…))`, marked with a `hodos` message source. If the chat's agent is not running, the message is held and delivered on `agent/created`.
- **Tools by phase**, offered to the chat's agent only while it is in that phase:
  - probe: `hodos_probe` (choice), `hodos_recall` (own words), `hodos_probe_exercise` (an installed interface), `hodos_bank`, `hodos_probe_done`;
  - teach: `hodos_plan`, `hodos_quiz`, `hodos_explain`, `hodos_exercise`, `hodos_bank`;
  - practice: `hodos_problem`, `hodos_conclude`.
  `hodos_bank` and the exercise tools are offered only when an interface plugin is installed. The `hodos_research` and `hodos_visual` tools named in ADR-0007 were not built.
- **Practice is a tutor-run session** in its own chat, started from picked propositions in the knowledge-graph tab or with `hodos_start_practice`. The tutor commits a solution before posing a problem, gives hints on a ladder from R0 to R5, and concludes with an outcome, a verdict, the highest rung needed and the kind of miss. Practice never moves mastery estimates.
- **The course-journey engine is removed.** A small course library keeps learner identity, content packs, the catalog, drafts with their approval, the proposal and delegation budgets, and the authoring guide. Approved courses are question banks. The per-skill estimators that only journeys used (Elo, the oracle estimator, per-skill state) go; BKT-lite and FSRS stay for the per-node mastery layer.

## Evidence

- The round trip, phase tool swaps, restricted tools, the chess board, the Python sandbox, extraction through `ctx.llm` and a practice session in a new chat run in `tests/e2e/dsh-learning.e2e.test.ts` against DeepSeek Harness 0.2.1-rc.3, with a scripted model.
- Holding an answer while the chat's agent is gone and delivering it on `agent/created` is covered by `packages/dsh-adapter/tests/adapter.test.ts` with DSH's event shapes, not end to end.
- DeepSeek Harness merges the result of the tool that ended a turn with the next follow-up into one model message; the scripted model reads the Hodos lines of that message first. A real model sees the same message.

## Consequences

- A learner can type in the chat while a question is open. The tutor's instructions say that the graded answer arrives as the next message; whether a real model waits for it is not measured.
- Each answered question costs one model turn, which is the cost of the process, not an extra.
- Course lessons are validated but not shown. Plugins that ship lesson blocks keep them for courses; the tutor does not use them yet.
- The v1 database tables of journeys stay in the schema so that existing databases migrate without losing data; nothing reads them.

## Follow-ups

- [ ] Measure with a real DeepSeek model how often it answers the learner in the chat instead of waiting for the panel.
- [ ] Decide whether the tutor should be able to show a course's lesson blocks, or whether lessons leave the course format.
