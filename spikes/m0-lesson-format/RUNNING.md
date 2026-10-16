# Running the lesson-format eval

Harness for ALI-37, spike (a): does Markdoc stay the lesson IR? It implements the eval specified in [`lesson-ir.md` §8](../../docs/research/lesson-ir.md): 36 tasks, two arms that differ only in surface syntax, three models, a validate-and-repair loop of up to 3 rounds, metrics M1–M7, and the keep/switch rules in §8.5.

Everything is TypeScript on Bun. It is throwaway code: nothing in `spikes/` is imported by the app.

## Layout

| Path | What it is |
|---|---|
| `src/blocks.ts` | The `BlockSpec` registry: JSON Schemas, guidance and one canonical example per syntax. The single source of truth for both arms. |
| `src/parse-markdoc.ts` | Arm M front end: `Markdoc.parse` + `Markdoc.validate` against a config generated from the specs. |
| `src/parse-directive.ts` | Arm D front end: remark-directive, the YAML-body grammar, and the silent-failure lints. |
| `src/shared-validate.ts` | Schema, nesting, id and plugin checks, run on the neutral tree so both arms get identical checks. |
| `prompts/` | Frozen base rules, one syntax section per arm, two translated example lessons per arm. |
| `fixtures/packs/` | 36 source packs: real Wikipedia text (CC BY-SA 4.0), 8–12 chunks each. `fixtures/ATTRIBUTION.md` lists the articles and revisions. |
| `src/tasks.ts` | The 36 tasks (30 base + 6 adversarial), gold checklists, literal and nesting checks, the 12-task pilot subset. |
| `src/runner.ts`, `src/cost.ts` | The loop, resumable, with a budget guard that reserves each call's worst case before sending. |
| `src/score.ts`, `src/stats.ts`, `src/report.ts` | M1–M7 and extras, cluster bootstrap, rules K1–K6 and 1–5, the report. |
| `src/judge.ts`, `src/q2.ts` | Q1 LLM judge on a format-normalised rendering; Q2 blind human check. |
| `src/print.ts`, `src/synth.ts`, `src/stub.ts` | Printers for both syntaxes, gold lessons, and an offline stub model. |
| `src/llm.ts` | OpenRouter streaming chat client; model usage and actual cost are recorded from OpenRouter's response. |
| `results/<run>/` | `run.json`, `report.md`, and `results.csv` are report artifacts. Raw `generations.jsonl` is ignored (see `.gitignore`). |

## Free commands (no API calls)

```
bun install
bun run offline                   # one command: tests, typecheck, gold parity, stub run, stub report + CSV
bun test                          # 170+ tests: validators, parity, prompts, runner, budget guard, decision rules
bun run typecheck
bun run src/cli.ts check          # gold lesson of all 36 tasks is valid in both arms, with identical trees
bun run src/cli.ts quote          # cost estimate from measured prompt sizes
bun run src/cli.ts stub           # whole pipeline against an offline stub; writes results/_stub (ignored)
bun run src/cli.ts report --run _stub
```

## Spending money

The authorized OpenRouter key is stored as `OPENROUTER_API_KEY` in the ignored `.env`. The approved cumulative cap is **$4.50 including smoke and reduced pilot**. The CLI enforces this as its hard ceiling, reads actual costs from OpenRouter usage data, and reserves the maximum completion cost at published OpenRouter model rates before each request. Run paid commands one at a time; the local spend ledger does not coordinate separate processes. The full run and judging are disabled because they are not approved or funded.

The client uses OpenRouter's [OpenAI-compatible chat completion endpoint](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) with Anthropic model IDs (for example [`anthropic/claude-opus-5.5`](https://openrouter.ai/anthropic/claude-opus-5.5)). It requests streaming usage and cost via `usage: {include: true}`; the ledger takes actual per-call dollars from `usage.cost`.

