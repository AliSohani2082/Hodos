# Spike (e): BKT-lite and FSRS simulation

**Question.** Do the BKT-lite mastery estimator and FSRS scheduling behave the way the PRD assumes when simulated against synthetic learners?

**Why it matters.** The mastery gate (0.95 by default, with lenient, standard and strict settings) and FSRS review scheduling are what make "mastered" mean the same thing in every course (PRD decision 14, MS-3). The PRD's quality gates are among the highest-value code in v1 (§18), so their defaults should be checked before M3 builds on them.

**Starting points.**

- [`intelligent-tutoring.md`](../../docs/research/intelligent-tutoring.md): the BKT, Elo, rubric and FSRS formulas, and the diagnostic algorithm.
- [`docs/research/sim-diagnostic/`](../../docs/research/sim-diagnostic/): scripts from the earlier simulation of the *diagnostic* (`python3 curve.py`, about 3 minutes). That covers the diagnostic stopping rule (DG-3), **not** BKT-lite or FSRS, so this spike writes new simulations. The scripts are useful as a starting harness (synthetic learners, slip and guess parameters).
- [PRD §13](../../docs/PRD.md#13-success-metrics): targets the simulation can be checked against, such as review lapse rate at target retention 0.9.

Simulations use synthetic learners, so they are not evidence about real ones (`intelligent-tutoring.md` §4.4).

**Exit.** A written go/no-go on both models and their default parameters.

**Status.** Not started.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).
