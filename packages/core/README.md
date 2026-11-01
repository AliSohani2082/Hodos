# @hodos/core

The host-independent core of Hodos: learning sessions in the style of [LearnHarness](https://github.com/amosblomqvist/learnharness) (probe, plan map, questions graded on the server), the knowledge graph, practice sessions, a per-node mastery layer, the plugin registry with its sandbox, and the course library whose approved courses are question banks. A host supplies identity, the tutor (a model agent), a user interface and a place for the database; today that host is DeepSeek Harness, through [`@hodos/dsh`](../dsh-adapter/README.md). Environment plugins supply question interfaces: exercise kinds, graders, renderers and courses ([plugin guide](../../docs/plugin-guide.md)).

## What is inside

| Part | Source | What it does |
|---|---|---|
| Learning sessions | `src/learn/` | Phases (probe, plan, teach, closed), plan maps (a mermaid subset, checked to be a DAG), questions in three forms (choice, own words, plugin interface) with server-side grading, reports for the tutor, and the per-node mastery layer |
| Knowledge graph | `src/knowledge/` | Propositions and reasoning chains: model replies read and validated, a deterministic merger, views with implication junctions and source clusters, notes import, deletion, a daily budget for model calls |
| Practice | `src/practice/sessions.ts` | Practice sessions: problems with committed solutions, the learner's thinking, conclusions with hint rungs and miss classes |
| Model port | `src/model.ts` | The one interface through which core asks a host for a tool-free model call |
| Mastery | `src/mastery/` | BKT-lite and FSRS-6 review scheduling ([ADR-0005](../../docs/adr/0005-bkt-lite-and-fsrs-defaults.md)), thresholds by strictness |
| Plugins | `src/registry/` | Registration, trust tiers, the QuickJS sandbox for untrusted graders, declarative (data-only) plugins, renderer capabilities |
| Grading boundary | `src/evidence/grade.ts` | Rejects malformed, inconsistent or oversized grader output |
| Projection | `src/projection/student-view.ts` | Decides what of an exercise may leave the server, and scans outgoing text (the tutor's question, grader feedback) for withheld keys |
| Courses | `src/courses/`, `src/content/` | The course library (content packs, drafts and approval, the catalog, learner identity), the question bank over approved courses, course validation, Markdoc lessons, the authoring guide generated from the installed plugins |
| Limits | `src/limits/rate-limiter.ts` | Token buckets for model-written course proposals and drafting delegations |
| Storage | `src/store/` | SQLite through `node:sqlite`, with versioned migrations; repositories share one database |

## Rules core enforces

- Graders return a score. Only `check` and `review` answers graded by a `deterministic`, `engine` or `oracle` grader move a plan node's estimate; no plugin and no tool can set one.
- Keys stay on the server until the learner answers, and the keys of bank exercises never reach the tutor. A question whose text gives its key away is refused; grader feedback that reveals more than the verdict is withheld.
- Plugin code that is not on the host's trust list runs only as sandboxed graders (QuickJS in a separate process, with time and memory limits), never in the host process.
- Model calls go through the host's model port, under a per-learner daily budget.

The [security notes](../../docs/security.md) describe these boundaries and their limits.

## Requirements

Node.js 22.13 or later (`node:sqlite`).

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
