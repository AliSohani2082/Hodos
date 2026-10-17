# Lesson IR: format recommendation

Status: research, 2026-10-09. Scope: the intermediate representation between lesson generation and lesson rendering.

**Evidence labels.** `[measured]` means I ran it in a scratch dir (`@markdoc/markdoc@0.5.10`, `remark-directive@4.0.0`). `[docs]` means Context7 or the vendor docs. `[memory]` means my prior knowledge, not re-verified this session. `[untested]` means a claim I could not test. **I did not run any LLM authoring-reliability experiments.** Every statement about model reliability below is reasoning plus second-hand literature, and §6 proposes an eval.

---

## 1. Recommendation

**Use Markdoc as the authoring and validation surface. Store lesson `.md` files as the canonical form (§7), with the typed JSON AST as a derived cache. Make plugin-owned JSON Schema the contract for every block.**

In layers:

1. **Plugin contract.** Each block type is declared once as JSON Schema (attributes), plus a body kind, a guidance text, a plain-text fallback, and an optional materializer. This is the only thing plugins write. Markdoc's own schema objects are generated from it.
2. **Wire and authoring syntax.** The agent writes Markdoc: CommonMark plus `{% tag attr=… %}…{% /tag %}`. It is validated, repaired in a loop, then parsed to an AST.
3. **Stored canonical form.** **Superseded by §7:** blueprint lessons are canonical as `.md` files in a per-course git repo, with stable block ids stamped into the text. The parsed JSON AST (`Markdoc.Ast.fromJSON` round-trips `[measured]`) is a derived cache that renderers, materializers and the citation index consume. Text is never re-parsed at render time. Per-student adaptive content is the exception: it lives as database rows (AST + source text).
4. **Export.** The course repo itself is the export (`.md` files, `course.yaml` with pinned plugin versions, `graph.yaml`). Cached sources are never exported (§7).

### Where I disagree with the planning recommendation

| # | Planning rec | My view | Evidence |
|---|---|---|---|
| 1 | remark-directive, "validated against plugin schemas" | remark-directive validates nothing. Parsing is separate from validation, so we would write the validator, the error taxonomy, line mapping and the repair-loop feedback ourselves. Markdoc ships this. | `[measured]` Markdoc returns structured errors: `tag-undefined`, `attribute-missing-required`, `attribute-value-invalid` (with the allowed values), `attribute-undefined`, `missing-closing`. Each has an id, a message and line numbers. Those are directly usable as tool-result feedback for the agent. |
| 2 | Directives, with attributes as the data channel | Directive attributes are strings only. Quiz options, manim scene params and boards with highlights need arrays and objects. | `[docs]` mdast types: `attributes: Record<string, string \| null \| undefined>`. Markdoc attributes take numbers, booleans, arrays and objects `[measured]`, e.g. `options=[{id:"a",text:"x"}]`. |
| 3 | "Malformed or unknown directives degrade to plain text" | This is true, and it is a hazard rather than a feature. A typo'd block is silently swallowed as prose and no error is raised. Real degradation has to be an explicit per-block `fallback`, not a parser accident (§5). | `[measured]` `::bad{fen="a"` (unclosed brace) becomes a paragraph of literal text with no diagnostic. The stringifier then escapes it to `:\:bad…`. |
| 4 | "Stored as source text + parsed AST" | Agree, but the AST should be primary. Materializer cache keys, citation anchors, SRS item ids and comments all need stable node ids. Text-offset identity breaks on every edit. | design reasoning |
| 5 | Unknown directives degrade to plain text | Degradation needs more than "show the text". A leaf block like a chess board has no useful text. Each block schema must supply a **plain-text projection** (`fallback.text(node)`), which also feeds the transcript, TTS script and search index. | design reasoning |
| 6 | Syntax choice | `:::` is probably more familiar to models (Docusaurus, VitePress, Pandoc, MyST), which is a point for directives `[memory]`. But `:::` nesting depends on colon counts and there is no named closer. `{% /perspective %}` is explicit and nest-safe, and a missing close is a reported error rather than a silent auto-close. I would trade some familiarity for validation. Settle it empirically (§6). | `[untested]` for reliability, `[measured]` for the error behaviour |

Not disagreeing with: text-first, schema-validated, plugin-registered, no code execution, unknown-block fallback, a plain-text renderer that always works.

### When to switch to remark-directive

- You need a WYSIWYG editor early. TipTap has an official Markdown package (3.31.4, updated 2026-09-30), and MDXEditor and Milkdown have directive support `[memory]`. None of them speak Markdoc.
- The eval in §6 shows directive syntax is meaningfully more reliable for the models you target.
- Plan the swap: if the plugin contract is JSON Schema and the stored form is a JSON AST, the surface syntax is a replaceable parser/printer pair. That is the main reason for the layering.

---

## 2. Comparison

Scale: ✅ strong, 🟡 workable with effort, ❌ weak or unsuitable.

