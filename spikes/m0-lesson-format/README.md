# Spike (a): lesson format reliability

**Question.** Does a current model write valid, schema-conformant, high-quality lessons in Markdoc at least as reliably as in remark-directive syntax, once a validate-and-repair loop is in place?

Markdoc is the provisional lesson IR in [PRD LS-2](../../docs/PRD.md). The [eval spec](../../docs/research/lesson-ir.md#8-m0-eval-spec-markdoc-vs-directives-spec-only-not-run) defines 36 tasks, two syntax arms, three Anthropic models, three samples per cell, and up to three repairs. The same neutral tree, JSON Schemas, and semantic checks score both arms. The [runbook](RUNNING.md) describes the harness and all commands.

## Reproduce the offline checks

From this directory, run `bun install` and then `bun run offline`. That one command runs the tests, typecheck, all 36 gold lessons in both syntaxes, and a 72-generation stub run that writes `results/_stub/report.md` and `results/_stub/results.csv`. Stub results are synthetic and cannot answer the reliability question. Fixtures and prompts are committed here; source attribution is in [fixtures/ATTRIBUTION.md](fixtures/ATTRIBUTION.md).

## Live run and budget

The user approved an OpenRouter smoke call and a **reduced pilot** within a hard cumulative cap of **$4.50**. The reduced pilot runs 6 base tasks (one per domain) × 2 arms × 3 models = 36 first-pass generations; it omits the 6 adversarial tasks from the original 12-task pilot. The full $150 run and judging are not approved or funded. `OPENROUTER_API_KEY` is stored in the ignored `.env`; the CLI refuses a cap above $4.50 and counts recorded spend across run directories. See [RUNNING.md](RUNNING.md) for commands and limitations.

## Status and decision

The 36-task set and offline harness are complete. OpenRouter pilot authorization is in place; **PENDING:** smoke, reduced-pilot results and spend, full-run approval, full-run results, human blind check, and go/no-go. The decision record is [ADR 0001](../../docs/adr/0001-markdoc-lesson-ir.md). The user chose the spec's Anthropic-only design and unchanged K1–K6 thresholds; non-Anthropic reliability remains untested.
