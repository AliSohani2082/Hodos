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
| `results/<run>/` | `run.json` and `report.md` are committed. Raw `generations.jsonl` is not (see `.gitignore`). |

## Free commands (no API calls)

```
bun install
bun test                          # 170+ tests: validators, parity, prompts, runner, budget guard, decision rules
bun run typecheck
bun run src/cli.ts check          # gold lesson of all 36 tasks is valid in both arms, with identical trees
bun run src/cli.ts quote          # cost estimate from measured prompt sizes
bun run src/cli.ts stub           # whole pipeline against an offline stub; writes results/_stub (ignored)
bun run src/cli.ts report --run _stub
```

## Spending money

Put the key in `.env` (untracked; see `.env.example`). Bun loads it automatically. Nothing below runs without an explicit `--cap-usd`, and the full run needs `--confirm-full` on top. The cap is cumulative for a run directory, so restarting never resets it.

1. **Smoke test** (well under $0.01): `bun run src/cli.ts smoke --cap-usd 0.05`. Confirms credentials and that the exact request shape (adaptive thinking, `effort: medium`, cache breakpoints, streaming) is accepted.
2. **Pilot** (about $7 per the ticket): `bun run src/cli.ts run --tasks pilot --cap-usd 7`. 12 tasks × 2 arms × 3 models × 1 sample = 72 generations, no judge. Then `bun run src/cli.ts count` (free, rate-limited) and `bun run src/cli.ts report`.
3. **Re-quote.** The report replaces the spec's token assumptions with measured ones and prints a quote for the full run. §8.6 requires this before the full run.
4. **Approval.** The full run is 648 generations plus 648 judgments, hard cap $150. Adjust `THRESHOLDS` in `src/stats.ts` **before** this step if you disagree with the §8.5 proposals; changing them after seeing results defeats the point.
5. **Full run**: `bun run src/cli.ts run --tasks all --cap-usd <approved> --confirm-full`, then `judge --cap-usd <n>`, then the blind check (`q2 export`, a human fills `results/full/q2-answers.json`, `q2 score`), then `report`.
6. **Record the verdict** in an ADR (copy `docs/adr/0000-template.md`) and link the report.

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
- **Caching and cost.** Breakpoints on the system prompt and the first user turn. Cost is computed from `usage` with the skill's price table. **Assumptions to verify against the Console after the pilot:** cache writes at 1.25× input, and the Haiku 5.5 cache-read rate at 0.1× input.
- **No refusal fallbacks.** The server-side fallback would swap in another model and contaminate the per-model results. A refusal is recorded as a failure.
- **Whole-answer code fences** are unwrapped (`extractLesson`), the same for both arms.
- **Pilot subset.** One base task per domain, covering all five shapes and all visual blocks except `timeline`, plus the six adversarial tasks.

## What this does not tell us

Everything in `lesson-ir.md` §8.7 still holds: this is a single API call plus repair, not an agent with file tools; only Anthropic models; no streaming or editing behaviour. Source packs are plain-text Wikipedia extracts, so maths-heavy chunks were filtered out; the model writes the formulas itself. Guidance and examples were written by one author, with equal care but no independent review.
