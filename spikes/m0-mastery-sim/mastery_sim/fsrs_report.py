"""CSV and Markdown outputs for the per-skill FSRS experiment."""

from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path
from statistics import mean

from .fsrs_sim import SKILLS, refresh_scenarios, simulate
from .bkt_lite import BktParams, update
from .stats import wilson


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, rows[0].keys(), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def rate(n: int, d: int) -> str:
    p, lo, hi = wilson(n, d)
    return f"{100*p:.1f}% [{100*lo:.1f}, {100*hi:.1f}]"


def run_fsrs(out_dir: Path, quick: bool = False) -> str:
    seeds = range(3 if quick else 20)
    scenarios = [(r, s, a) for r in (0.85, 0.9, 0.95)
                 for s in (0.0, 0.05, 0.1) for a in ("perfect", "skip15", "break14")]
    summaries, curves, loads = [], [], []
    for retention, slip, adherence in scenarios:
        for seed in seeds:
            rows, curve, load = simulate(seed, retention, slip, adherence,
                                         days=90 if quick else 365)
            for row in rows:
                row.update(retention=retention, slip=slip, adherence=adherence)
            summaries.extend(rows)
            if retention == 0.9 and slip == 0.1 and adherence in ("perfect", "break14") and seed == 0:
                curves.extend(curve)
            if retention == 0.9 and slip == 0.1 and adherence == "perfect":
                loads.extend(load)
    refresh = refresh_scenarios()
    # Keep committed evidence compact: aggregate seed-level counts by scenario and skill.
    compact = []
    by_skill = defaultdict(list)
    for row in summaries:
        by_skill[(row["retention"], row["slip"], row["adherence"], row["skill"])].append(row)
    for (retention, slip, adherence, skill), rows in sorted(by_skill.items()):
        compact.append(dict(retention=retention, slip=slip, adherence=adherence, skill=skill,
                            seeds=len(rows), reviews=sum(x["reviews"] for x in rows),
                            lapses=sum(x["lapses"] for x in rows),
                            memory_lapses=sum(x["memory_lapses"] for x in rows),
                            slip_lapses=sum(x["slip_lapses"] for x in rows),
                            first_interval_mean=mean(x["first_interval"] for x in rows),
                            final_interval_mean=mean(x["final_interval"] for x in rows),
                            pMastered_mean=mean(x["pMastered"] for x in rows),
                            R_mean=mean(x["R"] for x in rows),
                            R_true_mean=mean(x["R_true"] for x in rows)))
    daily = []
    by_day = defaultdict(list)
    for row in loads:
        by_day[row["day"]].append(row)
    for day, rows in sorted(by_day.items()):
        daily.append(dict(day=day, seeds=len(rows), due=sum(x["due"] for x in rows),
                          completed=sum(x["completed"] for x in rows),
                          peak_due=max(x["due"] for x in rows)))
    write_csv(out_dir / "fsrs_per_skill.csv", compact)
    write_csv(out_dir / "fsrs_rt_curves.csv", curves)
    write_csv(out_dir / "fsrs_daily_load.csv", daily)
    write_csv(out_dir / "fsrs_refresh.csv", refresh)

    lines = [
        f"FSRS 6 via `fsrs==6.3.2`, default 21 weights, day-granular, no fuzz, no learning/relearning steps; {len(seeds)} fixed seeds × 12 skills × {90 if quick else 365} days. True initial-stability weights 0–3 and the exp(w8) recall-stability growth coefficient are multiplied by a learner log-normal factor (σ=0.3) and skill factors 0.60–1.75. Scheduler uses unperturbed weights. Initial Good review at day 0 represents graduation from the gate. Each due review draws latent remembering from true R, then an observed answer with slip s or chance guess 0.15. Correct responses are Easy 15% of the time, otherwise Good; errors are Again. Daily review cap is 10. Answer slip and actual forgetting are counted separately.\n",
        "### F1. Retention, adherence, and observed lapse\n",
        "| Target R | Slip | Attendance | Reviews | Observed lapse (95% CI) | Memory lapse / review | Slip lapse / review | Mean reviews / skill-year |",
        "|---:|---:|---|---:|---:|---:|---:|---:|",
    ]
    groups = defaultdict(list)
    for row in summaries:
        groups[(row["retention"], row["slip"], row["adherence"])].append(row)
    for (r, s, a), rows in sorted(groups.items()):
        reviews = sum(x["reviews"] for x in rows)
        lapses = sum(x["lapses"] for x in rows)
        mem = sum(x["memory_lapses"] for x in rows)
        slips = sum(x["slip_lapses"] for x in rows)
        lines.append(f"| {r:.2f} | {s:.2f} | {a} | {reviews} | {rate(lapses, reviews)} | {100*mem/reviews:.1f}% | {100*slips/reviews:.1f}% | {mean(x['reviews'] for x in rows):.1f} |")
    lines += ["\n### F2. Per-skill review at target 0.90, slip 0.10, perfect attendance\n",
              "| Skill | Reviews / year | Lapse (95% CI) | First → final interval, days | R(day 365) | pMastered | Effective mastery | True R |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for skill in SKILLS:
        rows = [x for x in groups[(0.9, 0.1, "perfect")] if x["skill"] == skill]
        reviews = sum(x["reviews"] for x in rows)
        lapses = sum(x["lapses"] for x in rows)
        lines.append(f"| {skill} | {mean(x['reviews'] for x in rows):.1f} | {rate(lapses, reviews)} | {mean(x['first_interval'] for x in rows):.0f} → {mean(x['final_interval'] for x in rows):.0f} | {mean(x['R'] for x in rows):.3f} | {mean(x['pMastered'] for x in rows):.3f} | {mean(x['pMastered']*x['R'] for x in rows):.3f} | {mean(x['R_true'] for x in rows):.3f} |")
    lines += ["\n### F3. R(t) and effective mastery samples\n",
              "Selected day samples for all 12 skills and two adherence cases are in `fsrs_rt_curves.csv`; below is one representative skill, seed 0, perfect attendance. True effective mastery equals true R because all skills begin truly known at gate graduation.\n",
              "| Day | Scheduler R | True R | pMastered | Effective mastery |",
              "|---:|---:|---:|---:|---:|"]
    for row in curves:
        if row["skill"] == "foundations" and row["seed"] == 0 and row["adherence"] == "perfect" and row["day"] in (1, 7, 30, 90, 180, 365):
            lines.append(f"| {row['day']} | {row['R']:.3f} | {row['R_true']:.3f} | {row['pMastered']:.3f} | {row['effective_mastery']:.3f} |")
    lines += ["\n### F4. Prerequisite refresh after a break\n",
              "Ten dependent lessons each have one prerequisite with an initial Hard, Good, or Easy review. A fresh-item Good refresh occurs before the lesson when its R is below the threshold; predicted recall is sampled the next day. This isolates the threshold rule from the daily scheduler and assumes the refresh succeeds.\n",
              "| Break, days | Threshold | Refreshes / 10 | Recall without | Recall with |",
              "|---:|---:|---:|---:|---:|"]
    for row in refresh:
        lines.append(f"| {row['break_days']} | {row['threshold']:.1f} | {row['refreshes']} | {row['recall_without']:.3f} | {row['recall_with']:.3f} |")
    if loads:
        lines += ["\n### F5. Daily load at target 0.90, slip 0.10, perfect attendance\n",
                  f"Mean completed reviews/day/learner: {mean(x['completed'] for x in loads):.2f}; peak due/day: {max(x['due'] for x in loads)}; days exceeding the 10-review cap: {sum(x['due'] > 10 for x in loads)}/{len(loads)}. Daily totals across seeds are in `fsrs_daily_load.csv`.\n"]
    lines += ["\n### F6. BKT review-credit sensitivity after one wrong review\n",
              "Starting at pMastered=0.95, a wrong review at b=0 updates BKT-lite as follows. This is a deterministic rule probe; F1–F5 use λ_review=0.5.\n",
              "| λ_review | pMastered after error | Effective mastery at R=0.9 |",
              "|---:|---:|---:|"]
    for lam in (0.0, 0.5, 1.0):
        p = update(0.95, x=0, mode="review", params=BktParams(lam={"practice": 1.0, "review": lam, "checkpoint": 0.0}))
        lines.append(f"| {lam:.1f} | {p:.3f} | {p*0.9:.3f} |")
    lines.append("\n**Interpretation:** A target R of 0.90 is a memory-retention target, not a guarantee that 90% of answers are correct. With slip 0.10 and guess 0.15, even perfectly calibrated R=0.90 implies 17.5% observed wrong answers: `1 − (0.9×0.9 + 0.1×0.15)`. Compare F1 with the PRD's ≤15% observed-lapse target.\n")
    return "\n".join(lines)
