# ADR-0001: Markdoc as the lesson IR

| | |
|---|---|
| **Status** | Proposed — live evaluation pending |
| **Date** | 2026-10-16 (skeleton; decision date pending) |
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

**PENDING — no go/no-go has been made.** Fill this section only after the pilot, full run, quality judging, human blind check, and K1–K6 evaluation. State whether the provisional Markdoc lock is Go, Go with changes, or No-go, then record the decision in the active voice.

## Evidence

The committed [harness and runbook](../../spikes/m0-lesson-format/RUNNING.md) define 36 tasks (30 base and 6 adversarial), two syntax arms, three Anthropic models (Opus 5.5, Sonnet 5.5, Haiku 5.5), three samples per full-run cell, up to three repairs, shared schemas and semantic validation, metrics M1–M7, Q1 and Q2, and the fixed [K1–K6 thresholds](../research/lesson-ir.md). The user accepted the spec's Anthropic-only scope and these thresholds before the live run.

Offline checks: 174 tests pass; all 36 gold lessons validate in both arms and normalise to identical neutral trees; the 72-generation stub run writes a report and CSV. **These are harness checks, not measured model reliability.** The current pilot quote is about $7.06 for 72 generations, before actual token usage. No paid calls have been made.

| Measure | Markdoc | Directives | Source |
|---|---:|---:|---|
| Pilot first-pass validity, repairs, and cost | PENDING | PENDING | `results/pilot/report.md` |
| Full-run M1–M7 by model | PENDING | PENDING | `results/full/report.md` and `results/full/results.csv` |
| Q1 quality and Q2 blind preference | PENDING | PENDING | `results/full/report.md` and blind-check score |
| K1–K6 and final rule | PENDING | PENDING | `results/full/report.md` |

After the run, record the exact package versions, model identifiers, effort, prompts, run flags, sample counts, spend, and links to preserved raw outputs here. Preserve enough raw output to recompute scores without another paid run.

The planned eval does not test non-Anthropic models, the production ACP agent with file tools and a validate tool, human editing, or streaming UX. Source packs are plain-text Wikipedia excerpts. These limits must remain in the final decision.

## Consequences

**PENDING verdict.** If Markdoc stays, confirm the provisional LS-2 lock and specify any prompt or validator changes. If directives win, record the required parser, printer, and exercise-authoring changes; the M0 exit review must update PRD LS-2 and Appendix A decision 8.

## Follow-ups

- [ ] Run the approved pilot and hand-check 10 outputs against automatic scoring (ALI-48).
- [ ] Re-quote and separately approve the full run; judge quality and complete 30 blind pairs (ALI-49).
- [ ] Consider an ACP agent follow-up and non-Anthropic models if v1 needs those providers (owner: M0 exit review).
