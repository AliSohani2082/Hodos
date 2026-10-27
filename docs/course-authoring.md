# Course authoring

Hodos teaches from courses: a skill graph, one lesson per skill and exercise items with server-side answer keys. A course reaches learners in one of three ways, and every way ends the same: Hodos validates it against the installed environments, and a course that did not ship with a reviewed plugin stays a **draft** until the learner approves it in the Hodos workspace.

| Way in | Who writes it | How it reaches Hodos |
|---|---|---|
| Shipped content pack | Plugin authors (for example the chess tactics course) | Registered with its environment plugin |
| Course inbox | You, or Claude Code with the `hodos-course` skill | `hodos course submit` places a file in `<dataDir>/inbox`; the running service imports it as a draft |
| Drafting in DeepSeek Harness | The tutor agent (`hodos_propose_course`), or a subagent (`hodos_draft_course`) from a chat that is not running a learning journey | Proposed through the Hodos tools; stored as a draft |

Hodos sets the provenance of every proposed item itself (`generated` or `imported`); a "verified" claim inside a proposal is dropped. The workspace says that proposed content is not independently verified.

## Writing a course with Claude Code

The repository includes a Claude Code skill, [`.claude/skills/hodos-course`](../.claude/skills/hodos-course/SKILL.md). Open Claude Code in the Hodos checkout and ask, for example, "make a Hodos course on Spanish greetings for a beginner". The skill has Claude Code:

1. read the authoring guide: `pnpm exec hodos course guide` (generated from the installed environments: exercise kinds with their schemas and a valid example, lesson tags, coverage rules);
2. write `courses/<id>.json`;
3. run `pnpm exec hodos course validate courses/<id>.json` until it reports no errors;
4. submit it: `pnpm exec hodos course submit courses/<id>.json`;
5. confirm the import: `pnpm exec hodos course status`.

You then review the course under **Proposed courses** in the Hodos workspace and approve or reject it.

Claude Code does the writing under its own sign-in, as in any other Claude Code session. Hodos makes no model calls on this path and never handles Claude credentials: it only reads the JSON file you submitted.

## Drafting in DeepSeek Harness with Claude

DeepSeek Harness ships an optional bundle, **Claude Code subagent** (`@deepseek-ai/dsh-subagent-claude-code`). It runs the unmodified Claude Code binary through Anthropic's Agent SDK as a DSH subagent provider named `claude-code`. Per its README, it uses Claude Code's native settings and authentication, and it does not copy, filter, create or modify login state. Hodos's `hodos_draft_course` tool can use it.

1. Enable **Claude Code subagent** on the DeepSeek Harness Plugins page (or install the bundle with `dsh plugin add`), then restart if the installer asks.
2. Sign in to Claude Code on the same machine, through Claude Code's own sign-in flow. You can use your own Claude subscription or an Anthropic API key, as described below.
3. Point Hodos at the provider, either in your profile's `cordis.patch.yml` or in a file you pass with `dsh --patch`:

   ```yaml
   - id: hodos
     config:
       dataDir: !!js dshHomePath('hodos')
       delegateProvider: claude-code
   ```

   A DeepSeek Harness patch replaces the whole `config` of the row; it does not merge into it. So restate `dataDir` and any other Hodos settings you changed. Check the result with `dsh --profile web --patch <file> --dump-config`.

   With an empty `delegateProvider`, Hodos uses the first provider DeepSeek Harness lists.
4. In a chat that is not running a learning journey, ask for a course on a topic that no installed course covers. The agent calls `hodos_draft_course`. The subagent receives the authoring guide and answers with a course. Hodos validates it and keeps it as a draft for you to approve.

   A chat that is running a journey cannot draft: under the default `tutorTools: restricted`, a tutoring session keeps only Hodos's own tools and may not start subagents, since a subagent can have shell, file and network tools. The tutor can still write a course itself with `hodos_propose_course`.

Each delegation spends one unit of a small per-learner budget: three per day by default. Keep the provider's default `permissionMode` (`dontAsk`). The drafting task needs no tools, so do not use `bypassPermissions` for it.

### Which sign-in to use

Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page sets the boundaries:

> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code …

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) adds:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.

The same page says that advertised Pro and Max usage limits "assume ordinary, individual usage of Claude Code and the Agent SDK".

What follows from these:

