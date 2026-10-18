# ADR-0005: BKT-lite mastery gate and FSRS defaults

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Spike** | M0 (e), [BKT-lite and FSRS simulation](../../spikes/m0-mastery-sim/README.md) |
| **Issue** | [ALI-41](https://linear.app/ali-inc/issue/ALI-41) |
| **Amends** | PRD MS-1, MS-2, MS-3; §13 review-lapse target; §15 mastery risk; Appendix A decision 14; research §3.2 exercise evidence contract |

## Question

Do the BKT-lite mastery estimator and FSRS scheduling behave the way the PRD assumes when simulated against synthetic learners? Which defaults should M3 implement?

## Context

[PRD MS-1–MS-3](../PRD.md) proposes difficulty-adjusted BKT-lite, a θ=0.95 mastery gate with one unassisted correct checkpoint and three distinct items, and `ts-fsrs` per-skill review at target retention 0.90. [Intelligent tutoring §3.2](../research/intelligent-tutoring.md) supplies the estimator equations. The §13 goal is at most 15% review lapse. A false gate opening creates a misleading prerequisite signal; excess review load slows learners. M0 needs a reproducible comparison before M3 embeds either policy.

## Options considered

| Option | For | Against |
|---|---|---|
| Keep every PRD default | Small implementation, shorter path to a gate | One checkpoint can pass guessing and retry strategies; observed lapse target is ambiguous |
| Use BKT-lite and FSRS with revised gate and measurement rules | Keeps portable estimators and scheduling; closes the measured shortcut | More checkpoint items, attempt metadata, and policy work |
| Defer the mastery gate and review system | Avoids encoding unvalidated defaults | Leaves M3 without a consistent progression mechanism |

## Verdict

**BKT-lite and the mastery gate: Go with changes.** Use θ=0.95 as the standard evidence threshold, keep difficulty-adjusted guess/slip, soft evidence, the linear hint discount, and λ=1.0/0.5/0 for practice/review/checkpoint. Require at least three *unassisted* checkpoint successes on distinct items for guessable formats, record a wrong first attempt as a failure even if a later hint produces a correct answer, and enforce checkpoint attempt limits or cooldowns. A lower-friction path may use fewer checkpoint successes only for validated guess-resistant items. Treat `P(L)` as an evidence index pending real-data calibration, especially for graded skills. The simulated hint-first strategy is mostly blocked, but the PRD gate does **not** block hint-retry abuse.

**FSRS per-skill review: Go with changes.** Use FSRS-6 with target retention 0.90, `R(now)` and `pMastered × R(now)`, and trigger a prerequisite refresh below R=0.7. Use skill cards that enter Review state when the gate opens (empty learning/relearning steps or the low-level `next_state` API). Define §13's lapse numerator precisely as observed wrong reviews or memory lapses; if it means observed wrong answers, the ≤15% target needs a slip-adjusted threshold or a higher retention target. Keep the review λ=0.5 provisionally and calibrate it in shadow mode.

## Evidence

Run `cd spikes/m0-mastery-sim && uv run python run.py` with Python 3.12 and locked dependencies (`fsrs==6.3.2`, `pytest==9.1.1`). The [spike README](../../spikes/m0-mastery-sim/README.md) states the full generative models, assumptions, gate protocol, and omissions. The [combined tables](../../spikes/m0-mastery-sim/results/RESULTS.md) and [CSV files](../../spikes/m0-mastery-sim/results/) are committed. BKT-lite uses 20 fixed seeds × 200 learners per cell and 95% Wilson intervals for rates, with a 60-opportunity cap. The FSRS experiment uses 20 fixed seeds × 12 skills over 365 days, with true memory parameters perturbed from the scheduler. The [BKT golden vectors](../../spikes/m0-mastery-sim/fixtures/bkt_golden.json) and [ts-fsrs parity sequence](../../spikes/m0-mastery-sim/fixtures/ts_fsrs_golden.json) check future portability; the latter matches `ts-fsrs@5.4.2` on six day-granular reviews within rounding tolerance.

| MCQ gate | θ | Median opportunities | False openings among openings, 95% CI |
|---|---:|---:|---:|
| BKT only | 0.90 | 6 | 28.6% [27.2, 30.0] |
| BKT only | 0.95 | 7 | 20.1% [18.9, 21.4] |
| BKT only | 0.98 | 9 | 12.1% [11.1, 13.2] |
| PRD MS-2 gate | 0.90 | 9 | 15.0% [13.9, 16.1] |
| PRD MS-2 gate | 0.95 | 9 | 9.9% [9.0, 10.9] |
| PRD MS-2 gate | 0.98 | 10 | 6.0% [5.3, 6.7] |

At θ=0.95, the PRD gate yields 2.4% [2.0, 3.0] false openings on simulated open-response items, compared with 9.9% on four-choice MCQ. On MCQ, 19.1% of chance guessers, 70.5% of test-wise guessers, 0.8% of hint-first abusers, and 80.5% of hint-retry abusers reach the PRD gate within 60 opportunities. Three distinct unassisted checkpoint successes plus the first-miss rule reduce hint-retry pass-through to 6.6% and typical false openings to 1.0%, at median 14 opportunities. The three-distinct-items clause alone adds little at the default prior because the estimator already needs at least three items; it binds after a high diagnostic prior. Constant correct responses at one hint level plateau below θ=0.95 under the linear discount. Graded-ability learners can pass θ=0.95 at mean true accuracy 0.74, showing that the BKT value is not a calibrated chance of genuine mastery under that model. See G1–G7 for intervals, other populations, horizon cuts, and sensitivity.

For FSRS, target R=0.90 and answer slip 0.10 yield **19.5% observed wrong reviews** [18.2, 20.9] with perfect adherence: 10.5% memory lapses and 9.0% slips per review. At R=0.90, even a perfectly calibrated memory model predicts 17.5% wrong responses when slip is 0.10 and guess is 0.15. Raising the target to 0.95 gives 15.6% [14.9, 16.4] wrong reviews but increases mean reviews from 14.0 to 39.8 per skill-year in this model. The first Good interval is two days; per-skill R(t), effective mastery, lapse intervals, interval growth, and daily load are in F1–F5. A 30-day break triggers six of ten prerequisite refreshes at R<0.7 in the isolated prerequisite probe and raises next-day *predicted* recall from 0.698 to 0.912, assuming each refresh succeeds. F6 shows the one-error effect of λ_review=0, 0.5, and 1.0.

**Not tested:** real learners or item psychometrics; actual rates of guessing, hints, slips, or absence; fitted FSRS parameters; adaptive item choice; transfer to downstream lessons; teacher overrides; checkpoint retry policy in production; true outcomes after prerequisite refresh; multiple BKT skills interacting over time; minute-scale FSRS steps; production TypeScript integration. The code uses Python for one reproducible entry point; the TypeScript fixture checks a narrow scheduler path. These numbers show model behavior under stated assumptions, not empirical learning outcomes.

## Consequences

The M0 exit review should amend PRD MS-2 and Appendix A decision 14 with the checkpoint count, distinct unassisted items, first-attempt evidence, and attempt policy; MS-1 and research §3.2 with the exercise contract's first-attempt field and the calibrated interpretation of `P(L)`; MS-3 with the Review-state skill-card choice and the meaning of effective mastery; §13 with a precise lapse definition and attainable target; and §15 with the risk of guessable items, hint retries, and miscalibrated priors. This ADR records those amendments without editing the shared PRD scaffold. More checkpoints cost learner time, so production should measure first-pass rates and opportunity cost by format.

## Follow-ups

- [ ] **ALI-161:** port BKT-lite against the committed golden vectors; carry first-attempt correctness, hint level, item id, format and difficulty in the exercise event; require distinct unassisted checkpoint successes with an attempt limit or cooldown.
- [ ] **M3 mastery implementation:** verify `ts-fsrs` skill-card state and scheduling against the parity fixture; enter Review state at gate graduation, and retain `R(now)` separately from `pMastered`.
- [ ] **MS-7 shadow mode / T3 measurement:** calibrate guess, slip, learning rates, λ_review, diagnostic priors, hint behavior, false openings and observed versus memory lapses on consented real data before treating `P(L)` or the 15% goal as empirical.
