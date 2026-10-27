# Hodos

Learning plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Tell the agent what you want to learn ("Teach me chess tactics. I know the basic rules but struggle with knight forks.") and it becomes your tutor:

1. a short placement finds where you stand;
2. you approve a path of skills;
3. each skill has a lesson, then practice with hints and feedback on your actual mistake, then a checkpoint you pass on your own;
4. spaced review keeps mastered skills fresh.

Hodos, not the model, keeps the record, grades answers, and decides mastery. Grading is deterministic: chess moves by the rules of chess, Python by the program's real output, algebra by evaluating expressions. Answer keys never reach the model or the browser before they are released.

**Status:** version 0.1.0, working with DeepSeek Harness 0.2.1-rc.3 and tested on Linux x64. The packages are not published to npm; install from this repository. See [known limitations](docs/limitations.md).

## What is included

| | |
|---|---|
| **Environments** | Chess tactics on an interactive board, Spanish for English speakers, reading and tracing Python, and algebra with formulas and graphs |
| **Workspace** | A "Hodos learning" tab in DeepSeek Harness's sidebar: mode, lesson, exercise, path and progress |
| **Plugin SDK** | MIT-licensed contracts for writing your own environment, as a DeepSeek Harness bundle or as a declarative plugin that runs no code in the host ([plugin guide](docs/plugin-guide.md), [sample plugin](examples/binary-numbers)) |
| **Course authoring** | Write courses with Claude Code and the `hodos course` command, or have DeepSeek Harness draft them through its Claude Code subagent; every course waits for the learner's approval ([course authoring](docs/course-authoring.md)) |

## Try it

You need Node.js 24.9 or later, pnpm, and DeepSeek Harness 0.2.1-rc.3 or a later 0.2 release with a model configured.

```sh
pnpm install
pnpm build
dsh plugin --profile web add "$PWD/packages/dsh-adapter"
dsh plugin --profile web add "$PWD/packages/environments/chess"
dsh web
```

Then state a goal in the chat and open the **Hodos learning** tab. The [install guide](docs/install.md) covers the other environments, tarball installs, configuration and your data.

To turn chess off but keep it installed, put this row in the profile's patch list, `$DSH_HOME/profiles/web/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`; the file starts as an empty list, `[]`, which the row replaces), and restart:

```yaml
- id: hodos-chess
  disabled: true
```

To uninstall (your learning records in `$DSH_HOME/hodos` stay until you delete them):

```sh
dsh plugin --profile web remove @hodos/chess
dsh plugin --profile web remove @hodos/dsh
```

## Develop

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies (pnpm workspace) |
| `pnpm build` | Compile the packages, the workspace app, the DSH browser half and the renderers |
| `pnpm typecheck` | Type-check Node, browser and test code |
| `pnpm lint` | [oxlint](https://oxc.rs) with type-aware rules; the policy is in [`.oxlintrc.json`](.oxlintrc.json) |
| `pnpm test` | Unit and integration tests, offline and without keys |
| `pnpm test:security` | Only the tests named "security" |
| `pnpm test:e2e` | Builds, then runs the browser tests and the DeepSeek Harness tests; set `HODOS_DSH_BIN` to the `dsh` launcher, or the Harness tests are skipped |
| `pnpm verify:puzzles` | Check the chess puzzles with a UCI engine (`--engine <path>` or `HODOS_STOCKFISH`); `--write` records the result |
| `pnpm verify:snippets` | Run every Python program of the code course under CPython (`HODOS_PYTHON`, default `python3`); `--write` records the result |
| `pnpm pack:dsh` | Build installable tarballs into `dist-packages/` (nothing is published) |
| `pnpm clean` | Remove build output |

Optional environment variables for the tests:

- `HODOS_STOCKFISH` (a Stockfish binary) and `HODOS_PYTHON` (a CPython interpreter) turn on two live checks in `pnpm test`.
- `HODOS_E2E_CLAUDE_CODE=1` adds the Claude Code drafting test to `pnpm test:e2e`. It installs DSH's Claude Code bundle from npm and runs it against a local stand-in for Anthropic's API.
- `HODOS_E2E_SCREENSHOTS=<dir>` saves screenshots of the chess journey.

The end-to-end tests use a scripted model and throwaway Harness homes. They need no API key and do not touch `~/.dsh`.

## Documentation

| Document | |
|---|---|
| [Architecture](docs/architecture.md) | Packages, the runtime picture, a journey step by step, mastery, storage |
| [Install guide](docs/install.md) | Installing into DeepSeek Harness, configuration, data, removal |
| [Security notes](docs/security.md) | Trust boundaries, plugin tiers, the sandbox, answer keys, and what is not covered |
| [Known limitations](docs/limitations.md) | What this release does not do or has not been shown to do |
| [Plugin guide](docs/plugin-guide.md) | Writing an environment plugin |
| [Course authoring](docs/course-authoring.md) | Writing and drafting courses, with Claude Code or in DeepSeek Harness |
| [DSH compatibility report](docs/dsh-integration/compatibility.md) | Every DeepSeek Harness API Hodos uses, and how it was verified |
| [ADRs](docs/adr/README.md) | Architecture decisions |
| [PRD](docs/PRD.md), [threat model](docs/hodos-threat-model.md) | The original product requirements and the threat model of that design |
| [MVP report](docs/reports/2026-10-27-mvp-report.md) | What was built, the decisions, the tests run with their results, defects found, gaps and the next step |

## Licensing

The core, the DSH adapter and the workspace are AGPL-3.0 ([`LICENSE`](LICENSE)). The plugin SDK, the testing kit and the environments are MIT ([`LICENSE-MIT`](LICENSE-MIT)), so plugin authors take on no AGPL obligations. See [`LICENSING.md`](LICENSING.md).