| Criterion | **Markdoc** | **Markdown + remark-directive** | **MDX** | **Portable Text / ProseMirror JSON** | **Djot / Pandoc AST** | **A2UI-style JSON UI** |
|---|---|---|---|---|---|---|
| LLM authoring reliability | ✅ prose is plain Markdown, tags are explicit. Validation errors are structured, so repair loops are cheap `[measured]`. Unmeasured with real models. | 🟡 `:::` is familiar `[memory]`. No validator, so the repair signal must be built. Colon-count nesting is error-prone `[untested]`. | 🟡 models write JSX fluently, but syntax errors are fatal to compile and the expressive power is the problem (below). | ❌ for long prose. Per the second-hand literature, strict JSON output can hurt content quality (see §6, sources). Fine for small structures. | 🟡 Djot is cleaner than Markdown but rare in training data. Pandoc AST JSON is verbose. | 🟡 designed for LLMs and streaming, but built for UI widgets, not long prose. |
| Streaming | 🟡 no incremental parser. Re-parse is cheap (185k chars in ~115 ms `[measured]`), but raw `{%` leaks into rendered text in 75 of 123 prefixes unless the tail is repaired. Needs a small tail-trim plus auto-close step. | ✅ re-parse is cheap (~203 ms for 185k chars `[measured]`). Containers auto-close at EOF, so only 17 of 93 prefixes leak, and only mid-marker. Tail-trimming still advisable. | 🟡 whole-document compile. A partial JSX tree is a compile error. | ✅ block-granular, trivially streamable once complete. Partial blocks need a JSON-repair layer. | 🟡 Djot has an event-based parser, so incremental parsing is feasible `[memory]`. | ✅ built for incremental assembly `[docs]`. |
| Plugin-registered block types and schemas at runtime | ✅ `config.tags` is a plain object you build at runtime. Attributes have types, `required`, `matches` and custom validators `[docs]`. No JSON Schema, so you write an adapter. | 🟡 directive names are free-form. Registry, schema and validator are all ours. | ❌ components are code. Registering one means shipping executable code to the compiler. | ✅ custom `_type` objects are first-class `[docs]`. | 🟡 Pandoc Lua filters are powerful but a different runtime. | ✅ component catalogs with schemas `[docs]`. |
| Schema versioning and migration | 🟡 we build it (§4). The format does not carry versions. | 🟡 same | ❌ | ✅ JSON data migrates easily with plain functions. | 🟡 | 🟡 spec is still moving (v0.8 stable, v0.9 draft) `[docs]` |
| Graceful degradation | ✅ unknown tag is reported by `validate`. `transform` drops the tag and keeps its children `[measured]`. With a `fallback` policy this is exact. | 🟡 unknown directives parse fine, so the policy is ours. Malformed syntax silently becomes text `[measured]`. | ❌ an unknown component throws at render time. | ✅ renderers get an `onMissingComponent` hook `[docs]`. | 🟡 | ✅ unknown components can be skipped by design |
| Security: no code execution | ✅ no JS in content. Functions and variables exist only if config provides them. Raw HTML is escaped, not parsed. `javascript:` and `data:` links stay literal text `[measured]`. | ✅ data-only. Raw HTML depends on the remark/rehype pipeline we assemble. | ❌ MDX is a program. Arbitrary code execution when untrusted MDX is compiled; CVE-2026-0969 in next-mdx-remote (CVSS 8.8) is a recent example `[docs]`. | ✅ pure data | ✅ pure data (Djot has raw-format spans to disable) `[memory]` | ✅ declarative data `[docs]` |
| Safe to pass into sandboxed iframes | ✅ attributes are JSON-like values, so structured clone works | 🟡 string attrs only, so everything is stringly-typed | ❌ | ✅ | ✅ | ✅ |
| Citations and perspective attribution | ✅ inline `{% cite %}` wrapping a claim span, plus a `perspective` container. A cross-reference validator checks chunk ids. | ✅ `:cite[claim]{chunk=…}` text directive. Same cross-reference validator needed. | 🟡 possible, via components | ✅ annotations via `markDefs` are a good model for claim to source `[docs]` | 🟡 Pandoc has a citation syntax aimed at bibliographies, not chunk anchors | 🟡 |
| Materializer mapping | ✅ node id + attrs + schema version gives a cache key (§4) | ✅ same | 🟡 | ✅ | ✅ | ✅ |
| Human editability and git diffs | ✅ plain text, readable diffs. `Markdoc.format` re-prints from the AST `[measured]`, normalizing e.g. `id="q1"` to `#q1`. No WYSIWYG ecosystem. | ✅ plain text. Strongest WYSIWYG story (TipTap, MDXEditor, Milkdown `[memory]`). | ✅ text, but editors need a runtime. | ❌ JSON diffs are noisy. Editing needs a purpose-built editor. Portable Text Editor exists (8.2.4, updated 2026-10-09) but is Sanity-shaped. | ✅ text | ❌ not meant for humans |
| TS ecosystem, maintenance, licence | 🟡 `@markdoc/markdoc` 0.5.10, MIT, modified 2026-09-16. Pre-1.0, single vendor (Stripe), small codebase and forkable. | ✅ `remark-directive` 4.0.0 (Feb 2025), MIT, unified ecosystem, huge. The directive syntax is still a community proposal, not CommonMark. | ✅ `@mdx-js/mdx` 3.1.1, MIT | ✅ `@portabletext/types` 4.0.2, MIT | 🟡 `@djot/djot` 0.3.2 (Dec 2024), MIT. Pandoc is a Haskell binary. | 🟡 Apache-2.0, young, spec in flux |

### Other precedents (from memory, not re-verified this session)

- **Perseus (Khan Academy).** Content is Markdown-ish text with widget placeholders like `[[☃ radio 1]]`, plus a sidecar JSON map of widget configs. This is a prose + typed-blocks split that suits "exercise" content.
- **H5P.** Each content type ("library") ships a `semantics.json` that describes its parameters. That is the closest analogue to plugin-owned schemas with versions: libraries carry major.minor versions and upgrade scripts.
- **MyST (mystmd 1.11.0, active).** Directives and roles with *typed options*, built on mdast. If we want directives with real typing, MyST's directive spec is more mature than raw remark-directive.
- **Quarto / Pandoc.** Fenced divs `::: {.callout-note}` plus shortcodes. Authoring-friendly, but it is a publishing toolchain, not a runtime.
- **Slidev.** Markdown plus Vue components. Great for trusted authors, the same "content is code" problem as MDX.

---

## 3. Sample lesson in the top two formats

Illustrative only. Chunk ids and outlet claims are made up. The FEN is valid: White's Nd5–c7+ forks the king on e8 and the rook on a8.

### 3a. Markdoc

````markdoc
---
lesson: knight-fork
concept: chess.tactics.fork.knight
---

# The knight fork

A **fork** is one move that attacks two valuable pieces at once, so the
opponent can only save one. The knight is the classic forking piece because it
attacks in an "L" shape that no other piece can block or retaliate against
along the same line {% cite chunk="src:lichess-learn#c3" %}— a forked piece
cannot simply capture the forker if the forker is protected{% /cite %}.

{% position id="p1" fen="r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1" orientation="white"
   caption="White to move: where does the knight fork king and rook?"
   reveal={move: "Nc7+", highlight: ["c7", "e8", "a8"]} /%}

From d5 the knight can jump to c7. From there it attacks both the king on e8
and the rook on a8. Black must answer the check, and White then takes the rook
{% cite chunk="src:lichess-learn#c4" %}(Nc7+ wins the exchange outright){% /cite %}.

{% perspective outlet="src:silman" role="emphasis" %}
Silman frames forks as a symptom of *loose pieces*: before looking for the
knight jump, count which opposing pieces are undefended
{% cite chunk="src:silman-complete#c12" %}— a fork only wins material if its
targets lack protection{% /cite %}.
{% /perspective %}

{% perspective outlet="src:chesstempo-blog" role="contrast" %}
The training-blog view is pattern-first: drill the fork shapes until the
geometry is automatic, and let the loose-piece count fall out of that
{% cite chunk="src:chesstempo#c7" %}— recognition speed beats analysis{% /cite %}.
{% /perspective %}

{% exercise type="mcq" id="e1" mode="formative" concept="chess.tactics.fork.knight"
   prompt="Which squares does a knight on c7 attack that matter in the diagram?"
   options=[{id: "a", text: "e8 and a8"}, {id: "b", text: "d8 and b8"}, {id: "c", text: "Only e8"}]
   answer="a"
   explain="The knight on c7 attacks e8 (king) and a8 (rook) at once." /%}
````

### 3b. Markdown + remark-directive

`````markdown
---
lesson: knight-fork
concept: chess.tactics.fork.knight
---

# The knight fork

A **fork** is one move that attacks two valuable pieces at once, so the
opponent can only save one. The knight is the classic forking piece because it
attacks in an "L" shape that no other piece can block or retaliate against
along the same line :cite[— a forked piece cannot simply capture the forker if
the forker is protected]{chunk="src:lichess-learn#c3"}.

::position{#p1 fen="r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1" orientation=white caption="White to move: where does the knight fork king and rook?" reveal-move="Nc7+" reveal-highlight="c7,e8,a8"}

From d5 the knight can jump to c7. From there it attacks both the king on e8
and the rook on a8. Black must answer the check, and White then takes the rook
:cite[(Nc7+ wins the exchange outright)]{chunk="src:lichess-learn#c4"}.

:::perspective{outlet="src:silman" role=emphasis}
Silman frames forks as a symptom of *loose pieces*: before looking for the
knight jump, count which opposing pieces are undefended
:cite[— a fork only wins material if its targets lack protection]{chunk="src:silman-complete#c12"}.
:::

:::perspective{outlet="src:chesstempo-blog" role=contrast}
The training-blog view is pattern-first: drill the fork shapes until the
geometry is automatic, and let the loose-piece count fall out of that
:cite[— recognition speed beats analysis]{chunk="src:chesstempo#c7"}.
:::

:::exercise{type=mcq #e1 mode=formative concept="chess.tactics.fork.knight"}
```yaml
prompt: Which squares does a knight on c7 attack that matter in the diagram?
options:
  - {id: a, text: e8 and a8}
  - {id: b, text: d8 and b8}
  - {id: c, text: Only e8}
