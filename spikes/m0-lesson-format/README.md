# Spike (a): lesson format reliability

**Question.** Does a current model write valid, schema-conformant, high-quality lessons in Markdoc at least as reliably as in remark-directive syntax, once a validate-and-repair loop is in place?

Markdoc is the provisional lesson IR in [PRD LS-2](../../docs/PRD.md). The [eval spec](../../docs/research/lesson-ir.md#8-m0-eval-spec-markdoc-vs-directives-spec-only-not-run) defines 36 tasks, two syntax arms, three Anthropic models, three samples per cell, and up to three repairs. The same neutral tree, JSON Schemas, and semantic checks score both arms. The [runbook](RUNNING.md) describes the harness and all commands.

## Reproduce the offline checks

From this directory, run `bun install` and then `bun run offline`. That one command runs the tests, typecheck, all 36 gold lessons in both syntaxes, and a 72-generation stub run that writes `results/_stub/report.md` and `results/_stub/results.csv`. Stub results are synthetic and cannot answer the reliability question. Fixtures and prompts are committed here; source attribution is in [fixtures/ATTRIBUTION.md](fixtures/ATTRIBUTION.md).

## Live run and budget
The paid runs are done and their spend is recorded. The smoke call and reduced pilot cost about $3.24 under the original $4.50 approval. A later approval capped all new spend at **$19.00** (`approvedCap` in `src/spend.ts` rejects anything above that). `OPENROUTER_API_KEY` is stored in the ignored `.env`. See [RUNNING.md](RUNNING.md) for commands, spend accounting and limitations.

## Status and decision

The 36-task set and offline harness are complete. The reduced pilot finished, and the funded reduced evaluation stopped at 117 of 120 cells (about $15.63 of the $19.00 cap) when the user directed a stop. The Q1 judge, the Q2 human check, Haiku cells and the extra samples were not run, so the outcome is **INCONCLUSIVE**: see [RUNNING.md](RUNNING.md), the [full report](results/full/report.md) and [ADR 0001](../../docs/adr/0001-markdoc-lesson-ir.md). The user chose the spec's Anthropic-only design and unchanged K1–K6 thresholds; non-Anthropic reliability remains untested.
