# ADR-0001: Markdoc as the lesson IR

| | |
|---|---|
| **Status** | Proposed — reduced pilot complete; full evaluation pending |
| **Date** | 2026-10-16 (pilot evidence; decision date pending) |
| **Spike** | M0 (a), [lesson format reliability](../../spikes/m0-lesson-format/README.md) |
| **Issue** | [ALI-37](https://linear.app/ali-inc/issue/ALI-37) |
| **Amends** | PENDING verdict. If directives win, the M0 exit review must amend PRD LS-2 and Appendix A decision 8. |

## Question

Does a current model write valid, schema-conformant, high-quality lessons in Markdoc at least as reliably as in remark-directive syntax, once a validate-and-repair loop is in place?

## Context

[PRD LS-2](../PRD.md) provisionally chooses Markdoc for lesson source text. Every agent-written lesson passes through this syntax. The [research spec §8](../research/lesson-ir.md) defines the comparison and its decision rules. A format change is designed to affect the parser and printer; exercise authoring details may also need revision.

## Options considered

| Option | For | Against |
|---|---|---|
| Keep Markdoc | Typed attributes, explicit closing tags, and validator diagnostics are available. | Literal template syntax in fenced code needs `process=false`; live LLM reliability is pending. |
| Switch to remark-directive | Familiar Markdown extension syntax and plain fenced code samples. | Nested colon fences, quote escaping, and silent parser recovery need extra lint; live LLM reliability is pending. |

## Verdict

**PENDING — no go/no-go has been made.** The reduced pilot is too small to decide the provisional Markdoc lock. A full run, quality judging, human blind check, and K1–K6 evaluation are still required; the full run is not approved or funded.

## Evidence

The committed [harness and runbook](../../spikes/m0-lesson-format/RUNNING.md) define 36 tasks (30 base and 6 adversarial), two syntax arms, three Anthropic models (Opus 5.5, Sonnet 5.5, Haiku 5.5), three samples per full-run cell, up to three repairs, shared schemas and semantic validation, metrics M1–M7, Q1 and Q2, and the fixed [K1–K6 thresholds](../research/lesson-ir.md). The user accepted the spec's Anthropic-only scope and these thresholds. Requests ran through OpenRouter's OpenAI-compatible streaming endpoint using the exact model IDs in [`results/pilot/run.json`](../../spikes/m0-lesson-format/results/pilot/run.json); actual cost came from its per-response `usage.cost`.

Offline checks: 174 tests pass; all 36 gold lessons validate in both arms and normalise to identical neutral trees; the 72-generation stub run writes a report and CSV. These are harness checks, not measured model reliability.

**Reduced pilot:** 6 base tasks (one per domain), one sample, 3 models, and 2 arms: 36 generations total. The original 12-task pilot was reduced by omitting its 6 adversarial tasks to fit the user's $4.50 cumulative approval. All six planned tasks completed with both syntax arms for every model. The smoke call cost $0.0000058; generation cost was $3.24134161; total recorded OpenRouter spend was **$3.24134741 of $4.50**. No judge or Q2 comparison was run.

| Measure | Markdoc | Directives | Source |
|---|---:|---:|---|
| Opus 5.5: M1 / M2 / M3 / M4 / $ per lesson | 66.7% / 100% / 0.67 / 0% / $0.211 | 83.3% / 83.3% / 0.50 / 0% / $0.200 | [`results/pilot/report.md`](../../spikes/m0-lesson-format/results/pilot/report.md) |
| Sonnet 5.5: M1 / M2 / M3 / M4 / $ per lesson | 66.7% / 100% / 0.33 / 0% / $0.062 | 83.3% / 100% / 0.17 / 0% / $0.060 | [`results/pilot/report.md`](../../spikes/m0-lesson-format/results/pilot/report.md) |
| Haiku 5.5: M1 / M2 / M3 / M4 / $ per lesson | 83.3% / 100% / 0.17 / 0% / $0.00349 | 66.7% / 100% / 0.33 / 0% / $0.00353 | [`results/pilot/report.md`](../../spikes/m0-lesson-format/results/pilot/report.md) |
| Manual spot-check of 10 outputs | All checked metrics agreed with hand review | All checked metrics agreed with hand review | [`results/pilot/spot-check.md`](../../spikes/m0-lesson-format/results/pilot/spot-check.md) |
| Full-run M1–M7 by model | PENDING | PENDING | `results/full/report.md` and `results/full/results.csv` |
| Q1 quality and Q2 blind preference | PENDING | PENDING | `results/full/report.md` and blind-check score |
| K1–K6 and final rule | PENDING | PENDING | `results/full/report.md` |

The [run metadata](../../spikes/m0-lesson-format/results/pilot/run.json), [CSV](../../spikes/m0-lesson-format/results/pilot/results.csv), and [compressed raw generations](../../spikes/m0-lesson-format/results/pilot/generations.jsonl.gz) preserve the pilot evidence for rescoring without another paid run. M7 visible output tokens are estimated locally; the OpenRouter chat API did not provide a count-only call. The 6-task sample is descriptive only and does not support a decision against the 36-task × 3-sample thresholds.

The planned eval does not test non-Anthropic models, the production ACP agent with file tools and a validate tool, human editing, or streaming UX. Source packs are plain-text Wikipedia excerpts. This funded pilot also omits all six adversarial tasks and has only one sample per cell. These limits must remain in the final decision.

## Consequences

**PENDING verdict.** If Markdoc stays, confirm the provisional LS-2 lock and specify any prompt or validator changes. If directives win, record the required parser, printer, and exercise-authoring changes; the M0 exit review must update PRD LS-2 and Appendix A decision 8.

## Follow-ups

- [x] Run the approved reduced pilot and hand-check 10 outputs against automatic scoring (ALI-48).
- [ ] Obtain separate approval and funding before the full run; judge quality and complete 30 blind pairs (ALI-49 remains blocked).
- [ ] Consider an ACP agent follow-up and non-Anthropic models if v1 needs those providers (owner: M0 exit review).