answer: a
explain: The knight on c7 attacks e8 (king) and a8 (rook) at once.
```
:::
`````

Note on the exercise: it is a **formative** check-understanding item, the only kind that may be inline (see §5, "Answer keys"). Its `answer`/`explain` are `x-visibility: server` fields. Checkpoint items do not appear in lesson text at all.

Observations from writing both:

- The directive version needs flat strings for the board's `reveal` object (`reveal-move`, `reveal-highlight="c7,e8,a8"`, a hand-rolled comma list) and a YAML fenced body for the exercise. That means a second sub-format and a second parser per block, validated separately.
- Markdoc keeps one syntax and one typed value grammar throughout, at the cost of `{% … %}` noise inside prose.
- Neither sample mentions presentation: no card, no column, no video. The `role` on `perspective` is semantic. A lecture layout may render it as a transcript aside, a chess layout as a spoken counterpoint, the plain-text fallback as an indented "According to Silman:" paragraph.

---

## 4. Plugin-side API sketch

Assumption: cordis `Service` + `ctx.effect` for scope-bound registration `[docs]` (third-party mirror docs; verify against the real cordis version). The registration returns a disposer, so unloading a plugin unregisters its blocks and cordis takes care of dependents.

```ts
import type { JSONSchema7 } from 'json-schema'   // or TypeBox: Static<typeof schema> gives Attrs
import type { Context } from 'cordis'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** Parsed, schema-validated node. Everything the platform hands to plugin code is plain data. */
interface LessonNode<A extends Record<string, Json> = Record<string, Json>> {
  id: string                        // platform-assigned, stable across edits (ULID)
  type: string                      // registered block name
  attrs: A
  children?: LessonNode[]           // present only for container / inline kinds
  text?: string                     // for text-bearing leaf nodes
  span?: { lines: [number, number] }
}

interface Diagnostic { level: 'error' | 'warning'; id: string; message: string; nodeId?: string; line?: number }

type BodyKind = 'none' | 'markdown' | 'text' | 'yaml'   // yaml only if we pick directives

interface BlockSpec<A extends Record<string, Json> = Record<string, Json>> {
  /** Globally unique among installed plugins. Core names are reserved. */
  name: string
  /** Major version of the attrs schema. Bump on breaking change; ship a migration. */
  version: number
  kind: 'leaf' | 'container' | 'inline'
  body: BodyKind
  attrs: JSONSchema7                 // properties may carry `"x-visibility": "server"` (answer keys, rubrics); stripped before any client payload

  /** (b) Injected into the agent prompt when this block is available in the course. */
  guidance: {
    when: string                     // "Use for a concrete chess position the learner should look at."
    syntax: string                   // one canonical example in the active surface syntax
    rules?: string[]                 // "FEN must be legal. Never invent positions; take from the source."
    avoid?: string[]
  }

  /** Semantic checks beyond JSON Schema. Runs in the validator, so errors feed the repair loop. */
  validate?(node: LessonNode<A>, ctx: ValidationContext): Diagnostic[]   // FEN legality, cite chunk exists in the retrieval set

  /** REQUIRED. What this block means with no renderer: used for fallback, transcript, search, TTS. */
  fallback: {
    mode: 'children' | 'text' | 'hide'        // container with no renderer: show children vs. text projection vs. nothing
    text(node: LessonNode<A>): string         // "[Chess position (White to move): r3k3/8/…]"
  }
  /** Optional: what a voice-over should say for this node (may differ from fallback.text). */
  speakable?(node: LessonNode<A>): string | undefined

  /** version N-1 → N. Run lazily on load, then re-save. */
  migrate?: Record<number, (old: LessonNode) => LessonNode>

  /** (c) Browser side. AI-generated plugin UI is untrusted and always runs in a sandboxed iframe. */
  renderer: {
    entry: string                              // path to bundle inside the plugin, served from a sandboxed origin
    trust: 'sandboxed' | 'first-party'         // 'first-party' reserved for plugins that ship with the platform
    capabilities?: Array<'asset:read' | 'event:answer' | 'storage:block'>   // postMessage host API surface
    height?: 'auto' | number
  }

  materializer?: MaterializerSpec<A>
}

interface MaterializerSpec<A extends Record<string, Json>> {
  id: string                                   // 'manim.scene'
  version: number                              // bump when output semantics change
  /** Canonical subset of the node that determines output. Everything else is ignored by the cache key. */
  inputs(node: LessonNode<A>, ctx: LessonContext): Json
  /** Runs in a container. Cache hit => never called. */
  run(job: {
    inputs: Json
    signal: AbortSignal
    emit(progress: { pct: number; note?: string }): void
    write(name: string, data: Uint8Array, mime: string): Promise<AssetRef>
  }): Promise<Record<string, AssetRef>>        // named outputs, e.g. { video, captions }
  image: string                                // container image digest; part of the cache key
  resources?: { cpu?: number; memMb?: number; timeoutS?: number; network?: false }
}

/** cacheKey = sha256(materializer.id, materializer.version, image, canonicalJSON(inputs(node))) */

interface LayoutSpec {
  name: string
  guidance: string                             // how the agent should structure a lesson for this layout
  accepts: string[]                            // block names it knows how to place; others use their fallback
  roles?: Record<string, string>               // how it will present semantic roles, e.g. perspective → "sidebar"
  renderer: BlockSpec['renderer']
}

/** Cordis service exposed to plugins */
declare module 'cordis' {
  interface Context { lesson: LessonRegistry }
}
interface LessonRegistry {
  block<A extends Record<string, Json>>(spec: BlockSpec<A>): () => void   // returns disposer
  layout(spec: LayoutSpec): () => void
}

// ---- A plugin ----
export const name = 'chess-board'
export function apply(ctx: Context) {
  ctx.effect(() => ctx.lesson.block<{ fen: string; orientation?: 'white' | 'black' }>({
    name: 'position', version: 1, kind: 'leaf', body: 'none',
    attrs: { /* JSON Schema */ },
    guidance: { when: '…', syntax: '{% position fen="…" /%}', rules: ['FEN must be legal'] },
    validate: (n) => isLegalFen(n.attrs.fen) ? [] : [{ level: 'error', id: 'chess/bad-fen', message: 'Illegal FEN', nodeId: n.id }],
    fallback: { mode: 'text', text: (n) => `[Chess position: ${n.attrs.fen}]` },
    renderer: { entry: 'ui/board.js', trust: 'sandboxed', capabilities: ['event:answer'] },
  }))
}
```

How the pieces connect:

- **Authoring guidance assembly.** For a given course, the platform concatenates `guidance` from the layout plugin (`LayoutSpec.guidance`) and from every block the layout `accepts` that is installed. The agent can only emit what the course can render.
- **Markdoc schema generation.** One function turns each `BlockSpec.attrs` into Markdoc `config.tags[name] = { selfClosing, inline, attributes: {…} }`. Where an attribute can't be expressed in Markdoc's type system, check it in `validate` instead.
- **Validation order.** Parse, then Markdoc structural validation, then JSON Schema on attrs, then the plugin's `validate`, then cross-reference checks (every `cite.chunk` must be in the retrieval set handed to the agent, every `perspective.outlet` must be a known outlet of this course). All errors go back to the agent as one tool result so it fixes them in a single round.
- **Versions.** *(Revised per §7.)* `course.yaml` pins plugin versions and block-schema versions for each published course version. Published tags are immutable and always re-render with their pinned schemas. `migrate` chains run only when a draft is moved to a new version, never on load. No version in the lesson text, so diffs stay clean.
- **Materializer lifecycle.** Compute the key from `inputs(node)`, look it up, enqueue a container job on a miss. The renderer receives `assets` by node id once ready, and shows `fallback` or a placeholder until then. Editing prose around a block never invalidates it; editing its attrs does.