- **Hodos never touches Claude credentials.** It has no Claude login, and it reads, copies, stores and forwards no tokens. Whatever Claude Code is signed in with stays inside Claude Code.
- **Signing in to Claude Code with your own subscription** for your own learning is the end-user case the legal page describes. The Agent SDK note is directed at developers who build products on the SDK; whether it constrains DeepSeek's bundle is between DeepSeek and Anthropic. If you want no ambiguity, use an API key.
- **An Anthropic API key** from [Claude Console](https://platform.claude.com/) is the method Anthropic recommends for anything built on the Agent SDK. The bundle removes credential-shaped variables from the environment it inherits, so a key meant for Claude Code has to go in the provider's `env` setting (see its README). Keep that configuration out of version control.
- **Do not share one sign-in** with other people through a Harness you host: that is routing requests through plan credentials on behalf of others.

What is tested:

- **Unit test** (`packages/dsh-adapter/tests/adapter.test.ts`): a fake provider named `claude-code`. It checks that the configured provider is used, that the prompt carries the authoring guide, and that the result is stored as a draft with `generated` provenance.
- **End-to-end test** (`tests/e2e/dsh-claude-drafting.e2e.test.ts`, opt-in with `HODOS_E2E_CLAUDE_CODE=1`): a real DeepSeek Harness 0.2.1-rc.3 with the real `@deepseek-ai/dsh-subagent-claude-code` bundle installed from npm.
  1. The agent of a chat with no learning journey calls `hodos_draft_course`.
  2. DSH runs the bundled Claude Code binary.
  3. Claude Code calls a local stand-in for Anthropic's API, configured through the provider's `env` with a dummy key.
  4. The answer becomes a draft in the workspace.

  The test runs Claude Code with a throwaway HOME, so no sign-in on the machine is visible to it, and it asserts that only the dummy key was sent.

Neither test exercises a real Claude sign-in or Anthropic's servers. That last step happens on your machine with your own sign-in.

## The course inbox

- **Location**: `<dataDir>/inbox`. The data directory defaults to `$DSH_HOME/hodos`, falling back to `~/.dsh/hodos`.
- **What it reads**: files named `*.json` of at most 2 MB. Symbolic links are not followed. Files being written (`*.tmp`) and other names are left alone. `hodos course submit` writes a temporary file and renames it, so the service never reads half a file.
- **Timing**: the service checks the inbox at start and every 3 seconds, handling at most 10 files per check.
- **Outcome**: an imported file moves to `inbox/imported/`. A rejected file moves to `inbox/rejected/` with a `<file>.errors.txt` report listing the validation errors; `hodos course status` shows them.
- **Approval**: an imported course is a draft. Only the learner, in the workspace, can approve it; the tutor agent cannot.
- **Budget**: imports do not use the model-proposal rate limit, because they make no model calls and need a local file.
- **Turning it off**: set `courseInbox: false` in the Hodos bundle configuration.

## `hodos course` reference

| Command | Does | Exit code |
|---|---|---|
| `hodos course guide [--no-schemas]` | Prints the authoring guide for the installed environments | 0 |
| `hodos course validate FILE` | Validates the file. Practice and checkpoint coverage are required, as for shipped content | 0 when it has no errors, 1 otherwise |
| `hodos course submit FILE [--data-dir DIR]` | Validates, then places the file in the inbox | 0 when submitted, 1 when it has errors |
| `hodos course status [--data-dir DIR]` | Lists waiting, imported and rejected files, with the errors | 0 |

`--plugin-dir DIR` (repeatable) adds a declarative environment plugin, loaded as data with sandboxed graders. The CLI loads the installed built-in environment packages (`@hodos/chess` and the others), with the same trust rule as the host. It works on local files only: it uses no network, no credentials and no model.

## What validation checks

- **Structure**: every field of the course format, skill ids, a prerequisite graph without cycles, and that the goal is reachable.
- **Lessons**: each lesson parses as Markdoc with only core tags and installed blocks. Block attributes are checked against their schemas, and there is no HTML and no scripts.
- **Items**: payloads, keys and hints are checked against the kind's schemas, plus the environment's own checks. For chess, chess.js checks that the position is legal, the solution line is legal, and the key move does what the goal or theme says (mate, check, a free capture, two pieces attacked, a pin or skewer line).
- **Coverage**: at least 3 practice items and enough checkpoint items for every skill.

Validation cannot check that a fact, a translation or a "best move" is right beyond those checks. For chess, `pnpm verify:puzzles` runs Stockfish over the shipped puzzle set; proposed courses get no engine check. Review a draft before you approve it.