1. **Smoke test**: `bun run src/cli.ts smoke --cap-usd 4.50`. This reserves before calling and records OpenRouter's actual usage cost.
2. **Reduced pilot**: `bun run src/cli.ts run --tasks pilot --cap-usd 4.50`. It uses 6 base tasks (one per domain) × 2 arms × 3 models = 36 first-pass generations, with up to 3 repair rounds. The 6 adversarial tasks are omitted from the original 12-task pilot to fit the approved cap. Both arms' first call for a task/model pair are reserved together; if the remaining budget cannot cover both, neither starts. Afterward run `bun run src/cli.ts count` (local visible-token estimates) and `bun run src/cli.ts report`.
3. The full run is **not approved or funded**. Do not start generation, judging or Q2 work. ALI-49 remains blocked pending a separate approval and budget.
4. Record the pilot numbers and limitations in [ADR 0001](../../docs/adr/0001-markdoc-lesson-ir.md); it must remain explicitly a reduced pilot, not a go/no-go result.

If rule 2 fires (Markdoc fails K1–K4), one prompt iteration is allowed (budget about $20): edit `prompts/`, re-run only the failing tasks (`--tasks id1,id2 --run <new run name>`), and pass `--iteration-used` to `report` once it has been spent, so rule 3 can apply.

## Choices that go beyond or interpret the spec

These are where a reviewer should push back.

- **Neutral tree.** Each arm parses to the same tree, then one JSON Schema and one semantic validator run on it. `bun run src/cli.ts check` proves the gold lesson of every task normalises to an identical tree in both syntaxes, so neither arm can express more than the other.
- **Directive structured payloads.** Scalars are attributes; anything structured, and long text, goes in a leading fenced YAML block, which makes the block a container. Markdoc uses typed attributes and, for exercises, child tags (§9.3). This is the "best-effort grammar, not a strawman" of §8.2.
- **Arm D is not a strawman, and some leniency favours it.** Unclosed containers, stray closing fences, directive-looking prose and dangling `{` are linted into diagnostics. Bare unknown text directives (`12:30`, `x:y`) are restored as prose instead of flagged. A pro-D bias makes a "keep Markdoc" result more conservative.
- **Markdoc's built-in tags** (`if`, `table`, …) are not part of the lesson vocabulary and are reported as unknown blocks. Literal `{% %}` in a fenced code sample needs `{% process=false %}` on the fence; the Markdoc guidance teaches it. Adversarial task 1 tests exactly this.
- **The checklist is not in the validator.** If it were, a dropped block would always be reported and M4 would be zero by construction. The checklist is scored separately ("checklist met"). M4 counts a block on the checklist whose opener is in the text, absent from the AST, with no diagnostic on that block or within one line of the marker. This is a heuristic.
- **Extra metrics** beyond M1–M7: checklist met; literal fidelity (decoded attribute and code values on the adversarial tasks); required nesting (adv 4); M4-any (dropped, reported or not).
- **Guidance length.** Syntax section plus examples is within 1% across arms, the whole system prompt within 1%, examples within 8%. The directive syntax section alone is 20% longer, because YAML bodies, quoting and the colon-count rule need teaching. That is reported, not padded away.
- **Statistics.** Percentile bootstrap (10,000 resamples, fixed seed) over tasks, pairing arms by task. K5 uses the upper end of the two-sided 95% interval, the conservative reading of "upper 95% bound". Rule 3 requires the interval to exclude 0, so 3 differing tasks out of 36 is not enough.
- **Prompt assembly.** Block guidance is assembled per task from the allowed set, as the platform would. The two example lessons are fixed and use blocks a course may not have; the prompt says so.
- **Caching and cost.** OpenRouter receives explicit prompt-cache markers. Actual cost comes from OpenRouter's `usage.cost`; published model rates are used only for the reserve-before-call guard. Visible output-token M7 is estimated locally because the OpenRouter chat API does not provide a count-only endpoint.
- **No refusal fallbacks.** The server-side fallback would swap in another model and contaminate the per-model results. A refusal is recorded as a failure.
- **Whole-answer code fences** are unwrapped (`extractLesson`), the same for both arms.
- **Pilot subset.** One base task per domain, covering all five shapes and all visual blocks except `timeline`, plus the six adversarial tasks.

## What this does not tell us

Everything in `lesson-ir.md` §8.7 still holds: this is a single API call plus repair, not an agent with file tools; only Anthropic models; no human editing behaviour. This funded pilot omits all 6 adversarial tasks and uses only 6 of the original 12 pilot tasks, so it cannot provide the planned full-run decision. Source packs are plain-text Wikipedia extracts, so maths-heavy chunks were filtered out; the model writes the formulas itself. Guidance and examples were written by one author, with equal care but no independent review.