---

## 5. Streaming, degradation, security: the design in brief

**Streaming.** The agent's stream is buffered into a *committed* part and a *provisional tail*.

1. Commit at top-level blank lines where no tag is open.
2. Re-parse committed content incrementally by appending, and re-parse the tail on every chunk.
3. Before parsing the tail, repair it: drop an unterminated `{% …` or `:name[…` at the end, and auto-close open tags.
4. Prose blocks render as they arrive. Plugin blocks render only once they've closed and validated, so a half-written board never mounts. (Libraries like Vercel's `remend` (Apache-2.0, 1.4.0) solve the same problem for plain Markdown, but know nothing about Markdoc tags.)

**Degradation order for an unknown or missing block.**

1. If a block is unknown to this course (plugin missing), apply that block's last-known `fallback` policy. The AST keeps the node untouched, so reinstalling the plugin restores it.
2. If it is unknown to the platform entirely, show a visible "unsupported block" placeholder. Do not silently drop it.

**Security.**

- No evaluation path exists in content. Register no Markdoc functions or variables.
- Raw HTML is inert text, and `javascript:`/`data:` links did not become links `[measured]`. Re-test whenever we add image/link node schemas, and add a URL-scheme allowlist as defence in depth.
- Iframe payload is exactly `{ client-visible attrs, resolved asset URLs }`, serialised JSON through `postMessage`. "Client-visible" means node.attrs with every `x-visibility: server` field removed (see "Answer keys"). No HTML strings from content ever reach a renderer.

**Answer keys (gap found by the host agent).** Earlier drafts sent all of `node.attrs` to the client, so an `exercise`'s `answer` and `explain` were readable from devtools. Rules:
1. Attr schemas mark fields `x-visibility: server` (answer, rubric, grading hints, distractor rationales). The server strips them when it serves the AST and before any `postMessage`. The stripping must be driven by the schema, not by a hard-coded field list.
2. Grading happens server-side only, via the exercise plugin's `grade()` hook. The client sends an attempt and receives a verdict.
3. `explain` is released only after the attempt is graded.
4. **Checkpoint (gating) items never appear inline in lesson text.** They live in teacher-approved `checkpoints/` pool files and are referenced by id. Lessons may inline only formative check-understanding items. Practice items are database rows.
5. Visibility is richer than server/client: some server fields are released on an event (hint level, after attempt, after grade). See §9.4.
6. Even formative inline items obey rules 1 to 3, because the lesson file itself is server-side and only the stripped AST is served.
- Prose is rendered by the host, not by plugin iframes.

---

## 6. Risks and open questions

**Unmeasured, and most important.**
- **LLM reliability is untested.** I'd run a small eval before locking the syntax: ~30 lesson prompts × {Markdoc, remark-directive, XML-ish tags} × the 3 to 4 models actually targeted, scoring parse-valid, schema-valid, repair rounds to green, and blind-rated content quality. The literature I found is second-hand: a 2026 LREC study reports format choice swinging scores by 2 to 46 F1 points depending on model and task, and "Let Me Speak Freely" (arXiv 2408.02442) reports strict format constraints hurting reasoning. I could not verify the second against the paper. The practical takeaway is to let the model write the lesson body freely and validate afterwards, rather than force JSON-mode on long prose. I can build this eval if wanted.
- **Streaming UX of block-granular rendering.** A lesson that is mostly plugin blocks streams in lumps, not smoothly. Needs a prototype.

**Format risks.**
- Markdoc is pre-1.0 and single-vendor. Mitigation: keep it behind a parser/printer interface, because the stored AST is ours and the code is small enough to fork.
- Markdoc has no JSON Schema support and no standard WYSIWYG editor. The adapter and a raw-text editor (CodeMirror with Markdoc highlighting and live diagnostics) are on us.
- `Markdoc.format` normalises text (e.g. `id="q1"` becomes `#q1`). Hand-edited source will be rewritten on save. Decide whether text or AST wins on conflict. I'd say text wins and the AST is re-derived.
- Tag names with dots (`chess.position`) are untested in Markdoc. I used flat unique names; namespacing may need a convention such as `chess-position`.

**Open design questions.**
1. **Where does narration live?** A Coursera-style lesson needs a voice-over script that can differ from the on-screen text. Options: derive from `speakable`/`fallback.text`, or add a core `narration` block. This needs timing anchors (node ids as sync cues) to align voice-over with a manim video or board moves.
2. **Exercises: inline or entity? (resolved with the host agent.)** Exercises are first-class entities with stable ids. Checkpoint items live in `checkpoints/` pool files and are referenced from lessons by id. Lessons may inline only formative items. Practice items are database rows. Remaining detail: how an inline formative item is indexed so Review/SRS can schedule it (extract by id on ingest, or reference-only).
3. **Core vocabulary.** The platform should own a small *semantic* core (heading, paragraph, list, code, math, callout, `cite`, `perspective`, `exercise`, `term`) so layouts can map roles consistently, and plugins only add domain blocks. Who may add new *roles* to `perspective`? I suggest a closed enum owned by the platform.
4. **Cross-reference validation cost.** Citation checks need the retrieval set for that generation. Store it with the lesson (list of chunk ids shown to the agent) so later validation is reproducible.
5. **Citation granularity.** Chunk ids are stable only while the source is not re-chunked. Decide the re-chunking policy now (immutable chunk ids, or a chunk-to-chunk remap on re-ingest).
6. **Surface syntax lock-in.** If the eval favours directives, the layering in §1 makes the swap local to the parser/printer. Confirm the AST shape is syntax-neutral (no Markdoc-specific `annotations`/`lines` leaking into plugin-facing types). The `LessonNode` sketch above is deliberately neutral.

---

## 7. Storage: files vs database (added after discussion)

This section records three positions, the research behind them, and the resulting design. Participants: the user, this research agent, and the host/planning agent (`teach-ai-81`).

### 7.1 Positions

**A. Research agent, initial (§1 as first written): database canonical, files as export.**
- Pros: one authority for node ids and cache keys; transactional edits; easy permissions and multi-user later.
- Cons: agents (Claude Code, Codex and the other ACP agents) must reach content through MCP tools instead of their native read/grep/edit; no free git history; the text becomes a second-class view; a missed point at the time was how much agent ergonomics matter.
- Status: **withdrawn.**

**B. User: files canonical, in a neat folder structure on the host, Karpathy-LLM-wiki style.**
- Pros:
  - ACP agents use native file tools, with no custom content endpoints.
  - The sandbox boundary is simply one mounted directory.
  - Git history, diffs, backup and editing in any editor come free.
  - Human-readable and portable.
- Cons:
  - Agent-written files bypass any validator unless a gate exists.
  - Block identity must live in the text, because the database can't assign it.
  - Non-text and high-write data (learner state, embeddings, jobs) fit files badly.
  - Needs atomic writes and a file watcher.
- Status: **adopted for blueprint content,** with the limits in C.

