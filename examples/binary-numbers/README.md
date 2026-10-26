# Binary numbers: a sample third-party Hodos plugin

A complete Hodos environment plugin that a third party could publish, written without any Hodos package and without running code in the host. It teaches reading and writing whole numbers (0 to 255) in binary.

It is a **declarative** plugin: Hodos loads it as data. Its JavaScript runs only where Hodos isolates untrusted code, and it never gets the trusted, in-process hooks that the reviewed built-in environments (`@hodos/chess`, `@hodos/language`, `@hodos/math`, `@hodos/code`) use.

| File | What it is | Where it runs |
|---|---|---|
| `hodos-plugin.json` | Manifest, exercise kind (`binary.convert`) with JSON Schemas, guidance and a plain-text template, grader entry, lesson block (`binary-bits`), renderer entry, content pack list | Read as data |
| `grader.js` | `grade(input)` and `validateItem(item)`: plain functions over JSON | Hodos's QuickJS sandbox: a separate process, no filesystem, network, environment or host objects, with CPU, memory and time limits |
| `content/binary-basics.json` | The course: 2 skills, 2 lessons, 14 items | Validated as data (schemas, then `validateItem` in the sandbox) |
| `renderer/` | Place-value boxes, in plain JavaScript that speaks the renderer protocol by hand | A `sandbox="allow-scripts"` iframe with an opaque origin, under the renderer Content-Security-Policy (no network, scripts only from this directory) |

## What it demonstrates

- **Exercise kind as data.** Payload, key and response schemas; the key (`answer`) stays on the server. `fallbackTemplate` (`{{prompt}}`) gives the plain-text view used by the tutor and when no renderer is available.
- **Sandboxed grading.** `grade` names three misconceptions it detects (`reversed-bits`, `read-as-decimal`, `counted-ones`); the course supplies the learner-facing text for each in `misconceptionFeedback`. The grader returns evidence only; Hodos owns mastery, checkpoints and what is released.
- **Sandboxed item checks.** `validateItem` recomputes every conversion, so an item whose key does not match its number is rejected when the course is validated.
- **A lesson block** (`binary-bits`) drawn by the plugin's renderer, with a plain-text template for everyone else.
- **A renderer without the SDK.** `renderer/bits.js` accepts the `MessagePort` only from its parent window, checks the shape of every message before using it, builds the page with DOM APIs and `textContent`, and only displays: the learner answers in the workspace's own form. Renderer authors can use `connectRenderer` from `@hodos/plugin-sdk/renderer` instead.

## Use it in DeepSeek Harness

Install the Hodos bundle (`@hodos/dsh`), then list this directory in the Hodos `pluginDirs` setting, in your profile's `cordis.patch.yml` or in a file you pass with `dsh --patch`:

```yaml
- id: hodos
  config:
    dataDir: !!js dshHomePath('hodos')
    pluginDirs:
      - /absolute/path/to/examples/binary-numbers
```

A DeepSeek Harness patch replaces the whole `config` of the row, so restate `dataDir` and any other Hodos settings you changed. Check the result with `dsh --profile web --patch <file> --dump-config`. Then ask the tutor, for example, "I want to learn binary numbers".

Plugins in `pluginDirs` are never trusted, whatever their manifest says: only the built-in allowlist (`trustedPlugins`) runs in-process code.

## Check it

From the repository root:

```sh
pnpm vitest run --project unit tests/integration/example-plugin.test.ts
pnpm vitest run --project e2e tests/e2e/example-plugin.e2e.test.ts   # the Harness part needs HODOS_DSH_BIN
```

The integration test loads the directory as an untrusted plugin, validates the course with full coverage (item checks run in the sandbox), grades answers, runs a journey through the engine, and replaces `grader.js` with probes: one that finds no `process`, `require` or `fetch` in the sandbox, one that never returns (stopped at the deadline; the attempt is not counted) and one that claims evidence for a skill the item does not have (rejected). The end-to-end test runs the renderer in a browser under the renderer CSP and loads the plugin into a real DeepSeek Harness through `pluginDirs`.

## License

MIT. See [LICENSE](LICENSE).
