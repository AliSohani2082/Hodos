# Markdoc vs directives: results for run `pilot`

**REDUCED PILOT / PARTIAL RUN**: 6 of 36 tasks, up to 1 sample(s) per cell. The planned reduced pilot uses 6 of the original 12 pilot tasks: one base task per domain; the 6 adversarial tasks were omitted to fit the $4.50 cumulative cap. The K1-K6 thresholds assume the full 36 tasks x 3 samples, so nothing below is a verdict.

36 finished generations, 0 unfinished (budget or API error, excluded). Spend so far: $3.24 on generation.
Cumulative OpenRouter spend recorded across smoke and generation: $3.24134741 of the $4.50 hard cap.
[Ten-output manual scoring spot-check](spot-check.md).

## First-pass validity, repair rounds and cost, per format

| Model | Format | n | First-pass valid (M1) | Final valid (M2) | Repair rounds (M3) | Silent drops (M4) | Semantic ok, 1st pass (M5) | Disallowed block (M6) | Output tokens (M7) | $ / lesson |
|---|---|---|---|---|---|---|---|---|---|---|
| opus 5.5 | Markdoc | 6 | 66.7% | 100.0% | 0.67 | 0.0% | 100.0% | 0.0% | 2098 | $0.211 |
| opus 5.5 | Directive | 6 | 83.3% | 83.3% | 0.50 | 0.0% | 100.0% | 0.0% | 2128 | $0.200 |
| sonnet 5.5 | Markdoc | 6 | 66.7% | 100.0% | 0.33 | 0.0% | 83.3% | 0.0% | 1765 | $0.062 |
| sonnet 5.5 | Directive | 6 | 83.3% | 100.0% | 0.17 | 0.0% | 100.0% | 0.0% | 1862 | $0.060 |
| haiku 5.5 | Markdoc | 6 | 83.3% | 100.0% | 0.17 | 0.0% | 100.0% | 0.0% | 1704 | $0.00349 |
| haiku 5.5 | Directive | 6 | 66.7% | 100.0% | 0.33 | 0.0% | 100.0% | 0.0% | 1532 | $0.00353 |

M3 counts a lesson that never reaches green as 3. M4 counts only drops the validator did not report; M4-any (reported or not) is in the table below.

## Paired differences, Directive minus Markdoc (95% cluster bootstrap over tasks)

| Model | Metric | D - M | 95% interval | tasks |
|---|---|---|---|---|
| opus 5.5 | First-pass valid | +16.7pp | +0.0pp to +50.0pp | 6 |
| opus 5.5 | Final valid | -16.7pp | -50.0pp to +0.0pp | 6 |
| opus 5.5 | Repair rounds | -0.17 | -0.50 to 0.00 | 6 |
| opus 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 6 |
| sonnet 5.5 | First-pass valid | +16.7pp | +0.0pp to +50.0pp | 6 |
| sonnet 5.5 | Final valid | +0.0pp | +0.0pp to +0.0pp | 6 |
| sonnet 5.5 | Repair rounds | -0.17 | -0.50 to 0.00 | 6 |
| sonnet 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 6 |
| haiku 5.5 | First-pass valid | -16.7pp | -50.0pp to +0.0pp | 6 |
| haiku 5.5 | Final valid | +0.0pp | +0.0pp to +0.0pp | 6 |
| haiku 5.5 | Repair rounds | 0.17 | 0.00 to 0.50 | 6 |
| haiku 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 6 |

## Fidelity checks (additions to M1-M7)

| Model | Format | Checklist met | Literals preserved (adversarial) | Required nesting (adv 4) | Dropped blocks, any (M4-any) |
|---|---|---|---|---|---|
| opus 5.5 | Markdoc | 100.0% | n/a | n/a | 0.0% |
| opus 5.5 | Directive | 100.0% | n/a | n/a | 0.0% |
| sonnet 5.5 | Markdoc | 100.0% | n/a | n/a | 0.0% |
| sonnet 5.5 | Directive | 100.0% | n/a | n/a | 0.0% |
| haiku 5.5 | Markdoc | 100.0% | n/a | n/a | 0.0% |
| haiku 5.5 | Directive | 100.0% | n/a | n/a | 0.0% |

## What fails on the first pass

Share of first-pass lessons that carry at least one diagnostic of each kind.

| Diagnostic | Markdoc | Directive |
|---|---|---|
| bad-nesting | 5.6% | 0.0% |
| bad-value | 16.7% | 5.6% |
| missing-attr | 11.1% | 0.0% |
| unclosed | 11.1% | 5.6% |
| unknown-attr | 0.0% | 11.1% |

## First-pass validity by lesson shape (all models)

