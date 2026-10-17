# ADR-0001: Markdoc as the lesson IR

| | |
|---|---|
| **Status** | Proposed — inconclusive evaluation |
| **Date** | 2026-10-18 |
| **Spike** | M0 (a), [lesson format reliability](../../spikes/m0-lesson-format/README.md) |
| **Issue** | [ALI-37](https://linear.app/ali-inc/issue/ALI-37) |
| **Amends** | None. PRD LS-2 and Appendix A decision 8 remain provisional. |

## Question

Is Markdoc at least as reliable as remark-directive for model-written lessons, after the same validate-and-repair loop?

## Context and options

[PRD LS-2](../PRD.md) provisionally names Markdoc as the lesson source format. The [research spec §8](../research/lesson-ir.md) requires 36 tasks, both syntaxes, Opus 5.5, Sonnet 5.5, and Haiku 5.5, three samples per cell, up to three repairs, Q1 judging, Q2 blind human comparison, and the fixed K1–K6 decision gates: 648 planned generations before judging. The options are to keep Markdoc, switch to remark-directive, or defer the lock. Markdoc offers typed attributes and explicit tag errors; directives offer familiar Markdown extension syntax but require nested colon fences, attribute quoting, and lints for parser recovery.

## Verdict

**INCONCLUSIVE — defer the Markdoc go/no-go.** The user stopped paid work after the in-flight cell finished. The funded run completed 117 of its 120 planned reduced cells, itself a reduction from the 648-generation specification. Three science S5 cells are missing, Q1 was not judged, and Q2 was not performed. K1–K6 thresholds were not changed. Their values on the observed sample are useful diagnostics, but the decision rules cannot establish the specified keep/switch result from this evidence. Markdoc remains provisional under LS-2; this ADR does not endorse or reject it.

On the observed sample, the report's **descriptive** rule output is `RECONSIDER` (rule 5): both arms miss K1–K4 on Opus. This is not adopted as a final rule 5 verdict because task/sample coverage and K6 are incomplete. Paired data favor Markdoc for first-pass validity, while the Opus final-validity comparison remains uncertain.

## Evidence

The [harness and runbook](../../spikes/m0-lesson-format/RUNNING.md) implement a neutral block tree and shared schema/semantic validation for both syntax arms. All 36 gold lessons validate in both arms and normalize to identical trees. Offline tests and a stub run check the pipeline; these are not model reliability measurements. The 10-output [pilot spot-check](../../spikes/m0-lesson-format/results/pilot/spot-check.md) agreed with automatic scoring on the checked metrics.

**Reduced pilot:** six base tasks, two arms, three models, one sample: 36 of the original pilot's 72 generations. Its six adversarial tasks were omitted to fit the then-approved $4.50 cap. Total recorded spend, including smoke, was **$3.24134741**. The [pilot report](../../spikes/m0-lesson-format/results/pilot/report.md) is descriptive.

**Funded reduced run:** 30 of 36 tasks, Opus and Sonnet, two arms, one sample: 120 planned cells. The user approved $19.00 of new spend after the pilot. **117 cells completed**; `claude-opus-5-5|directive|science-s5|1`, `claude-sonnet-5-5|markdoc|science-s5|1`, and `claude-sonnet-5-5|directive|science-s5|1` did not run. The response-level ledger records **$15.63374315 of the $19.00 cap**. A read-only OpenRouter account check immediately afterward reported a smaller $14.87283564 usage delta from the 7.3976 baseline; account reporting lagged the response-level ledger, so the larger number is used for the budget statement. The [full report](../../spikes/m0-lesson-format/results/full/report.md), [CSV](../../spikes/m0-lesson-format/results/full/results.csv), [compressed raw generations](../../spikes/m0-lesson-format/results/full/generations.jsonl.gz), and [plan](../../spikes/m0-lesson-format/results/full/plan.md) preserve what was measured.

| Primary model | Syntax | n | M1 first-pass valid | M2 final valid | M3 repair rounds | M4 silent drops | Mean cost per lesson |
|---|---|---:|---:|---:|---:|---:|---:|
| Opus 5.5 | Markdoc | 30 | 76.7% | 90.0% | 0.43 | 0.0% | $0.180 |
| Opus 5.5 | Directive | 29 | 58.6% | 93.1% | 0.59 | 0.0% | $0.181 |
| Sonnet 5.5 | Markdoc | 29 | 82.8% | 100.0% | 0.17 | 0.0% | $0.054 |
| Sonnet 5.5 | Directive | 29 | 65.5% | 100.0% | 0.45 | 0.0% | $0.063 |

The 29-task paired bootstrap estimated Directive minus Markdoc first-pass validity at **−20.7 percentage points** for Opus (95% interval −34.5 to −6.9) and **−17.2 points** for Sonnet (−31.0 to −3.4). Final-validity difference was 0.0 points in both paired comparisons; Opus's interval was −10.3 to +10.3 points, so its K5a upper bound missed the allowed +5 points. K1 and K2 also failed for both Opus arms; Sonnet Markdoc passed K1–K4, while Sonnet directive missed K2. Q1 and Q2, required for K6, are **not measured**. The [full report](../../spikes/m0-lesson-format/results/full/report.md) contains M5–M7, diagnostic counts, all gate values, and token/cost figures.

The reduction leaves one generation per task/model/arm, so the bootstrap samples task differences but cannot estimate variation across repeated generations for the same task. Three missing cells remove one Opus pair and one Sonnet pair, and six omitted base tasks reduce coverage. A single Opus failure changes its observed final-validity rate by about 3.3 points, larger than K1's 3-point allowance. Without Q1 or Q2, K6 is unavailable. The existing thresholds were designed for 36 tasks and three samples and are not re-tuned after seeing results.

This eval also does not measure non-Anthropic models, the production ACP agent with file tools and a validate tool, human editing, or streaming interaction. Source packs are plain-text Wikipedia excerpts. Prompt guidance and examples had one author and no independent review. OpenRouter's per-response `usage.cost` supplied spend; M7 visible output tokens are locally estimated.

## Consequences

No PRD format change follows from this ADR. The M0 exit review should list LS-2 as an unresolved provisional lock and cite this incomplete run. A later authorized evaluation can resume from cached results, complete the missing cells and the specified repeated samples and quality checks, then apply unchanged K1–K6 gates. The user directed that no further paid calls or Q2 human check occur in this run.

## Follow-ups

- [x] Build the 36-task set, harness, shared validator, offline checks, CSV and reproducible reports.
- [x] Run the reduced pilot and hand-check 10 outputs.
- [x] Record the funded reduced run and the precise missing evidence.
- [ ] Complete the original §8 design and decide LS-2 when separately authorized; ALI-49 and ALI-37 remain open.