**C. Host agent (`teach-ai-81`): files canonical for the course BLUEPRINT only; the database owns everything per-learner and derived.**
- Context it supplied: RBAC (admin, teacher, student), a linear version flow (AI drafts, teacher reviews a diff and approves, published to students), a teacher-approved blueprint plus an automatic per-student adaptive layer (logged, no approval), and one append-only xAPI-shaped event log in the database.
- Design: one git repo per course; draft is the working tree; approve is commit plus tag; students read an immutable tag, never the working tree; the review screen is a rendered diff; permissions are enforced by the app, not the filesystem; an agent session's cwd is scoped to one course's draft tree.
- Status: **adopted.** It adds constraints I had not known, and it makes versioning nearly free.

### 7.2 Research: Karpathy's LLM wiki

Primary source: Karpathy's `llm-wiki` gist (April 2026), read in full except a trailing ~37k characters (likely comments). Secondary write-ups are only orientation. The gist is deliberately abstract, prescribes no directory layout and gives no benchmarks.

| Element | What the gist says |
|---|---|
| Raw sources | Immutable. "The LLM reads from them but never modifies them." |
| Wiki | LLM-written markdown (summaries, entity and concept pages, comparisons). "You read it; the LLM writes it." |
| Schema | A `CLAUDE.md`/`AGENTS.md` that defines structure, conventions and workflows. |
| `index.md` | Catalog of every page: link, one-line summary, category. The agent reads it first. Works at "~100 sources, ~hundreds of pages" without embeddings. |
| `log.md` | Append-only, greppable prefixes like `## [2026-04-02] ingest \| Title`. |
| Operations | **Ingest** (one source can touch 10-15 pages), **query** (cited answers, good ones filed back as pages), **lint** (contradictions, stale claims, orphans, missing links, gaps). |
| Tooling | Obsidian, Git, Marp, Dataview. For larger wikis, real search such as `qmd` (hybrid BM25/vector with re-ranking, CLI and MCP). |

**Mapping to Hodos**

| Karpathy | Hodos |
|---|---|
| Raw sources (immutable) | Outlets / cached sources (instance-level store, never in the course repo) |
| Wiki pages | Course lessons, concept notes, per-course `index.md` and `log.md` |
| Schema file | Per-course `AGENTS.md` carrying Markdoc authoring rules and plugin `guidance` |
| Lint | First-class platform operation: block validation, dangling citations, orphan concepts, skill-graph gaps |
| Index-first retrieval, no vector DB | Keep the `index.md` for agent navigation, **and** chunk-level retrieval, because decision 6 requires claims to cite source chunks |

**Where the analogy breaks**
- A wiki is a knowledge base the agent consults. A course is a product a learner consumes, so files need machine-checked validity before they render.
- Karpathy keeps the human involved at ingest time. Here a teacher approves a diff, which fits.
- **Unresolved risk:** compounding error when LLM-written pages are re-summarized. I found no direct evidence for or against this pattern, only an unrelated arXiv study (2505.16894) showing hallucination drift under incremental context, which is TruthfulQA-based and does not test wikis. Mitigation by design: lessons cite immutable source chunks, and lint should check claim-to-chunk links, not just formatting.

### 7.3 Resulting design

**In files (per-course git repo, blueprint):**
```
course/
  course.yaml        # plugins enabled + pinned versions, block-schema versions, layout plugin, per-course plugin config
  graph.yaml         # skill path + node definitions (not mastery)
  AGENTS.md          # schema file: conventions and the authoring guidance for installed plugins
  index.md  log.md   # Karpathy-style navigation + change log
  lessons/*.md       # Markdoc, canonical
  checkpoints/*      # teacher-approved checkpoint item pools
  notes/*.md         # agent-maintained concept notes
```
Sources are referenced by id plus citation excerpts only.

**In the database (instance-level or per-learner):**
- accounts, roles, sessions, secrets and API keys
- all learner data: progress, attempts, SRS state, mastery, the xAPI-shaped event log
- **adaptive overlays**: remedial segments, re-explanations and per-student practice items, as rows keyed by `(student, course version, block id)`; stored as AST + source text, validated by the same pipeline so the same renderers work
- plugin per-student runtime state (code submissions, canvas drawings, chess games), keyed by student + block id
- embeddings and the retrieval index; job queue and materializer job table
- cached sources and uploaded books (never exported; legal decision)

**On disk but outside git:** a content-addressed `.cache/` for materializer outputs (video/audio).

