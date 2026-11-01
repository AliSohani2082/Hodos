# Installing Hodos in DeepSeek Harness

Hodos installs into a DeepSeek Harness (DSH) profile like any other DSH plugin: `@hodos/dsh` provides learning sessions, the knowledge graph, practice and the workspace, and each interface plugin (`@hodos/chess`, `@hodos/code`, `@hodos/math`, `@hodos/language`) is a separate, optional bundle. The packages are not on npm yet, so you install them from a checkout of this repository or from tarballs built from one.

The Hodos commands below were run on Linux x64 with Node.js 24.22.1, pnpm 11.28.5 and DeepSeek Harness 0.2.1-rc.3. Other platforms are untested.

## Requirements

- **Node.js 24.9 or later.**
- **pnpm on your `PATH`.** DeepSeek Harness's `dsh plugin` command runs it, and this repository is a pnpm workspace. Version 11 is tested.
- **DeepSeek Harness 0.2.1-rc.3 or a later 0.2 release**, the `@deepseek-ai/dsh` package from npm (for example `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`; the tests used a copy installed with `npm install --prefix`). The bundles declare `engines.dsh: ">=0.2.1-rc.3 <0.3.0"`, and DSH refuses incompatible plugins at install and at start-up.
- A model for the tutor, configured in DeepSeek Harness as usual (for DeepSeek, `DEEPSEEK_API_KEY`). Hodos itself needs no key: knowledge-graph extraction uses the same default model through DeepSeek Harness.
- Optional: a [Stockfish](https://stockfishchess.org/) binary, if you want the chess grader to accept alternative moves that are as strong as the solution.

## 1. Build Hodos

```sh
git clone https://github.com/AliSohani2082/Hodos.git
cd Hodos
pnpm install
pnpm build
```

## 2. Install the bundles

`dsh plugin` takes absolute paths and needs `--profile`. These examples use the `web` profile, the one `dsh web` starts. Install `@hodos/dsh` first, then the interface plugins you want; learning works without any of them, with multiple-choice and own-words questions only.

**From the checkout** (DSH links the package folders, so a later `pnpm build` updates them):

```sh
dsh plugin --profile web add "$PWD/packages/dsh-adapter"
dsh plugin --profile web add "$PWD/packages/environments/chess"     # chess positions on a board
dsh plugin --profile web add "$PWD/packages/environments/code"      # predict-the-output and a Python sandbox
dsh plugin --profile web add "$PWD/packages/environments/math"      # algebra expressions
dsh plugin --profile web add "$PWD/packages/environments/language"  # Spanish typed answers
```

**From tarballs** (a fixed copy that no longer needs the checkout):

```sh
pnpm pack:dsh
dsh plugin --profile web add "$PWD/dist-packages/hodos-dsh-0.1.0.tgz"
dsh plugin --profile web add "$PWD/dist-packages/hodos-chess-0.1.0.tgz"
```

`pnpm pack:dsh` builds first and prints the `dsh plugin` command for every bundle. Each tarball carries the unpublished `@hodos` packages it needs; their other dependencies come from the npm registry. The profile records the tarball's path. Adding more plugins worked after the tarballs were deleted, but keep them if you may need to reinstall the profile.

## 3. Start and learn

```sh
dsh web
```

Open the address it prints. In a new chat, say what you want to learn, for example:

> I want to learn how knight forks win material

The chat becomes a learning session. Open the **Hodos learning** tab in the right sidebar: the tutor's questions appear there, first to probe what you already understand, then the plan map, then questions between teaching steps. The **Knowledge graph** tab (listed next to it) fills from what the tutor taught; pick propositions there and press **Practise selected** to practise them in a new chat. Sessions are saved in the Hodos database; when you come back to the chat, its tutor gets the session's tools and context again.

## Open it from a phone or another computer

`dsh web` listens on this machine only. To reach it from elsewhere, use `deploy/install.sh` and `deploy/serve.sh` or the Docker setup: [self-hosting](self-hosting.md) covers the choices (a VPN, TLS, a proxy), what to open on the phone, and the security caveats. In short, whoever signs in can run commands as the user that started the Harness.

## Configure

Hodos's settings live in the profile's patch file, `$DSH_HOME/profiles/web/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`). It is a YAML list that starts empty (`[]`); replace that with your rows. A patch row replaces the row's whole `config`, so restate `dataDir`:

```yaml
- id: hodos
  config:
    dataDir: !!js dshHomePath('hodos')
    backgroundCallsPerDay: 20
- id: hodos-chess
  config:
    stockfishPath: /usr/local/bin/stockfish
```

Check the composed result with `dsh --profile web --dump-config`. The [`@hodos/dsh` README](../packages/dsh-adapter/README.md#configuration) lists every setting. To turn a plugin off without removing it, add a row with `disabled: true`, for example `- id: hodos-math` followed by `disabled: true`, or toggle it on DeepSeek Harness's Plugins page.

## Course authoring

Courses are question banks the tutor can ask verified exercises from. To write them with Claude Code or have DeepSeek Harness draft them, see [course authoring](course-authoring.md). The `hodos` command it uses runs from the checkout (`pnpm exec hodos course guide`) or from an installed profile (`$DSH_HOME/profiles/web/node_modules/.bin/hodos course guide`).

## Your data

Learner records live in `$DSH_HOME/hodos/` (a SQLite database and the course inbox): sessions with their questions and answers, the knowledge graph, practice and the mastery estimates. Copy that folder to back them up; delete it to start over. The workspace's export (`/hodos/api/v1/export`) gives the same records as JSON. Removing a plugin does not touch them; a question that needs a removed plugin says so until the plugin is back.

## Remove

```sh
dsh plugin --profile web remove @hodos/chess
dsh plugin --profile web remove @hodos/dsh
```

## Run the end-to-end tests

The end-to-end tests start real DeepSeek Harness instances, with a scripted model in place of DeepSeek, so they need no API key:

```sh
HODOS_DSH_BIN="$(command -v dsh)" pnpm test:e2e
```

They create throwaway Harness homes and never touch `~/.dsh`. `HODOS_E2E_CLAUDE_CODE=1` adds the Claude Code drafting test, which installs DSH's Claude Code bundle from npm and runs it against a local stand-in for Anthropic's API.
