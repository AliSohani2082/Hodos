# Writing a Hodos environment plugin

An environment plugin teaches in one domain: chess, a language, algebra, code. It brings the exercise formats, the graders that check answers, the lesson blocks and the screens that draw positions, formulas or programs, and usually a course. Hodos brings everything that decides what a learner knows: the learner model, mastery gates, checkpoints, spaced review, the tutor's tools, and what may be shown when.

The contracts live in [`@hodos/plugin-sdk`](../packages/plugin-sdk) (MIT). The four built-in environments are complete examples written against them: [`@hodos/chess`](../packages/environments/chess), [`@hodos/language`](../packages/environments/language), [`@hodos/math`](../packages/environments/math) and [`@hodos/code`](../packages/environments/code). [`examples/binary-numbers`](../examples/binary-numbers) is a third-party plugin in the declarative format, with no host code at all.

## What a plugin contributes

Everything a plugin registers must be declared in its manifest's `capabilities`; anything else is rejected, and registration is all or nothing.

| Contribution | Contract | Example |
|---|---|---|
| Environment ids | `capabilities.environments` | `chess.board`, `code.listing` |
| Exercise kinds | `ExerciseKindSpec` | `chess.puzzle`, `code.predict` |
| Graders | `GraderSpec` | `chess.grader` (engine), `math.grader` (deterministic) |
| Lesson blocks | `LessonBlockSpec` | `chess-position`, `code-snippet` |
| Pedagogy presets | `PedagogyPreset` | `strategy@1`, `math-practice@1` |
| Renderers | `RendererSpec` | `chess-board`, `code-view` |
| Content packs | `ContentPack` (courses) | `chess-tactics`, `python-basics` |
| Content generators (experimental) | `ContentGeneratorSpec` | none ship |

What a plugin can never do, in any tier:

- read or write learner state, or learn who the learner is;
- set a mastery estimate, open a mastery gate, mark a skill mastered or skip a checkpoint: a grader returns evidence, and the platform's estimators, gates and checkpoint policy decide;
- release an answer key, hint or explanation: the platform decides what is released and when;
- call a model or start a tutor turn.

## Trust tiers

| Tier | What it is | What Hodos runs |
|---|---|---|
| **Built-in** | A package whose manifest id is in the host's `trustedPlugins` setting. The default list is the four reviewed built-ins: `hodos-chess`, `hodos-language`, `hodos-code`, `hodos-math`. | Its in-process hooks: `grade` and `step`, `validateItem`, `fallbackText`, `reveal`, block `validate`. Each call has a deadline (5 s by default) and its output is validated. |
| **Declarative** | A directory with a `hodos-plugin.json`, listed in the host's `pluginDirs`. | Nothing in-process. The description is read as data; graders and item checks run in the QuickJS sandbox; renderers run in sandboxed iframes; plain-text views come from templates. |
| **Other code** | Any other package that registers through `createCordisEntry` or the host API. | None of its hooks. Its graders must ship sandboxed sources; its plain-text views are generic; it gets no `reveal`. |

A DeepSeek Harness bundle is code that DeepSeek Harness itself loads into its process when the bundle is enabled. Hodos cannot sandbox that, so installing a third-party bundle means trusting it as you would trust any DeepSeek Harness plugin. The "other code" tier only stops Hodos from calling its hooks. **For a plugin you do not trust, use the declarative format**, which never runs plugin code in the host.

### The QuickJS sandbox

Sandboxed sources (`GraderSpec.sandbox.source`, or the `sandbox` file of a declarative grader) run in a QuickJS interpreter in a separate worker process. There is no filesystem, network, environment, timer or host object. The limits per call are 1 s of CPU, 1.5 s wall time and a 48 MiB heap, and results are capped at 256 KiB. A source defines global functions that take and return JSON:

```js
function grade(input) { /* → GradeResult */ }
function step(input) { /* → StepResult, for stepwise kinds */ }
function validateItem(item) { /* → [{ severity, code, message }] */ }
```

A hook that throws, runs out of time or returns something malformed fails closed: the attempt is not counted, the learner sees a fixed message, and the details go to the server log only (they may quote the answer key).

## Exercise kinds

An exercise item has an envelope the platform owns (id, skills and weights, difficulty, modes, hints, explanation, misconception feedback, provenance) and a body the plugin owns:

- `payload`: what the learner sees, validated against `payloadSchema`;
- `key`: the answer, validated against `keySchema`, **server-only**: it is never sent to a browser, a renderer or the model;
- the learner's response, validated against `responseSchema` before any grader sees it.

Mark payload fields that must stay on the server with `"x-visibility": "server"` in the schema; they are removed from the student view.

Other fields of `ExerciseKindSpec`:

