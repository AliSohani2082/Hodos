# Spike (a): lesson format reliability

**Question.** Does a current model write valid, schema-conformant, high-quality lessons in Markdoc at least as reliably as in remark-directive syntax, once a validate-and-repair loop is in place?

Markdoc is the provisional lesson IR in [PRD LS-2](../../docs/PRD.md). The [eval spec](../../docs/research/lesson-ir.md#8-m0-eval-spec-markdoc-vs-directives-spec-only-not-run) defines 36 tasks, two syntax arms, three Anthropic models, three samples per cell, and up to three repairs. The same neutral tree, JSON Schemas, and semantic checks score both arms. The [runbook](RUNNING.md) describes the harness and all commands.

## Reproduce the offline checks

From this directory, run `bun install` and then `bun run offline`. That one command runs the tests, typecheck, all 36 gold lessons in both syntaxes, and a 72-generation stub run that writes `results/_stub/report.md` and `results/_stub/results.csv`. Stub results are synthetic and cannot answer the reliability question. Fixtures and prompts are committed here; source attribution is in [fixtures/ATTRIBUTION.md](fixtures/ATTRIBUTION.md).

## Live run and budget

The pilot is 12 tasks × 2 arms × 3 models × 1 sample, quoted at about $7.06 before live measurements. The full run is 648 generations plus quality judging. Both require separate explicit budget approval. The CLI requires `--cap-usd`, refuses a cap above $150, and counts recorded spend across run directories. Put an approved `ANTHROPIC_API_KEY` in an untracked `.env` based on [.env.example](.env.example); never commit it. See [RUNNING.md](RUNNING.md) for smoke, pilot, full-run, scoring, and blind-check instructions.

## Status and decision

The 36-task set and offline harness are complete. **PENDING:** the API key, pilot approval, measured pilot, separate full-run approval, full-run results, human blind check, and go/no-go. The decision record is [ADR 0001](../../docs/adr/0001-markdoc-lesson-ir.md), currently a skeleton. The user chose the spec's Anthropic-only design and unchanged K1–K6 thresholds before any live run; non-Anthropic reliability remains untested.
