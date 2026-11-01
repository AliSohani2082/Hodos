# @hodos/dsh

Hodos for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a DSH plugin bundle that turns a chat into a learning session in the style of [LearnHarness](https://github.com/amosblomqvist/learnharness). The chat's agent becomes the tutor: it probes what the learner understands, writes a plan map, and teaches one step at a time with questions that Hodos shows and grades. Hodos keeps the session, builds a knowledge graph from what was taught, runs practice sessions, and keeps a mastery estimate per plan node.

What it adds to a DSH profile:

- **Global tools**: `hodos_start_learning`, `hodos_start_practice`, `hodos_list_courses`, `hodos_propose_course`, and `hodos_draft_course` when DSH's subagents are available (never inside a Hodos session).
- **Session tools by phase**, given to the chat's agent only while its chat is in that phase: probe (`hodos_probe`, `hodos_recall`, `hodos_probe_exercise`, `hodos_bank`, `hodos_probe_done`), teach (`hodos_plan`, `hodos_quiz`, `hodos_explain`, `hodos_exercise`, `hodos_bank`) and practice (`hodos_problem`, `hodos_conclude`). A question tool ends the tutor's turn; the graded answer arrives as its next message. No tool takes a session or learner id from the model.
- **The prompt**: a short section on when to start a session, and per-session context with the phase's instructions and the session's state.
- **Two sidebar tabs**: "Hodos learning" (the session: plan map, questions, practice) and "Knowledge graph", both served at `/hodos/app/` behind DSH's own sign-in.
- **Knowledge-graph extraction** through DSH's `llm` service on the user's default model, with no tools, under a daily budget.
- **Storage**: a SQLite database under `$DSH_HOME/hodos`.
- **The `hodos` command** for course authoring outside DSH (see [course authoring](../../docs/course-authoring.md)).

It teaches any topic by itself, with multiple-choice and own-words questions. Interface plugins add more ways of asking: [`@hodos/chess`](../environments/chess/README.md), [`@hodos/code`](../environments/code/README.md), [`@hodos/math`](../environments/math/README.md), [`@hodos/language`](../environments/language/README.md).

## Install

DeepSeek Harness 0.2.1-rc.3 or a later 0.2 release, and Node.js 24.9 or later. Paths given to `dsh plugin add` must be absolute.

From a checkout of this repository:

```sh
pnpm install
pnpm build
dsh plugin --profile web add "$PWD/packages/dsh-adapter"
dsh plugin --profile web add "$PWD/packages/environments/chess"
dsh web
```

From tarballs (`pnpm pack:dsh` writes them to `dist-packages/`; they carry the unpublished `@hodos` packages they need):

```sh
dsh plugin --profile web add /absolute/path/to/hodos-dsh-0.1.0.tgz
dsh plugin --profile web add /absolute/path/to/hodos-chess-0.1.0.tgz
```

Then tell the agent what you want to learn, for example: "I want to learn how knight forks win material", and open the "Hodos learning" tab. The [install guide](../../docs/install.md) has the details, including removal.

## Configuration

Defaults come from this bundle's `cordis.patch.yml`. Override them in the profile's own patch file, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A patch row replaces the row's whole `config`, so restate `dataDir`:

```yaml
- id: hodos
  config:
    dataDir: !!js dshHomePath('hodos')
    backgroundCallsPerDay: 20
```

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `dshHomePath('hodos')` | Directory of the Hodos database (learning records) and the course inbox |
| `trustedPlugins` | the four built-in plugins | Plugins whose graders and validators run in-process, and which may be granted the `run-code` renderer capability. Any other plugin must ship sandboxed graders |
| `pluginDirs` | `[]` | Directories of declarative plugins (`hodos-plugin.json`), loaded as data |
| `tutorTools` | `restricted` | `restricted`: a chat that is a Hodos session keeps only Hodos's tools and DSH's `ask_user_question` (no shell, files or network); `unrestricted` keeps the chat's other tools |
| `backgroundCallsPerDay` | `60` | Model calls for knowledge-graph extraction per learner per 24 hours; `0` turns extraction off |
| `delegateProvider` | `''` | DSH subagent provider for drafting courses, for example `claude-code`; empty picks the first provider with structured output |
| `courseInbox` | `true` | Import course files from `<dataDir>/inbox` (written by `hodos course submit`) as drafts awaiting the learner's approval |
| `strictness` | `standard` | Threshold at which a plan node counts as mastered: `lenient` (0.90), `standard` (0.95) or `strict` (0.98) |

## Security

The tutor's authority comes from DSH's session identity, not from tool arguments. Answer keys never reach the browser before the answer, and the keys of question-bank exercises never reach the model. Untrusted plugins run only as sandboxed graders and sandboxed renderers. Read the [security notes](../../docs/security.md) for the boundaries and what they do not cover.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
