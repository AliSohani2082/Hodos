# Markdoc vs directives: results for run `full`

**FUNDED REDUCED EVALUATION**: 30 of 36 tasks with up to 1 sample(s) per cell. The specified 36 tasks x 2 arms x 3 models x 3 samples (648 generations) exceeds the $19.00 new-spend approval; this run prioritises paired Opus and Sonnet results. K1-K6 thresholds are unchanged, but the reduced sample weakens their precision. The rule calculation below is descriptive until coverage and quality checks are complete.

117 finished generations, 57 unsuccessful attempts (budget or API error, excluded; retries can succeed later). Spend so far: $15.63 on generation.
New OpenRouter spend recorded since the full-run approval: $15.63374315 of the $19.00 hard cap.

## Completion and interpretation

**INCONCLUSIVE.** 117 of 120 planned reduced-run cells completed. 3 are missing: `claude-opus-5-5|directive|science-s5|1`, `claude-sonnet-5-5|markdoc|science-s5|1`, `claude-sonnet-5-5|directive|science-s5|1`. The original 648-generation specification also included six more tasks, Haiku 5.5 and two further samples per cell. Q1 judging and the Q2 human blind check were not done. The user stopped paid work after the in-flight cell finished.

The K1-K6 thresholds below are unchanged. With one sample per task, incomplete paired coverage, and no Q1/Q2 quality evidence, the descriptive rule output is not a go/no-go on the provisional lesson IR.

## First-pass validity, repair rounds and cost, per format

| Model | Format | n | First-pass valid (M1) | Final valid (M2) | Repair rounds (M3) | Silent drops (M4) | Semantic ok, 1st pass (M5) | Disallowed block (M6) | Output tokens (M7) | $ / lesson |
|---|---|---|---|---|---|---|---|---|---|---|
| opus 5.5 | Markdoc | 30 | 76.7% | 90.0% | 0.43 | 0.0% | 100.0% | 0.0% | 2146 | $0.180 |
| opus 5.5 | Directive | 29 | 58.6% | 93.1% | 0.59 | 0.0% | 100.0% | 0.0% | 2070 | $0.181 |
| sonnet 5.5 | Markdoc | 29 | 82.8% | 100.0% | 0.17 | 0.0% | 100.0% | 0.0% | 1765 | $0.054 |
| sonnet 5.5 | Directive | 29 | 65.5% | 100.0% | 0.45 | 0.0% | 100.0% | 0.0% | 1698 | $0.063 |

M3 counts a lesson that never reaches green as 3. M4 counts only drops the validator did not report; M4-any (reported or not) is in the table below.

## Paired differences, Directive minus Markdoc (95% cluster bootstrap over tasks)

| Model | Metric | D - M | 95% interval | tasks |
|---|---|---|---|---|
| opus 5.5 | First-pass valid | -20.7pp | -34.5pp to -6.9pp | 29 |
| opus 5.5 | Final valid | +0.0pp | -10.3pp to +10.3pp | 29 |
| opus 5.5 | Repair rounds | 0.24 | 0.03 to 0.45 | 29 |
| opus 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 29 |
| sonnet 5.5 | First-pass valid | -17.2pp | -31.0pp to -3.4pp | 29 |
| sonnet 5.5 | Final valid | +0.0pp | +0.0pp to +0.0pp | 29 |
| sonnet 5.5 | Repair rounds | 0.28 | 0.10 to 0.45 | 29 |
| sonnet 5.5 | Silent drops | +0.0pp | +0.0pp to +0.0pp | 29 |

## Fidelity checks (additions to M1-M7)

| Model | Format | Checklist met | Literals preserved (adversarial) | Required nesting (adv 4) | Dropped blocks, any (M4-any) |
|---|---|---|---|---|---|
| opus 5.5 | Markdoc | 99.0% | 100.0% | 100.0% | 0.0% |
| opus 5.5 | Directive | 100.0% | 100.0% | 100.0% | 0.0% |
| sonnet 5.5 | Markdoc | 100.0% | 100.0% | 100.0% | 0.0% |
| sonnet 5.5 | Directive | 99.5% | 100.0% | 100.0% | 0.0% |

## What fails on the first pass

Share of first-pass lessons that carry at least one diagnostic of each kind.

| Diagnostic | Markdoc | Directive |
|---|---|---|
| bad-body | 3.4% | 8.6% |
| bad-nesting | 3.4% | 0.0% |
| bad-syntax | 0.0% | 1.7% |
| bad-value | 10.2% | 8.6% |
| missing-attr | 0.0% | 1.7% |
| unclosed | 11.9% | 10.3% |
| unknown-attr | 0.0% | 17.2% |

## First-pass validity by lesson shape (all models)

