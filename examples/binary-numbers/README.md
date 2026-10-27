# Binary numbers: a sample third-party Hodos plugin

A complete Hodos environment plugin that a third party could publish, written without any Hodos package and without running code in the host. It adds a question interface for converting whole numbers (0 to 255) between binary and decimal, and a course whose exercises become a question bank.

It is a **declarative** plugin: Hodos loads it as data. Its JavaScript runs only where Hodos isolates untrusted code, and it never gets the trusted, in-process hooks that the reviewed built-in environments (`@hodos/chess`, `@hodos/language`, `@hodos/math`, `@hodos/code`) use.

| File | What it is | Where it runs |
|---|---|---|
| `hodos-plugin.json` | Manifest, exercise kind (`binary.convert`) with JSON Schemas, guidance and a plain-text template, grader entry, lesson block (`binary-bits`), renderer entry, content pack list | Read as data |
| `grader.js` | `grade(input)` and `validateItem(item)`: plain functions over JSON | Hodos's QuickJS sandbox: a separate process, no filesystem, network, environment or host objects, with CPU, memory and time limits |
| `content/binary-basics.json` | The course: 2 skills, 2 lessons, 14 items | Validated as data (schemas, then `validateItem` in the sandbox) |
| `renderer/` | Place-value boxes, in plain JavaScript that speaks the renderer protocol by hand | A `sandbox="allow-scripts"` iframe with an opaque origin, under the renderer Content-Security-Policy (no network, scripts only from this directory) |

## What it demonstrates

- **Exercise kind as data.** Payload, key and response schemas; the key (`answer`) stays on the server. `fallbackTemplate` (`{{prompt}}`) gives the plain-text view used by the tutor and when no renderer is available. Its `guidance` goes into the tutor's exercise tool.
- **Sandboxed grading.** `grade` names three misconceptions it detects (`reversed-bits`, `read-as-decimal`, `counted-ones`); the course supplies the learner-facing text for each in `misconceptionFeedback`, released with the verdict when the tutor asked the item from the bank. The grader returns a score only; Hodos decides what it counts for and what is released.
- **Sandboxed item checks.** `validateItem` recomputes every conversion, so an item whose key does not match its number is rejected when the course is validated, and a conversion the tutor writes is rejected before the learner sees it.
- **A lesson block** (`binary-bits`) drawn by the plugin's renderer, with a plain-text template for everyone else. Learning sessions do not show course lessons yet.
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

A DeepSeek Harness patch replaces the whole `config` of the row, so restate `dataDir` and any other Hodos settings you changed. Check the result with `dsh --profile web --patch <file> --dump-config`. Then ask the tutor, for example, "I want to learn binary numbers". The tutor can list the course's exercises with `hodos_bank` and ask them; the panel draws the place-value boxes and takes your answer.

Plugins in `pluginDirs` are never trusted, whatever their manifest says: only the built-in allowlist (`trustedPlugins`) runs in-process code.

## Check it

From the repository root:

```sh
pnpm vitest run --project unit tests/integration/example-plugin.test.ts
pnpm vitest run --project e2e tests/e2e/example-plugin.e2e.test.ts   # the Harness part needs HODOS_DSH_BIN
```

The integration test loads the directory as an untrusted plugin, validates the course with full coverage (item checks run in the sandbox), grades answers, asks bank items through a learning session (a misconception's explanation is released; feedback that quotes a withheld key is not), and replaces `grader.js` with probes: one that finds no `process`, `require` or `fetch` in the sandbox, one that never returns (stopped at the deadline; the answer is not graded) and one that claims evidence for a skill the item does not have (rejected). The end-to-end test runs the renderer in a browser under the renderer CSP, and in a real DeepSeek Harness loads the plugin through `pluginDirs`, has the tutor list and ask a bank exercise, and answers it in the panel.

## License

MIT. See [LICENSE](LICENSE).
