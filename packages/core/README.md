# @hodos/core

The host-independent engine of Hodos. It decides what a learner does next and when a skill counts as mastered. A host supplies identity, a user interface and a place for the database; today that host is DeepSeek Harness, through [`@hodos/dsh`](../dsh-adapter/README.md). Environment plugins supply exercise kinds, graders, lesson blocks, renderers and courses ([plugin guide](../../docs/plugin-guide.md)).

## What is inside

| Part | Source | What it does |
|---|---|---|
| Learning protocol | `src/protocol/journey.ts` | A pure state machine: goal → diagnostic → planning → per skill teach → practice → checkpoint (pass: next skill; fail: remedial, then practice again) → complete, then spaced review |
| Skill graph | `src/graph/` | Prerequisites, confusable skills, path planning |
| Mastery | `src/mastery/` | BKT-lite for concepts and procedures, Elo-style estimates for patterns, a Beta estimate for oracle-graded performance skills, FSRS-6 review scheduling ([ADR-0005](../../docs/adr/0005-bkt-lite-and-fsrs-defaults.md)) |
| Placement | `src/diagnostic/` | An adaptive diagnostic over the prerequisite graph |
| Tutor policy | `src/tutor/policy.ts` | Hint pacing and per-mode rules (checkpoints are unassisted). Plugins cannot loosen them |
| Practice | `src/practice/select.ts` | Item selection: target success rate, scaffolding, no immediate repeats, fresh checkpoint items |
| Plugins | `src/registry/` | Registration, trust tiers, the QuickJS sandbox for untrusted graders, declarative (data-only) plugins |
| Grading boundary | `src/evidence/grade.ts` | Rejects malformed, inconsistent or oversized grader output |
| Content | `src/content/` | Course validation, Markdoc lessons, the authoring guide generated from the installed plugins |
| Projection | `src/projection/student-view.ts` | Decides what of an exercise may leave the server, and scans outgoing payloads for withheld answers |
| Limits | `src/limits/rate-limiter.ts` | Token buckets for hints, tutor notices, generation, code runs and delegations |
| Storage | `src/store/` | SQLite through `node:sqlite`, with versioned migrations |
| Engine | `src/engine/` | The API hosts call |

## Rules the engine enforces

- Graders return evidence. Only the engine updates mastery; no plugin can set a mastery probability, skip a checkpoint or mark a skill mastered.
- Answer keys, checkpoint pools and private test data stay on the server. Grader feedback and errors are checked for leaked keys before they reach the learner or the model.
- Plugin code that is not on the host's trust list runs only as sandboxed graders (QuickJS in a separate process, with time and memory limits), never in the host process.

The [security notes](../../docs/security.md) describe these boundaries and their limits.

## Requirements

Node.js 22.13 or later (`node:sqlite`).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
