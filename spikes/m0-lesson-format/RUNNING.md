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
| `src/runner.ts`, `src/cost.ts`, `src/credits.ts` | The resumable loop, local pre-call reservation, and independent OpenRouter account/key budget checks. |
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

The authorized OpenRouter key is stored as `OPENROUTER_API_KEY` in the ignored `.env`. The completed smoke and pilot cost **$3.24134741** under their old $4.50 approval. A separate approval now caps **all new spend at $19.00**. The runner subtracts the verified pilot baseline from its local ledger and reserves the maximum completion cost before every paid call. It also checks `GET /api/v1/credits` against the user-specified `total_usage` stop point **26.3976** and `GET /api/v1/key` for the effective key budget, before every call and during streaming. Run paid commands one process at a time; the local ledger does not coordinate separate processes.

The client uses OpenRouter's [OpenAI-compatible chat completion endpoint](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) with Anthropic model IDs (for example [`anthropic/claude-opus-5.5`](https://openrouter.ai/anthropic/claude-opus-5.5)). It requests streaming usage and cost via `usage: {include: true}`; the ledger takes actual per-call dollars from `usage.cost`.

1. **Reduced pilot (completed)**: six base tasks × two arms × three models × one sample = 36 generations. Its 10-output spot-check, report, CSV and compressed raw generations are committed under `results/pilot/`.
2. **Funded reduced evaluation (interrupted)**: `bun run src/cli.ts run --tasks reduced-full --models claude-opus-5-5,claude-sonnet-5-5 --samples 1 --run full --confirm-full --cap-usd 19 --concurrency 1`. The [pre-run quote](results/full/plan.md) scales pilot cost to $16.00 for 30 tasks and leaves 18.8% headroom. This command is resumable and skips completed generations. Both syntax arms' first calls are reserved as a pair.
3. **Current blocker**: after 16 successful generations ($2.17704970 actual new spend), the existing key's effective $2 budget caused HTTP 403. [Reconciliation](results/full/403-reconciliation.md) records the 53 rejected, unbilled attempts and the provider ledger check. **Do not resume paid calls until the key budget has been raised or a replacement key has been placed in the ignored `.env`, and the coordinator confirms it.** The account itself had funds at the interruption.
4. Once unblocked, resume the command in step 2. If headroom remains, `--tasks all` with the same model, sample, run and cap flags adds the six omitted task pairs. Then run `bun run src/cli.ts count --run full`, `bun run src/cli.ts report --run full`, and `bun run src/cli.ts q2 export --run full --pairs 30 --model claude-opus-5-5`. The judge runs only if a complete, balanced Q1 comparison fits the remaining $19 budget; it is currently disabled in the CLI. A person must read `q2-pairs.md`, fill `q2-answers.json`, and keep `q2-key.json` hidden until finished. Record measured limits and the verdict or explicit inconclusive finding in [ADR 0001](../../docs/adr/0001-markdoc-lesson-ir.md).

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
- **Pilot subset.** One base task per domain, covering all five shapes and all visual blocks except `timeline`; the six adversarial tasks were omitted to fit the original pilot cap.

## What this does not tell us

Everything in `lesson-ir.md` §8.7 still holds: this is a single API call plus repair, not an agent with file tools; only Anthropic models; no human editing behaviour. This funded pilot omits all 6 adversarial tasks and uses only 6 of the original 12 pilot tasks, so it cannot provide the planned full-run decision. Source packs are plain-text Wikipedia extracts, so maths-heavy chunks were filtered out; the model writes the formulas itself. Guidance and examples were written by one author, with equal care but no independent review.