| Shape | Markdoc M1 | Directive M1 | n per arm |
|---|---|---|---|
| S1 | 100.0% | 100.0% | 3 / 3 |
| S2 | 100.0% | 100.0% | 6 / 6 |
| S3 | 66.7% | 66.7% | 3 / 3 |
| S4 | 33.3% | 66.7% | 3 / 3 |
| S5 | 33.3% | 33.3% | 3 / 3 |

## Go / no-go (lesson-ir.md §8.5)

> Pilot or partial data: the gates below are shown to exercise the pipeline, not as a decision.

**Verdict by the rules: RECONSIDER** (rule 5). both arms fail K1-K4 on a primary model: stop and reconsider (third arm, or JSON blocks for the exercise envelope only).

| Gate | Model | Format | Measured | Pass |
|---|---|---|---|---|
| K1 final valid (M2) >= 97% | opus 5.5 | Markdoc | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | opus 5.5 | Markdoc | 66.7% | FAIL |
| K3 mean repair rounds (M3) <= 0.6 | opus 5.5 | Markdoc | 0.67 | FAIL |
| K4 dropped-block rate (M4) <= 1% | opus 5.5 | Markdoc | 0.0% | pass |
| K1 final valid (M2) >= 97% | opus 5.5 | Directive | 83.3% | FAIL |
| K2 first-pass valid (M1) >= 80% | opus 5.5 | Directive | 83.3% | pass |
| K3 mean repair rounds (M3) <= 0.6 | opus 5.5 | Directive | 0.50 | pass |
| K4 dropped-block rate (M4) <= 1% | opus 5.5 | Directive | 0.0% | pass |
| K1 final valid (M2) >= 97% | sonnet 5.5 | Markdoc | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | sonnet 5.5 | Markdoc | 66.7% | FAIL |
| K3 mean repair rounds (M3) <= 0.6 | sonnet 5.5 | Markdoc | 0.33 | pass |
| K4 dropped-block rate (M4) <= 1% | sonnet 5.5 | Markdoc | 0.0% | pass |
| K1 final valid (M2) >= 97% | sonnet 5.5 | Directive | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | sonnet 5.5 | Directive | 83.3% | pass |
| K3 mean repair rounds (M3) <= 0.6 | sonnet 5.5 | Directive | 0.17 | pass |
| K4 dropped-block rate (M4) <= 1% | sonnet 5.5 | Directive | 0.0% | pass |
| K5a upper 95% bound of (D - M) on M2 <= 5pp | opus 5.5 | M vs D | +0.0pp | pass |
| K5b upper 95% bound of (D - M) on M1 <= 10pp | opus 5.5 | M vs D | +50.0pp | FAIL |
| K5a upper 95% bound of (D - M) on M2 <= 5pp | sonnet 5.5 | M vs D | +0.0pp | pass |
| K5b upper 95% bound of (D - M) on M1 <= 10pp | sonnet 5.5 | M vs D | +50.0pp | FAIL |
| K6a Q1 mean (M - D) >= -0.2 and lower bound >= -0.3 | opus 5.5 | M vs D | not measured | n/a |
| K6a Q1 mean (M - D) >= -0.2 and lower bound >= -0.3 | sonnet 5.5 | M vs D | not measured | n/a |
| K6b Q2 preference within 35% to 65% (tie) | both | M vs D | not measured | n/a |

Thresholds: K1 0.97, K2 0.8, K3 0.6, K4 0.01; primary models are Opus 5.5 and Sonnet 5.5; Haiku 5.5 is informational.

## Measured tokens and the quote for the full run (§8.6)

The $ / generation values below are actual OpenRouter-reported usage costs. Token metrics use OpenRouter usage; visible output token count is estimated locally because the OpenRouter chat endpoint has no count-only call.

| Model | n | Input tokens / gen | Output tokens / gen | of which thinking | Needed repair | $ / generation | Prompt-cache read share |
|---|---|---|---|---|---|---|---|
| opus 5.5 | 12 | 19748 | 6868 | 993 | 25.0% | $0.21 | 26.2% |
| sonnet 5.5 | 12 | 12210 | 3656 | 71 | 25.0% | $0.06 | 18.4% |
| haiku 5.5 | 12 | 11758 | 4650 | 1964 | 25.0% | $0.00 | 20.0% |

**Quote for the full run** (216 generations per model, scaled from the measured cost per generation; judge cost still the spec assumption):
generation $58.34 + judge $31.10 = $89.45, plus 25% contingency = **$111.81**. This is a planning estimate from the reduced pilot; live cost uses OpenRouter's usage.cost. The $150 full-run cap is not approved or funded.

_Estimate rests on this run's mix of tasks; a pilot with fewer tasks than the full set can mis-estimate by tens of percent._
