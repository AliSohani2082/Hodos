# @hodos/dsh

Hodos for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a DSH plugin bundle that turns a chat session into a tutored learning journey. The DSH agent becomes the tutor; Hodos keeps the learning state, chooses exercises, grades through environment plugins and decides mastery.

What it adds to a DSH profile:

- **Tutor tools** (`hodos_start_learning`, `hodos_next_exercise`, `hodos_submit_answer`, `hodos_hint`, `hodos_progress`, …). A tool acts for the learner bound to the calling session; no tool takes a learner id from the model.
- **A system-prompt section** with the tutoring rules, and per-session learner context.
- **The "Hodos learning" sidebar tab**: the workspace (lesson, exercise, path, progress) at `/hodos/app/`, behind DSH's own sign-in.
- **Storage**: a SQLite database under `$DSH_HOME/hodos`.
- **The `hodos` command** for course authoring outside DSH (see [course authoring](../../docs/course-authoring.md)).

It teaches nothing by itself: install at least one environment ([`@hodos/chess`](../environments/chess/README.md), [`@hodos/language`](../environments/language/README.md), [`@hodos/code`](../environments/code/README.md), [`@hodos/math`](../environments/math/README.md)).

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

Then ask the agent, for example: "Teach me chess tactics. I know the basic rules but struggle with knight forks." The [install guide](../../docs/install.md) has the details, including removal.

## Configuration

Defaults come from this bundle's `cordis.patch.yml`. Override them in the profile's own patch file, `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A patch row replaces the row's whole `config`, so restate `dataDir`:

```yaml
- id: hodos
  config:
    dataDir: !!js dshHomePath('hodos')
    notices: proactive
```

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `dshHomePath('hodos')` | Directory of the Hodos database (learning records) and the course inbox |
| `trustedPlugins` | the four built-in environments | Environment plugins whose graders and validators run in-process. Any other plugin must ship sandboxed graders |
| `pluginDirs` | `[]` | Directories of declarative environment plugins (`hodos-plugin.json`), loaded as data |
| `tutorTools` | `restricted` | `restricted` hides the session's other tools (shell, files, network) once it is bound to a learning journey; `unrestricted` keeps them |
| `notices` | `quiet` | How the tutor hears about workspace activity: `quiet` adds context to its next turn (no extra model calls), `proactive` also wakes it for checkpoint results and stuck learners (rate-limited), `off` |
| `delegateProvider` | `''` | DSH subagent provider for drafting courses, for example `claude-code`; empty picks the first provider with structured output |
| `courseInbox` | `true` | Import course files from `<dataDir>/inbox` (written by `hodos course submit`) as drafts awaiting the learner's approval |
| `strictness` | `standard` | Mastery gate: `lenient`, `standard` or `strict` |

## Security

The tutor's authority comes from DSH's session identity, not from tool arguments. Answer keys never reach the model or the browser before they are released. Untrusted plugins run only as sandboxed graders and sandboxed renderers. Read the [security notes](../../docs/security.md) for the boundaries and what they do not cover.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