| Shape | Markdoc M1 | Directive M1 | n per arm |
|---|---|---|---|
| ADV1 | 100.0% | 100.0% | 2 / 2 |
| ADV2 | 100.0% | 100.0% | 2 / 2 |
| ADV3 | 100.0% | 100.0% | 2 / 2 |
| ADV4 | 100.0% | 0.0% | 2 / 2 |
| ADV5 | 100.0% | 100.0% | 2 / 2 |
| ADV6 | 0.0% | 0.0% | 2 / 2 |
| S1 | 100.0% | 100.0% | 8 / 8 |
| S2 | 100.0% | 80.0% | 10 / 10 |
| S3 | 70.0% | 30.0% | 10 / 10 |
| S4 | 100.0% | 80.0% | 10 / 10 |
| S5 | 22.2% | 12.5% | 9 / 8 |

## Go / no-go (lesson-ir.md §8.5)

> Reduced or partial data: these unchanged gates show the observed sample and do not establish a go/no-go decision. K5 intervals are wider with one sample per task; absent Q1 or Q2 leaves K6 untested.

**Descriptive rule output: RECONSIDER** (rule 5). both arms fail K1-K4 on a primary model: stop and reconsider (third arm, or JSON blocks for the exercise envelope only).

| Gate | Model | Format | Measured | Pass |
|---|---|---|---|---|
| K1 final valid (M2) >= 97% | opus 5.5 | Markdoc | 90.0% | FAIL |
| K2 first-pass valid (M1) >= 80% | opus 5.5 | Markdoc | 76.7% | FAIL |
| K3 mean repair rounds (M3) <= 0.6 | opus 5.5 | Markdoc | 0.43 | pass |
| K4 dropped-block rate (M4) <= 1% | opus 5.5 | Markdoc | 0.0% | pass |
| K1 final valid (M2) >= 97% | opus 5.5 | Directive | 93.1% | FAIL |
| K2 first-pass valid (M1) >= 80% | opus 5.5 | Directive | 58.6% | FAIL |
| K3 mean repair rounds (M3) <= 0.6 | opus 5.5 | Directive | 0.59 | pass |
| K4 dropped-block rate (M4) <= 1% | opus 5.5 | Directive | 0.0% | pass |
| K1 final valid (M2) >= 97% | sonnet 5.5 | Markdoc | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | sonnet 5.5 | Markdoc | 82.8% | pass |
| K3 mean repair rounds (M3) <= 0.6 | sonnet 5.5 | Markdoc | 0.17 | pass |
| K4 dropped-block rate (M4) <= 1% | sonnet 5.5 | Markdoc | 0.0% | pass |
| K1 final valid (M2) >= 97% | sonnet 5.5 | Directive | 100.0% | pass |
| K2 first-pass valid (M1) >= 80% | sonnet 5.5 | Directive | 65.5% | FAIL |
| K3 mean repair rounds (M3) <= 0.6 | sonnet 5.5 | Directive | 0.45 | pass |
| K4 dropped-block rate (M4) <= 1% | sonnet 5.5 | Directive | 0.0% | pass |
| K5a upper 95% bound of (D - M) on M2 <= 5pp | opus 5.5 | M vs D | +10.3pp | FAIL |
| K5b upper 95% bound of (D - M) on M1 <= 10pp | opus 5.5 | M vs D | -6.9pp | pass |
| K5a upper 95% bound of (D - M) on M2 <= 5pp | sonnet 5.5 | M vs D | +0.0pp | pass |
| K5b upper 95% bound of (D - M) on M1 <= 10pp | sonnet 5.5 | M vs D | -3.4pp | pass |
| K6a Q1 mean (M - D) >= -0.2 and lower bound >= -0.3 | opus 5.5 | M vs D | not measured | n/a |
| K6a Q1 mean (M - D) >= -0.2 and lower bound >= -0.3 | sonnet 5.5 | M vs D | not measured | n/a |
| K6b Q2 preference within 35% to 65% (tie) | both | M vs D | not measured | n/a |

Thresholds: K1 0.97, K2 0.8, K3 0.6, K4 0.01; primary models are Opus 5.5 and Sonnet 5.5; Haiku 5.5 is informational.

## Measured tokens and the quote for the full run (§8.6)

The $ / generation values below are actual OpenRouter-reported usage costs. Token metrics use OpenRouter usage; visible output token count is estimated locally because the OpenRouter chat endpoint has no count-only call.

| Model | n | Input tokens / gen | Output tokens / gen | of which thinking | Needed repair | $ / generation | Prompt-cache read share |
|---|---|---|---|---|---|---|---|
| opus 5.5 | 59 | 17137 | 6194 | 1133 | 32.2% | $0.18 | 31.0% |
| sonnet 5.5 | 58 | 12841 | 3554 | 235 | 25.9% | $0.06 | 27.0% |

**Quote for the full run** (216 generations per model, scaled from the measured cost per generation; judge cost still the spec assumption):
generation $51.72 + judge $31.10 = $82.83, plus 25% contingency = **$103.54**. This is a planning estimate; live cost uses OpenRouter's usage.cost. The current new-spend approval is $19.00 and cannot fund this specified design.

_Estimate rests on this run's mix of tasks; a pilot with fewer tasks than the full set can mis-estimate by tens of percent._