**Rules this implies**
1. **Stable block ids live in the text.** Stamp an `id` once on first ingest for blocks that need identity (exercises, materializable blocks, anything an overlay or citation anchors to). Derive the rest from path + content hash. Overlay anchoring depends on ids not changing across versions unless the content does.
2. **Never auto-reformat files.** `Markdoc.format` rewrites hand-edited text (e.g. `id="q1"` becomes `#q1`) `[measured]`. Stamp ids with minimal edits only.
3. **Validate before render.** A `validate` command exposed as an MCP tool (host agent's addition, so the agent can self-check) plus a watcher that marks a lesson invalid until it passes. Writes are atomic (temp file + rename).
4. **Renderers never see files.** The server serves the validated parsed AST + resolved assets through the postMessage host API, scoped to the current course and lesson. Iframes never touch the filesystem.
5. **Pinned, immutable versions.** `course.yaml` pins plugin and block-schema versions per published version. Published tags re-render deterministically. Schema migrations run only on draft to new version (this replaces the lazy migrate-on-load design in my earlier §4).
6. **Materializer cache key** = hash(plugin id, plugin version, block schema version, block content, relevant config). This extends the key in §4, which did not include block-schema version or config.
7. **Plugin split.** Plugin code is installed instance-wide by the admin. Enablement and config are per course and versioned with the blueprint.

### 7.3a Related work in progress

A separate session ("its-research") is researching intelligent tutoring systems, the student model and per-topic course types, writing `docs/research/intelligent-tutoring.md`. Course types may add IR requirements, e.g. a "pedagogy profile" in `course.yaml` that changes which blocks and exercise modes are allowed. Not yet reviewed by me; revisit this report once that file exists.

### 7.4 Open questions from this discussion
- For overlay blocks: is the source text authoritative, or only the AST? Current lean: store both; text is for debugging and for reuse of the validator.
- Do checkpoint pools live as one file per item or one per pool? Per-item diffs better; per-pool is simpler for agents.
- When a student's overlay anchors to a block whose content changed in a new version, drop, re-anchor or regenerate the overlay? Needs a policy; block-id stability only solves the unchanged case.
- If lint includes claim-to-chunk checks, who pays the LLM cost and when does it run (on save, on approve, on schedule)?

---

## 8. M0 eval spec: Markdoc vs directives (spec only, not run)

Purpose: decide, with data, whether the provisional Markdoc lock holds. This is the first engineering spike of milestone M0. **The full 648-generation design has not been run, and running it spends real API money, so it needs the user's explicit go-ahead on the budget in §8.6. A reduced pilot and a funded reduced run have been completed; see [ADR 0001](../adr/0001-markdoc-lesson-ir.md) (inconclusive).**

### 8.1 Question and scope

Does a current model write valid, schema-conformant, high-quality lessons in Markdoc at least as reliably as in remark-directive syntax, once a validate-and-repair loop is in place?

Out of scope for this spike: streaming UX, WYSIWYG, the ACP agent path (see §8.7), and any third format. A third arm (XML-ish tags) is cheap to add later if both arms fail.

### 8.2 Arms (the only variable is syntax)

| | **Arm M: Markdoc** | **Arm D: remark-directive** |
|---|---|---|
| Surface | `{% tag attr=… %}…{% /tag %}` | `:::name{attr=…}` containers, `::name{…}` leaves, `:name[…]{…}` inline |
| Structured payloads | typed attrs (arrays, objects) and child tags | scalar attrs; arrays/objects as fenced YAML in the body (best-effort grammar, written by us, not a strawman) |
| Validator | `Markdoc.validate` + JSON Schema on attrs + plugin `validate` | mdast walk + the same JSON Schema + the same plugin `validate`, plus a lint for silent failures (directive-looking text that parsed as prose) |
| Prompt | same task text, same source pack, same allowed-block list | same |
| Guidance | one syntax section + 2 canonical full-lesson examples | one syntax section + the same 2 examples translated; length within ±10% |
| Errors shown on repair | mapped to a shared vocabulary (`unknown-block`, `missing-attr`, `bad-value`, `unclosed`, `bad-citation`, …) with line numbers | same vocabulary |

Both arms generate from the same `BlockSpec` definitions (§4), so schemas, guidance text and fallbacks are identical. Examples and guidance are frozen before the first run and are not tuned per arm, except for the single prompt-iteration allowed in §8.5.

### 8.3 Prompt set (36 tasks)

Each task = concept + learner level + course layout + allowed block set + a **source pack** of 8 to 12 real chunks (about 300 tokens each, CC-BY/CC-BY-SA/public-domain texts such as Wikipedia, OpenStax, Project Gutenberg) tagged with outlet ids, + a **required-block checklist** (what must appear), + target length.

- **30 base tasks = 6 domains × 5 lesson shapes.**
  - Domains: math, programming, chess/strategy, language learning, history/humanities (outlets that genuinely disagree), natural science.
  - Shapes:
    - S1 Core + 2 perspectives + citations only.
    - S2 S1 + one visual plugin block (position, plot or animation spec).
    - S3 S1 + a **full exercise envelope** (id, isomorphGroup, skills, kind, cognitive, difficulty, scaffold, modes, hints L1 to L5, distractors with misconception tags, steps). This is the most attribute-dense block and the likeliest place the arms differ (see §9).
    - S4 `worked-example` with steps plus a faded exercise sharing the step schema.
    - S5 block-heavy: 6 or more distinct block types in a long (about 1,500-word) lesson.
- **6 adversarial tasks**, one each:
  1. Code samples containing literal `{% … %}` and `:::` in fenced and inline code.
  2. LaTeX with braces, colons and underscores.
  3. Attribute values with double quotes, backslashes, em dashes and non-Latin text.
  4. Nesting: perspective inside a callout inside a list.
  5. A request for a block that is **not installed** (correct behaviour: do not emit it, or use the documented fallback).
  6. Very long attribute strings (captions, hints) and many repeated blocks.

Fixtures and gold checklists are stored in the repo (`spikes/m0-lesson-format/`), so the run is reproducible.

### 8.4 Procedure

For each task × arm × model × 3 samples:

1. **Generate** once (streaming, no tools, no structured-output constraint on the body; the lesson is free text). Record the raw text and `usage`.
2. **Validate** with the arm's validator, producing diagnostics.
3. **Repair loop:** if errors, send them back as a user turn and ask for the full corrected lesson. Maximum 3 rounds. Record each round.
4. **Score** the final text automatically (below), then **judge** quality once (below).

Settings: models `claude-opus-5-5`, `claude-sonnet-5-5` (primary), `claude-haiku-5-5` (informational). Effort set explicitly to `medium` for all three, because defaults differ by model. Sampling parameters are not settable on these models, so the 3 samples capture natural variance. Prompt caching on for the shared system prompt and examples.

Total generations: 36 × 2 × 3 × 3 = **648**.

### 8.5 Metrics and pass/fail

Automatic metrics (per arm × model):

| # | Metric | Definition |
|---|---|---|
| M1 | First-pass valid | parses, passes schema and semantic checks with no repair |
| M2 | Final valid | valid within 3 repair rounds |
| M3 | Repair rounds | mean rounds to green (failures count as 3) |
| M4 | Dropped-block rate | lessons where a block on the gold checklist is **absent from the AST although its opening marker is in the text**, and the validator did not report it (the silent-failure case) |
| M5 | Semantic validity | every `cite.chunk` is in the pack, every `perspective.outlet` is known, plugin `validate` passes (legal FEN etc.) |
| M6 | Disallowed-block rate | emitted a block not in the allowed set |
| M7 | Output size | visible output tokens per lesson (counted with `count_tokens`) |

Quality metrics:

| # | Metric | Definition |
|---|---|---|
| Q1 | LLM-judge score | 1 to 5 on four rubric items (claims supported by cited chunks, perspective fidelity, coherence of the core, pedagogical fit). The judge sees a **format-normalised plain rendering** of the AST, so syntax cannot bias it. Judge is blind to arm. |
| Q2 | Human blind check | the user (or another human) compares 30 randomly chosen same-task pairs, arm hidden, and reports a preference. Also used to validate the judge: judge-vs-human agreement on these 30. |

**Statistics.** Pair arms by task (same prompt, same model). Use a cluster bootstrap over tasks (3 samples per task are not independent) for 95% intervals. With 36 tasks the study can only resolve differences of roughly 10 percentage points in a rate near 85 to 95%; this is my rough estimate, not a power calculation. Smaller gaps will be reported as ties.

**Thresholds are my proposal.** I have no external basis for these numbers; the user should adjust them before the run. Primary models are Opus 5.5 and Sonnet 5.5.

**Keep Markdoc if all hold on both primary models:**

| # | Criterion | Threshold |
|---|---|---|
| K1 | Final valid (M2) | ≥ 97% |
| K2 | First-pass valid (M1) | ≥ 80% |
| K3 | Mean repair rounds (M3) | ≤ 0.6 |
| K4 | Dropped-block rate (M4) | ≤ 1% |
| K5 | Relative to Arm D | upper 95% bound of (D − M) is ≤ 5 pp on M2 and ≤ 10 pp on M1 |
| K6 | Quality non-inferiority | Q1 mean (M − D) ≥ −0.2, lower 95% bound ≥ −0.3; Q2 preference within 35% to 65% counts as a tie |

Haiku 5.5 is reported but not gating; informal floor M1 ≥ 70% and M2 ≥ 93%.

**Decision rules:**

1. All of K1 to K6 pass → **keep Markdoc.**
2. K1 to K4 fail on Arm M only → one prompt-iteration is allowed (edit guidance and examples; re-run only the failing tasks; budget about $20). If it then passes → keep. If not → rule 3.
3. **Switch to directives** if Arm D passes K1 to K4 **and** beats Arm M by ≥ 8 pp on M1 **and** ≥ 3 pp on M2 on both primary models, with a bootstrap 95% interval excluding 0. The layering in §1 makes this a parser/printer swap.
4. Ties and mixed results → keep Markdoc (the validation advantage is measured; §1).
5. Both arms fail K1 to K4 → stop and reconsider (third arm, or JSON blocks for the dense exercise envelope only).

### 8.6 Cost estimate (needs approval)

Prices from the Claude API skill's cached table (2026-10-06): Opus 5.5 $4 / $20 per million input / output tokens, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 (prompts up to 100K). Output includes thinking tokens, which bill as output. **All token counts below are my assumptions and should be replaced by measurements from a pilot.**

Assumptions per generation: first pass 7.5k input (guidance + examples + source pack + task) and 5.5k output (about 2.5k visible lesson + 3k thinking). About 30% of generations need repair, averaging 1.3 rounds at +15k input (history) and +4k output per failing generation. Average per generation: **12k input, 6.7k output**. Each model gets 216 generations: 2.6M input, 1.45M output.

| Item | Calculation | Cost |
|---|---|---|
| Generation, Opus 5.5 | 2.6M × $4 + 1.45M × $20 | ≈ $39 |
| Generation, Sonnet 5.5 | 2.6M × $2 + 1.45M × $10 | ≈ $20 |
| Generation, Haiku 5.5 | 2.6M × $0.10 + 1.45M × $0.50 | ≈ $1 |
| LLM judge (Opus 5.5, 648 outputs) | 8k in + 0.8k out each → 5.2M × $4 + 0.52M × $20 | ≈ $31 |
| **Subtotal** | | **≈ $91** |
| Contingency (+25%) | | ≈ $23 |
| **Budget to request** | hard cap $150 | **≈ $115** |

- **Pilot first:** 12 tasks × 2 arms × 3 models × 1 sample = 72 generations, no judge: about $7. Use it to replace the token assumptions above, then re-quote the full run before spending it.
- Batch API (50% discount) could roughly halve the first-pass share, but repairs are sequential, so v1 does not rely on it.
- Human time: about an hour for the 30 blind pairs.

### 8.7 What this eval does not tell us

- **The production path is an ACP agent writing files with a validate tool, not a single API call.** Agents with file tools, self-validation and many turns may fix syntax errors that a one-shot call cannot. This eval measures the harder, cheaper proxy. Follow-up (not estimated): about 12 tasks per arm through one ACP agent (e.g. Claude Code) in a scratch course directory with the `validate` tool available.
- Reliability for non-Anthropic models (Codex, Gemini, local) is untested. Add them if the platform will support them in v1.
- Streaming behaviour (tail repair) and human editing are separate spikes.

---

## 9. Requirements implied by `intelligent-tutoring.md`

Reviewed `docs/research/intelligent-tutoring.md` (read in full, 2026-10-09). This section lists only what changes the lesson IR or the plugin contract. I did not re-verify its learning-science claims.

### 9.1 Summary

| # | Requirement from the tutoring report | IR / contract consequence | Section |
|---|---|---|---|
| 1 | **Pedagogy profile** in `course.yaml` (`profile: strategy@1`, overrides); node `kind` in `graph.yaml` | Profile `lessonTemplate` is a third source of authoring guidance, next to the layout plugin's and the blocks'. Profile also supplies **document-level lint rules**. Validation context must include the lesson's graph node (kind, skills). | 9.2 |
| 2 | Every lesson ends with 2 to 4 retrieval items; the generator lint fails a lesson with none | A declarative **structural lint** (not per-block `validate`) | 9.2 |
| 3 | Exercise `Item` with ~20 fields; `key` server-only; hints L1 to L5; distractors with misconceptions; steps | Exercise is a **two-level schema**: platform-owned envelope + plugin-owned payload. Visibility needs timing, not just server-only. | 9.3, 9.4 |
| 4 | `worked-example` with `steps[]`; faded variants share the step shape | New core block; `step` schema shared with exercises | 9.5 |
| 5 | Misconception tags on distractors, steps and rubric levels | Per-skill **misconception registry** in `graph.yaml`; cross-reference validation | 9.6 |
| 6 | `isomorphGroup`, `scaffold`, `skills[]` with weights, `difficulty.b` | Stable ids and group ids in the text; adaptive layer substitutes variants by group | 9.3 |
| 7 | `fact` nodes need item-level FSRS (decks of many cards) | Bulk items should not be Markdoc in lessons: **deck files** | 9.7 |
| 8 | `rubric` + teacher-scored anchors | Rubric files in the blueprint; anchors server-visible; `rubric` is a validated reference | 9.8 |
| 9 | Hints must be verified against the key; ladder rate-limited | Hint text is `gated` content, released by the server per level | 9.4 |
| 10 | `perspective` in a creative profile means exemplars from different masters | Role vocabulary may need `exemplar` (extends open question 3 in §6) | 9.9 |

### 9.2 Pedagogy profile in the IR

- **Guidance composition order** for the agent prompt: platform base rules → profile `lessonTemplate` (section order for this profile and node kind) → layout plugin guidance → block guidance for allowed blocks. All of it is pinned by `course.yaml`, so published versions stay reproducible.
- **Document-level lint**, declared as data in the profile (plugins may contribute profiles, per the tutoring report), checked by the validator after block validation:

```ts
interface LessonLintRule {
  id: string                               // 'ped/retrieval-items-at-end'
  appliesTo: { kinds?: NodeKind[] }        // by graph node kind
  require?: { block: string; where?: Record<string, Json>; min?: number; max?: number; position?: 'start' | 'end' | 'any' }[]
  order?: string[]                         // e.g. ['worked-example', 'exercise'] must appear in this order
  severity: 'error' | 'warning'
}
```

  Example: for `kind: concept`, require 2 to 4 `exercise` blocks with `modes` containing `practice`, positioned at the end. Errors go back to the agent through the same repair loop as block errors.
- **Validation context** now includes the graph node: `ValidationContext { node: GraphNode; profile: PedagogyProfile; sources: ChunkSet }`. Without it, `skills[]` and `kind`-dependent rules cannot be checked.
- Profiles are versioned data pinned in `course.yaml`. Changing a profile is a new course version, like a plugin upgrade.

### 9.3 Exercise as a two-level schema

The tutoring report's `Item` mixes platform concerns (skills, difficulty, scaffold, modes, provenance) with plugin concerns (`prompt`, `key`, `steps[].key`). Since mastery, gating and Review depend on the first group, the platform must own it:

| Level | Owner | Fields | Validated by |
|---|---|---|---|
| **Envelope** | platform (core block `exercise`) | `id`, `isomorphGroup`, `skills[]{id,weight,role}`, `kind`, `cognitive`, `difficulty`, `scaffold`, `fadedSteps`, `modes`, `expectedTimeSec`, `confusableWith`, `cites`, `rubric`, `provenance` | core JSON Schema + cross-references (skill ids in `graph.yaml`, cited chunks in the retrieval set) |
| **Payload** | exercise plugin (`itemSchema`) | `prompt`, `key`, `steps[].key`, engine or test config | plugin JSON Schema + `validateItem` |

Authoring shape in a lesson file (Markdoc; hints, distractors and steps as typed **child tags** instead of giant attribute arrays, which keeps diffs readable and makes each hint a separate, greppable node):

````markdoc
{% exercise id="e1" type="mcq" group="fork-recognize-1" kind="mcq" cognitive="recognize"
   skills=[{id: "chess.tactics.fork.knight", weight: 1, role: "target"}]
   difficulty={b: 0.0, source: "llm"} scaffold="independent" modes=["practice"] %}
{% prompt %}Which squares does a knight on c7 attack that matter in the diagram?{% /prompt %}
{% choice id="a" correct=true %}e8 and a8{% /choice %}
{% choice id="b" misconception="chess.misc.knight-moves-straight" %}d8 and b8
{% feedback %}Knights never move along a line.{% /feedback %}{% /choice %}
{% hint level=1 %}What is the knight attacking from c7?{% /hint %}
{% hint level=2 %}Review "Knight moves" in the previous section.{% /hint %}
{% /exercise %}
````

(Illustrative; exact child-tag names are to be fixed by the M0 eval and the exercise plugin contract.) Markdoc's `children` constraints can enforce which child tags an `exercise` accepts. In the directive arm, the same data would be a YAML body, so S3 tasks in §8.3 are where the arms are most likely to differ.

Division of authoring responsibility, as a proposal: the agent writes envelope + payload for **formative** inline items and for **checkpoint pool** files; **practice** variants generated per student are DB rows produced through the same schemas and the same validator, anchored to the lesson's seed item by `isomorphGroup`.

### 9.4 Visibility: from "server" to a release schedule

My answer-key rule (§5) marked fields `x-visibility: server` (never sent). The tutoring report adds fields that are secret **until an event**: hint text (until the learner requests that level), `distractor.feedback` and `explain` (until graded), checkpoint feedback. Extend the annotation:

```ts
// on any attr, child tag or payload field in a schema
'x-visibility': 'client' | 'server'                          // default 'client'
'x-release'?: 'on-hint:1' | 'on-hint:2' | /* … */ | 'after-attempt' | 'after-grade'   // only meaningful with 'server'
```

Audiences and what each sees:

| Audience | Sees |
|---|---|
| Student client / iframe | `client` fields always; `server` fields only after their release event, delivered by the server per event, never in the initial AST |
| Tutor LLM context | the student view, **plus** the key only through the server-side verification path, and never for the active Checkpoint or Diagnostic item (the tutoring report's mode table, §5.2) |
| Grader | everything, server-side |
| Teacher (RBAC) | everything in review and item-analysis views |

Rate-limiting the hint ladder, the evidence discount (`e = x·(1−h)`) and releasing `bottom-out` are platform behaviours; the IR only has to carry `level`, which is why `hint` is a typed child tag with a closed `level` enum 1 to 5.

Open point for the tutoring report's owner: it lists `hints` as pre-authored, which multiplies agent output per item by up to five hints. Authoring L1 and L2 in the file and generating L3 to L5 on demand (server-side, verified against the key) would cut generation cost and the number of leak surfaces. Not decided here.

### 9.5 `worked-example` and `step`

Add to the **core vocabulary** (§6 open question 3): `worked-example` (container) containing ordered `step` tags, each with `id`, optional `skills`, optional `misconception`, and a body. Reuse the same `step` schema inside `exercise` payloads so the adaptive layer can turn a worked example into a faded exercise (hide steps k..n) mechanically. This is a pedagogy-neutral semantic block: layouts decide whether steps render as a stepper, a board with moves, or a plain list.

### 9.6 Misconception registry

- The tutoring report uses misconception ids on distractors, steps and rubric levels, and returns `misconceptionsDetected[]`. For these to be useful they must be **stable ids defined once**, not free text.
- Proposal: `graph.yaml` nodes carry `misconceptions: [{id, label, description}]`. The validator checks that every `misconception=` attr resolves to a registry entry for one of the exercise's skills. Unknown ids are an **error** in checkpoint pools and a **warning** in practice items, with an agent tool to propose a new registry entry (teacher approves in the blueprint diff).
- A core inline/leaf block `{% misconception id=… %}` ("common mistake") lets lesson prose and remedial segments reference the same ids, so the adaptive layer can find the right re-explanation.

### 9.7 Bulk items: decks outside Markdoc

`fact` nodes use item-level FSRS (tutoring report §2.2); a vocabulary lesson can have 50 or more cards. Writing each as an `exercise` tag in a lesson file bloats the lesson and the agent output. Proposal: a lesson references a **deck file** (`decks/<name>.jsonl`, one item per line, validated against the exercise plugin's `itemSchema` and the envelope) via `{% deck ref="decks/spanish-greetings.jsonl" mode="practice" /%}`. Deck files live in the course repo, are diffable, and are validated by the same pipeline. This is the one place where I recommend **not** using Markdoc; the format question for decks is open.

### 9.8 Rubrics

Rubrics (dimensions, level descriptors, teacher-scored anchors) are blueprint files (`rubrics/*.yaml`) referenced by `rubric="rubrics/…"`. The validator checks the reference and that each dimension maps to a skill. Anchors are **server-visible**; whether students may see exemplars is a profile decision (the creative profile probably yes, the checkpoint grader context no).

### 9.9 Smaller points

- **`perspective.role` vocabulary.** The creative profile uses perspectives as exemplars from different masters. Add `exemplar` to the closed enum; keep the enum platform-owned.
- **Lesson frontmatter** gets `kind` implicitly from `graph.yaml`; avoid duplicating it in the text (one source of truth).
- **xAPI keys.** Statements are keyed by `(item id, isomorphGroup, course version)`. Item ids must therefore be stamped once and never reformatted (rule 1 and 2 of §7.3 already cover this).
- **Isomorph variants and the overlay.** Overlay rows are anchored by block id (§7). Variant substitution anchors to `isomorphGroup`, not to a single block, so a group needs its own id namespace.
- **Eval impact.** The exercise envelope is much denser than the sample lesson's one `exercise` tag. §8.3 S3 and S4 tasks were added for this reason, and the M0 result may differ by block (Markdoc may win on the envelope and lose nowhere, or the reverse).

### 9.10 Disagreements and cautions

1. **`Item` as plain JSON.** In the tutoring report, `prompt: Json` and `key: Json` suggest items are JSON documents. In the course repo, items are authored as Markdoc blocks (or decks) and parsed to that shape. The JSON `Item` is the AST/DB form, not the authoring form.
2. **Plugin-contributed profiles with lint rules** can accumulate conflicting constraints. Profiles should be a closed schema (data only, no code), and a course resolves to exactly one profile version.
3. **Validation cost.** Adding profile lint, misconception resolution, skill resolution, `validateItem` (including running reference solutions for code items in a container) and cite checks makes validation heavier than the Markdoc parse. It must run in the repair loop and in the save gate; budget for latency, and cache per block hash.
4. **Coupling.** If the M0 eval switches us to directives, §9.3's child-tag authoring shape changes to YAML bodies. The two-level schema, visibility schedule and registries are syntax-independent.

---

## Sources

- Karpathy, ["llm-wiki" gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (primary source for §7.2)
- Drift under incremental context (background only): [arXiv 2505.16894](https://arxiv.org/abs/2505.16894v1)
- Markdoc: [docs](https://github.com/markdoc/docs) (via Context7 `/markdoc/markdoc`), `@markdoc/markdoc` on npm
- remark-directive and micromark-extension-directive: [repo](https://github.com/remarkjs/remark-directive) (via Context7)
- Portable Text: [spec repo](https://github.com/portabletext/portabletext), [`@portabletext/types`](https://npmjs.com/package/@portabletext/types)
- MDX security: [CVE-2026-0969, next-mdx-remote](https://nvd.nist.gov/vuln/detail/CVE-2026-0969)
- A2UI: [Google Developers Blog](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/), [a2ui.org](https://a2ui.org/)
- Streaming Markdown: [Chrome: render streamed LLM responses](https://developer.chrome.com/docs/ai/render-llm-responses), [Streamdown termination](https://streamdown.ai/docs/termination), [remend](https://vercel.com/changelog/new-npm-package-for-automatic-recovery-of-broken-streaming-markdown)
- Output-format effects: [LREC 2026 "Format Matters"](https://aclanthology.org/2026.lrec-1.593/), ["Let Me Speak Freely?"](https://hub.athina.ai/research-papers/let-me-speak-freely-a-study-on-the-impact-of-format-restrictions-on-performance-of-large-language-models) (summary page)
- cordis: Context7 mirror (`/acryldev/cordis-meta-framework-spatiotemporal-composability`), medium reputation
- Package versions and dates: `npm view` run 2026-10-09
