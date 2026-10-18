# Spike (e): BKT-lite and FSRS simulation

**Question.** Do the BKT-lite mastery estimator and FSRS scheduling behave the way the PRD assumes when simulated against synthetic learners?

**Why it matters.** The mastery gate (0.95 by default, with lenient, standard and strict settings) and FSRS review scheduling are what make "mastered" mean the same thing in every course (PRD decision 14, MS-3). The PRD's quality gates are among the highest-value code in v1 (§18), so their defaults should be checked before M3 builds on them.

**Starting points.**

- [`intelligent-tutoring.md`](../../docs/research/intelligent-tutoring.md): the BKT, Elo, rubric and FSRS formulas, and the diagnostic algorithm.
- [`docs/research/sim-diagnostic/`](../../docs/research/sim-diagnostic/): scripts from the earlier simulation of the *diagnostic* (`python3 curve.py`, about 3 minutes). That covers the diagnostic stopping rule (DG-3), **not** BKT-lite or FSRS, so this spike writes new simulations. The scripts are useful as a starting harness (synthetic learners, slip and guess parameters).
- [PRD §13](../../docs/PRD.md#13-success-metrics): targets the simulation can be checked against, such as review lapse rate at target retention 0.9.

Simulations use synthetic learners, so they are not evidence about real ones (`intelligent-tutoring.md` §4.4).

**Exit.** A written go/no-go on both models and their default parameters.

**Status.** Simulation complete. Run the command below from this directory to regenerate every CSV and table:

```sh
uv run python run.py
```

`uv run pytest -q` checks the estimator and simulation invariants. `uv run python run.py --quick` is a smoke run with fewer learners; its numbers are not the committed results. Python 3.12, `fsrs==6.3.2`, and `pytest==9.1.1` are pinned in `pyproject.toml` and `uv.lock`. The full run uses fixed seeds and takes several minutes; outputs are in [`results/`](results/).

## Gate model and interpretation

Each binary learner begins unmastered (except the knower and diagnostic populations). Practice changes latent knowledge from 0 to 1 with a learner-specific probability drawn from a clipped log-normal distribution (median 0.12, spread 0.6); checkpoints teach nothing. Learner slip is uniform 0.05–0.15. Guess is uniform 0.20–0.40 on four-option MCQ and 0.05–0.20 on open response. The estimator instead uses fixed `T=0.15`, `s0=0.10`, and `g0=0.25` (MCQ) or `0.15` (open response). A separate graded-ability population gains logit ability each practice item; its truth criterion is at least 85% expected unaided accuracy, since it has no binary learning event.

An item pool has 15 questions with true difficulty drawn from N(0, 0.7²); the estimator sees difficulty with N(0, 0.5²) noise. Ids do not repeat until the pool cycles. The five-level hint ladder adds assumed solve boosts of 0.05, 0.15, 0.35, 0.70, and 0.98. Honest learners request hints after a miss with probability drawn uniformly from 0.2–0.9. Chance and test-wise guessers never learn or ask for hints; hint-first and hint-retry abusers never learn and seek help before or after their first try. These choices are hypotheses, not measurements of learner behavior.

One opportunity is one item. Above the threshold, the next item is an unassisted checkpoint when that clause is enabled. A failed checkpoint clears the current gate window. We cap each learner at 60 opportunities and censor any unopened gate. False mastery means the learner is not truly mastered when the gate opens; the report gives both false openings divided by openings and, for adversaries, pass-through divided by learners. Opportunities-to-mastery count all practice and checkpoint items. The `bkt_only`, `distinct_only`, `checkpoint_only`, and `full_ms2` variants isolate the PRD clauses. `full_k2`, `full_k3`, and `first_miss` test proposed changes. Twenty seeds of 200 learners per cell give 4,000 learners; rate intervals are 95% Wilson intervals.

At θ=0.95 on MCQ, the PRD gate has median 9 opportunities and 9.9% false openings for typical learners. Its single checkpoint lets 80.5% of never-learning hint-retry abusers through within 60 opportunities; three distinct checkpoint successes plus recording the first miss reduces this to 6.6%, with median 14 opportunities and 1.0% false openings for typical learners. Constant hint-first help alone rarely passes (0.8%). On open response, the PRD gate has 2.4% false openings for typical learners. Exact tables, intervals, populations, and sensitivity results are in [`results/RESULTS.md`](results/RESULTS.md).

This simulation checks internal behavior under its stated assumptions. It does not measure real learner or hint behavior, item quality, adaptive selection, teacher overrides, checkpoint retry policy, skill transfer, or later retention. In particular, the estimated `P(L)` is not calibrated as a literal probability for graded ability.

## FSRS model and interpretation

`fsrs==6.3.2` schedules 12 skill cards with the FSRS-6 default 21 weights, target retention 0.85/0.90/0.95, no fuzz, and empty learning/relearning steps. A gate graduate starts with a Good review at day 0; the first due interval is two days. The production target is `ts-fsrs`; [`fixtures/ts_fsrs_golden.json`](fixtures/ts_fsrs_golden.json) records a six-review sequence from `ts-fsrs@5.4.2`, and a test checks the Python scheduler's stability, difficulty, and interval against it. Empty steps are an explicit skill-card choice: a graduate is already in Review state. Both libraries use the same defaults for this day-granular path; the fixture does not prove every API path is identical.

True recall uses FSRS-6 with initial-stability weights and the recall-stability growth coefficient multiplied by a learner factor drawn from log-normal σ=0.3 and a skill factor from 0.60–1.75. The scheduler uses unperturbed weights. On each due review, latent remembering is sampled from true R; remembered answers can slip with probability 0/0.05/0.10, and forgotten answers can be guessed correctly with probability 0.15. Correct answers get Good (85%) or Easy (15%); wrong answers get Again. Simulated adherence is perfect, a 15%-per-day skip chance, or a 14-day break. The daily cap is ten reviews over a 365-day course. `pMastered` starts at 0.95 and updates through BKT-lite review mode (λ=0.5); effective mastery is `pMastered × R(now)`. The 12 skills include ten dependent lessons in a small prerequisite graph. A separate break probe at 10/30/60/120 days compares refresh triggers at R thresholds 0.6/0.7/0.8/0.9, assuming the refresh produces a Good answer. These are modeling choices, not fitted memory or adherence data.

[`results/RESULTS.md`](results/RESULTS.md) gives R(t), effective mastery, per-skill lapse, load, interval growth, and refresh costs. Lapses count wrong answers; the report splits them into actual forgetting and slips. At target 0.9 and slip 0.10, the simulated observed lapse exceeds the PRD's 15% target even though the memory-lapse component is near 10%. The target needs a precise definition or different assumptions. This experiment does not establish real retention, content transfer, item-level FSRS behavior, correlated absences, calendar-time effects within a day, or the actual benefit of a prerequisite refresher on downstream lessons.

## Files

- `run.py`: the single reproduction entry point.
- `mastery_sim/bkt_lite.py`: portable estimator; `fixtures/bkt_golden.json`: vectors for the later TypeScript port.
- `mastery_sim/learners.py`, `gate_sim.py`, `gate_report.py`: populations, protocol, tables.
- `mastery_sim/fsrs_sim.py`, `fsrs_report.py`: per-skill review model and tables.
- `results/`: committed CSV and Markdown outputs.

**Verdict.** Go with changes for BKT-lite and FSRS defaults; see [ADR-0005](../../docs/adr/0005-bkt-lite-and-fsrs-defaults.md).
