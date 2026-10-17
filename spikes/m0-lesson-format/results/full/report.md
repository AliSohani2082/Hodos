# Markdoc vs directives: results for run `full`

**FUNDED REDUCED EVALUATION**: 5 of 36 tasks with up to 1 sample(s) per cell. The specified 36 tasks x 2 arms x 3 models x 3 samples (648 generations) exceeds the $19.00 new-spend approval; this run prioritises paired Opus and Sonnet results. K1-K6 thresholds are unchanged, but the reduced sample weakens their precision. The rule calculation below is descriptive until coverage and quality checks are complete.

16 finished generations, 53 unfinished (budget or API error, excluded). Spend so far: $2.18 on generation.
New OpenRouter spend recorded since the full-run approval: $2.17704970 of the $19.00 hard cap.

## First-pass validity, repair rounds and cost, per format

| Model | Format | n | First-pass valid (M1) | Final valid (M2) | Repair rounds (M3) | Silent drops (M4) | Semantic ok, 1st pass (M5) | Disallowed block (M6) | Output tokens (M7) | $ / lesson |
|---|---|---|---|---|---|---|---|---|---|---|
| opus 5.5 | Markdoc | 5 | 80.0% | 80.0% | 0.60 | 0.0% | 100.0% | 0.0% | 2189 | $0.213 |
| opus 5.5 | Directive | 4 | 75.0% | 100.0% | 0.50 | 0.0% | 100.0% | 0.0% | 2324 | $0.197 |
| sonnet 5.5 | Markdoc | 4 | 100.0% | 100.0% | 0.00 | 0.0% | 100.0% | 0.0% | 1982 | $0.051 |
| sonnet 5.5 | Directive | 3 | 100.0% | 100.0% | 0.00 | 0.0% | 100.0% | 0.0% | 1368 | $0.041 |

M3 counts a lesson that never reaches green as 3. M4 counts only drops the validator did not report; M4-any (reported or not) is in the table below.

## Paired differences, Directive minus Markdoc (95% cluster bootstrap over tasks)

| Model | Metric | D - M | 95% interval | tasks |
|---|---|---|---|---|
| opus 5.5 | First-pass valid | +0.0pp | +0.0pp to +0.0pp | 4 |
| opus 5.5 | Final valid | +25.0pp | +0.0pp to +75.0pp | 4 |
| opus 5.5 | Repair rounds | -0.25 | -0.75 to 0.00 | 4 |
| opus 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 4 |
| sonnet 5.5 | First-pass valid | +0.0pp | +0.0pp to +0.0pp | 3 |
| sonnet 5.5 | Final valid | +0.0pp | +0.0pp to +0.0pp | 3 |
| sonnet 5.5 | Repair rounds | 0.00 | 0.00 to 0.00 | 3 |
| sonnet 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 3 |

## Fidelity checks (additions to M1-M7)

| Model | Format | Checklist met | Literals preserved (adversarial) | Required nesting (adv 4) | Dropped blocks, any (M4-any) |
|---|---|---|---|---|---|
| opus 5.5 | Markdoc | 100.0% | n/a | n/a | 0.0% |
| opus 5.5 | Directive | 100.0% | n/a | n/a | 0.0% |
| sonnet 5.5 | Markdoc | 100.0% | n/a | n/a | 0.0% |
| sonnet 5.5 | Directive | 100.0% | n/a | n/a | 0.0% |

## What fails on the first pass

Share of first-pass lessons that carry at least one diagnostic of each kind.

| Diagnostic | Markdoc | Directive |
|---|---|---|
| bad-body | 0.0% | 14.3% |
| unclosed | 11.1% | 14.3% |

## First-pass validity by lesson shape (all models)

| Shape | Markdoc M1 | Directive M1 | n per arm |
|---|---|---|---|
| S1 | 100.0% | n/a | 1 / 0 |
| S2 | 100.0% | 100.0% | 2 / 2 |
| S3 | 100.0% | 100.0% | 2 / 2 |
| S4 | 100.0% | 100.0% | 2 / 2 |
| S5 | 50.0% | 0.0% | 2 / 1 |

## Go / no-go (lesson-ir.md §8.5)