| Field | Meaning |
|---|---|
| `environment` | The environment (renderer family) that presents it. |
| `responseKind` | `choice`, `text` (one line), `lines` (several lines, e.g. a program's output), `moves`, `code`, `number`, `expression` or `structured`. The workspace's own answer form uses it when the renderer does not collect the answer. |
| `interaction` | `single` (one answer) or `stepwise` (the server holds progress, e.g. a chess line with replies). |
| `format.guessable` | Multiple-choice and similar formats are guessable: a skill then needs three unassisted checkpoint successes instead of one. |
| `guidance` | `when` to use the kind, `rules` beyond the schemas, and one valid `example`. It goes into the authoring guide that course authors (people, Claude Code, a subagent) read. |
| `validateItem` | Semantic checks beyond the schemas: a legal chess position, a key consistent with the prompt. Built-ins only; others put `validateItem` in the sandboxed source. |
| `fallbackText` | The prompt as plain text: used by the tutor and when no renderer is available. It must not reveal the key. Declarative plugins use `fallbackTemplate` with `{{field}}` placeholders. |
| `reveal` | What a renderer may show once the platform releases the answer (a solution line, a program's output). Built-ins only. |

## Graders

A grader returns a `GradeResult`: `score` in [0, 1], `correct`, per-skill `skillEvidence` (only skills the item is tagged with; the host fills missing ones with the score), the `misconceptions` it detected, optional `feedback`, and `details` that are stored but never shown raw.

Rules the host enforces:

- **Feedback must not reveal the key.** Feedback is ignored in checkpoint and diagnostic modes, and in practice it is scanned for answer-key fragments (and for hints, explanations and misconception texts that are not released yet) before it is released. Write feedback that says *where* an answer goes wrong, not what the answer is.
- **Misconception feedback comes from the item**, keyed by the ids the grader reports, so course authors control the wording.
- **`method`** says how the grader decides: `deterministic`, `oracle` (compares with a reference, e.g. by running code in an isolated runner), `engine` (a chess engine) or `ai-rubric`. AI-rubric results are advisory: they inform estimates but never count as a checkpoint success.
- **Only first attempts are evidence of mastery**; retries, hints and tutor help count as assisted.

For code-writing exercises, Hodos never runs learner code in the host process. `@hodos/code` defines a `CodeRunner` contract (ADR-0004, tier 1: the runner receives the source and the inputs only; outputs are compared in Hodos) and offers `code.write` only when a host supplies such a runner. No runner ships.

## Lesson blocks

Lessons are [Markdoc](https://markdoc.dev) text. Core blocks are `step`, `callout`, `worked-example` and `check`; a plugin adds tags with an attribute schema, guidance (`when`, one `syntax` example, `rules`), an optional `validate` (built-ins only), a required `fallbackText` (declarative: `fallbackTemplate`), and optionally the `renderer` that draws it. Lessons are data: Markdoc variables and functions are rejected, raw HTML stays inert text, images are not allowed (use a block), and only http(s), mailto and in-page links survive. Attributes marked `x-visibility: server` (a check's answer) are removed before a lesson reaches the browser.

## Renderers

A renderer is a directory of static files. The host serves it under its own path with this Content-Security-Policy:

```
sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'none';
frame-ancestors 'self'; base-uri 'none'; form-action 'none'
```

and loads it in an `<iframe sandbox="allow-scripts">`: an opaque origin with no access to the workspace, its cookies or its API, and no network. Bundle everything into the directory; nothing outside `root` is served.

### Protocol (version 1)

1. The host posts `{ type: 'hodos:connect', protocol: 1 }` to the iframe's window with one `MessagePort`. Accept it only from `window.parent`, once. Every later message travels on that port.
2. The renderer sends `{ type: 'hodos:ready', protocol: 1 }`.
3. The host sends `hodos:init` (environment, locale, `colorScheme`, granted capabilities), then any of:

| Host → renderer | Meaning |
|---|---|
| `hodos:present` `{ exercise }` | Show a new exercise (the student view: no key). It is answerable until the host sends `hodos:lock` with `locked: true`. |
| `hodos:progress` `{ exerciseId, progress, message? }` | The server accepted one step of a stepwise exercise. |
| `hodos:result` `{ exerciseId, correct, score, reveal? }` | The attempt was graded; `reveal` only when the platform released it. |
| `hodos:block` `{ block }` | Show a lesson block (read-only). |
| `hodos:lock` `{ locked }` | Stop or resume accepting input. |
| `hodos:clear` | Show nothing. |

| Renderer → host | Meaning | Capability |
|---|---|---|
| `hodos:response` `{ exerciseId, response }` | The learner's answer (or one step). | `respond` |
| `hodos:resize` `{ height }` | Ask for a new iframe height. | `resize` |

Both sides validate every message and drop anything malformed; a message from a renderer is limited to 64 KiB. `respond` and `resize` are granted on request; `speech-synthesis` only when the manifest lists it in `rendererPermissions`.

`connectRenderer(window, handlers)` from `@hodos/plugin-sdk/renderer` does the handshake and the validation for you; `examples/binary-numbers/renderer/bits.js` shows the same protocol by hand. Build the page with DOM APIs and `textContent`, never from HTML strings, so payload text can never become markup.

## Content packs and courses

A course (`CourseSpec`) has a goal skill, a prerequisite graph of skills (each with a `kind`: fact, concept, procedure, pattern, performance or judgment, which selects the learning loop), one lesson per skill, and items. Shipped courses are validated with full coverage:

- every skill needs at least 3 `practice` items and at least 1 `checkpoint` item; give it at least as many checkpoint items as a checkpoint draws (3 by default), kept separate from the practice items;
- give every skill a `diagnostic` item, so placement can skip what the learner knows;
- lesson examples must not be exercise answers.

`hodos course guide` prints the authoring guide generated from the installed plugins (kinds with schemas and examples, blocks, presets, coverage rules), and `hodos course validate <file>` checks a course file against them; see [course-authoring.md](course-authoring.md).

If a course claims a check it passed (`provenance.verifiedBy`), make it true and reproducible, as the built-ins do: `@hodos/chess` records a Stockfish run and `@hodos/code` a CPython run, each tied to a hash of the content it checked, and drops the claim when the content changes.

## Packaging

### As a DeepSeek Harness bundle (code)

Follow the built-ins:

- export `createPlugin()` (the host-neutral factory) and the Cordis entry: `const entry = createCordisEntry(createPlugin())`, then export `name`, `inject` and `apply` from it. The entry waits for the `hodos` service from `@hodos/dsh` and unregisters when either side unloads;
- ship a `cordis.patch.yml` that inserts the row (`- insert: - id: hodos-math, name: '@hodos/math'`) and point to it from `package.json` (`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`);
- install with `dsh plugin add <package or directory>`.

Remember that only ids in `trustedPlugins` get their hooks called.

### As a declarative plugin (data)

A directory with `hodos-plugin.json` (`manifest`, `exerciseKinds`, `graders` with a `sandbox` file, `lessonBlocks`, `presets`, `renderers`, `contentPacks`), listed in `pluginDirs`. Every path must stay inside the directory (symlinks included); the description may be 1 MiB, a grader 512 KiB and a content file 8 MiB. See [`examples/binary-numbers`](../examples/binary-numbers).

## Versions: stable and experimental

The SDK is at 0.1.0 and speaks plugin API 0.1.0 (`SDK_VERSION`, `CORE_PLUGIN_API_VERSION`). A manifest declares the range of plugin API versions it supports in `requiresCore` (e.g. `^0.1.0`); an incompatible plugin is refused.

- **Stable within 0.1**: the manifest, exercise kinds, graders and `GradeResult`, lesson blocks, presets, renderers and the renderer protocol (version 1), content packs and courses, the declarative format. A breaking change to any of these comes with a new plugin API version.
- **Experimental** (may change without one): content generators (`registerContentGenerator`, trusted plugins only), the speech contracts in `speech.ts` (no implementation ships, and no speech assessment is faked with text models), and the `speech-synthesis` renderer capability.

## Testing a plugin

- **Unit-test the grader** with `GradeInput` objects built from your items: the right answer, each misconception, malformed input, and that feedback never contains the key. See `packages/environments/*/tests`.
- **Validate the content** with `PluginRegistry` and `validateCourse(course, registry, { requireCoverage: true })` from `@hodos/core`, registering the plugin with the trust it will have in production (`{ trusted: false, declarative: true }` for a declarative plugin), so sandboxed checks run as they will for users. See `tests/integration/*-course.test.ts` and `tests/integration/example-plugin.test.ts`.
- **Run a journey** through `HodosEngine` with an in-memory store: start, lesson, practice, a misconception, and the feedback that is released.
- **Test the renderer in a browser** under the renderer CSP in a sandboxed iframe: `tests/e2e/support/renderer-host.ts` serves a renderer directory the way the workspace does and records its messages.
- **Run it in DeepSeek Harness** without a model account: `@hodos/testing` has `startMockLlm` and `tutorScript`, a deterministic stand-in for the model API, and `tests/e2e/support/dsh.ts` installs bundles into a throwaway Harness home.

`@hodos/testing` (MIT) also ships `createQuizPlugin`, a small fixture environment used by the platform's own tests.