> Reduced or partial data: these unchanged gates show the observed sample and do not establish a go/no-go decision. K5 intervals are wider with one sample per task; absent Q1 or Q2 leaves K6 untested.

**Descriptive rule output: RECONSIDER** (rule 5). both arms fail K1-K4 on a primary model: stop and reconsider (third arm, or JSON blocks for the exercise envelope only).

| Gate | Model | Format | Measured | Pass |
|---|---|---|---|---|
| K1 final valid (M2) >= 97% | opus 5.5 | Markdoc | 80.0% | FAIL |
| K2 first-pass valid (M1) >= 80% | opus 5.5 | Markdoc | 80.0% | pass |
| K3 mean repair rounds (M3) <= 0.6 | opus 5.5 | Markdoc | 0.60 | pass |
| K4 dropped-block rate (M4) <= 1% | opus 5.5 | Markdoc | 0.0% | pass |
| K1 final valid (M2) >= 97% | opus 5.5 | Directive | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | opus 5.5 | Directive | 75.0% | FAIL |
| K3 mean repair rounds (M3) <= 0.6 | opus 5.5 | Directive | 0.50 | pass |
| K4 dropped-block rate (M4) <= 1% | opus 5.5 | Directive | 0.0% | pass |
| K1 final valid (M2) >= 97% | sonnet 5.5 | Markdoc | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | sonnet 5.5 | Markdoc | 100.0% | pass |
| K3 mean repair rounds (M3) <= 0.6 | sonnet 5.5 | Markdoc | 0.00 | pass |
| K4 dropped-block rate (M4) <= 1% | sonnet 5.5 | Markdoc | 0.0% | pass |
| K1 final valid (M2) >= 97% | sonnet 5.5 | Directive | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | sonnet 5.5 | Directive | 100.0% | pass |
| K3 mean repair rounds (M3) <= 0.6 | sonnet 5.5 | Directive | 0.00 | pass |
| K4 dropped-block rate (M4) <= 1% | sonnet 5.5 | Directive | 0.0% | pass |
| K5a upper 95% bound of (D - M) on M2 <= 5pp | opus 5.5 | M vs D | +75.0pp | FAIL |
| K5b upper 95% bound of (D - M) on M1 <= 10pp | opus 5.5 | M vs D | +0.0pp | pass |
| K5a upper 95% bound of (D - M) on M2 <= 5pp | sonnet 5.5 | M vs D | +0.0pp | pass |
| K5b upper 95% bound of (D - M) on M1 <= 10pp | sonnet 5.5 | M vs D | +0.0pp | pass |
| K6a Q1 mean (M - D) >= -0.2 and lower bound >= -0.3 | opus 5.5 | M vs D | not measured | n/a |
| K6a Q1 mean (M - D) >= -0.2 and lower bound >= -0.3 | sonnet 5.5 | M vs D | not measured | n/a |
| K6b Q2 preference within 35% to 65% (tie) | both | M vs D | not measured | n/a |

Thresholds: K1 0.97, K2 0.8, K3 0.6, K4 0.01; primary models are Opus 5.5 and Sonnet 5.5; Haiku 5.5 is informational.

## Measured tokens and the quote for the full run (§8.6)

The $ / generation values below are actual OpenRouter-reported usage costs. Token metrics use OpenRouter usage; visible output token count is estimated locally because the OpenRouter chat endpoint has no count-only call.

| Model | n | Input tokens / gen | Output tokens / gen | of which thinking | Needed repair | $ / generation | Prompt-cache read share |
|---|---|---|---|---|---|---|---|
| opus 5.5 | 9 | 19535 | 6963 | 839 | 22.2% | $0.21 | 27.9% |
| sonnet 5.5 | 7 | 8797 | 2474 | 0 | 0.0% | $0.05 | 0.0% |

**Quote for the full run** (216 generations per model, scaled from the measured cost per generation; judge cost still the spec assumption):
generation $54.49 + judge $31.10 = $85.60, plus 25% contingency = **$107.00**. This is a planning estimate; live cost uses OpenRouter's usage.cost. The current new-spend approval is $19.00 and cannot fund this specified design.

_Estimate rests on this run's mix of tasks; a pilot with fewer tasks than the full set can mis-estimate by tens of percent._
