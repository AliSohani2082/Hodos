"""Daily per-skill FSRS experiment with latent recall and noisy answers."""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from math import exp, log

from fsrs import Card, Rating, Scheduler

from .bkt_lite import BktParams, update

START = datetime(2026, 1, 1, tzinfo=timezone.utc)
SKILLS = ("foundations", "syntax", "types", "control", "functions", "data", "errors", "modules",
          "testing", "algorithms", "design", "integration")
SKILL_SCALE = (0.60, 0.75, 0.85, 0.95, 1.0, 1.05, 1.15, 1.25, 1.35, 1.45, 1.60, 1.75)
PREREQ = {"types": "foundations", "control": "syntax", "functions": "control",
          "data": "types", "errors": "functions", "modules": "functions", "testing": "functions",
          "algorithms": "data", "design": "modules", "integration": "design"}


def scheduler(retention: float = 0.9, scale: float = 1.0) -> Scheduler:
    weights = list(Scheduler().parameters)
    for i in range(4):
        weights[i] *= scale
    weights[8] += log(scale)  # exp(w8) is the recall-stability growth coefficient
    return Scheduler(parameters=weights, desired_retention=retention, learning_steps=(),
                     relearning_steps=(), enable_fuzzing=False)


@dataclass
class Skill:
    name: str
    sched_card: Card
    true_card: Card
    p: float = 0.95
    reviews: int = 0
    lapses: int = 0
    memory_lapses: int = 0
    slip_lapses: int = 0
    due_intervals: list[int] | None = None


def simulate(seed: int, retention: float = 0.9, slip: float = 0.1,
             adherence: str = "perfect", easy_rate: float = 0.15,
             review_lambda: float = 0.5, days: int = 365) -> tuple[list[dict], list[dict], list[dict]]:
    """One learner; due reviews obey a ten-per-day cap. The true memory uses perturbed FSRS weights."""
    rng = random.Random(f"ali41/fsrs/{seed}/{retention}/{slip}/{adherence}/{easy_rate}/{review_lambda}")
    est = scheduler(retention)
    learner_scale = exp(rng.gauss(0, 0.3))
    truths = [scheduler(retention, learner_scale * scale) for scale in SKILL_SCALE]
    skills = []
    for i, name in enumerate(SKILLS):
        card, _ = est.review_card(Card(card_id=i + 1), Rating.Good, START)
        true_card, _ = truths[i].review_card(Card(card_id=100 + i), Rating.Good, START)
        skills.append(Skill(name, card, true_card, due_intervals=[(card.due - START).days]))
    curve, load = [], []
    for day in range(1, days + 1):
        now = START + timedelta(days=day)
        absent = adherence == "break14" and 90 <= day < 104
        absent |= adherence == "skip15" and rng.random() < 0.15
        due = sorted((i for i, skill in enumerate(skills) if skill.sched_card.due <= now),
                     key=lambda i: skills[i].sched_card.due)
        chosen = [] if absent else due[:10]
        for i in chosen:
            skill = skills[i]
            true_r = truths[i].get_card_retrievability(skill.true_card, now)
            remembered = rng.random() < true_r
            correct = rng.random() < (1 - slip if remembered else 0.15)
            if not correct:
                skill.lapses += 1
                skill.memory_lapses += not remembered
                skill.slip_lapses += remembered
            rating = Rating.Again if not correct else Rating.Easy if rng.random() < easy_rate else Rating.Good
            skill.sched_card, _ = est.review_card(skill.sched_card, rating, now)
            skill.true_card, _ = truths[i].review_card(skill.true_card, rating, now)
            skill.p = update(skill.p, x=float(correct), mode="review",
                             params=BktParams(lam={"practice": 1.0, "review": review_lambda,
                                                    "checkpoint": 0.0}))
            skill.reviews += 1
            skill.due_intervals.append((skill.sched_card.due - now).days)
        load.append(dict(seed=seed, day=day, due=len(due), completed=len(chosen)))
        if day in (1, 2, 7, 14, 30, 60, 90, 104, 180, 270, 365):
            for i, skill in enumerate(skills):
                r = est.get_card_retrievability(skill.sched_card, now)
                true_r = truths[i].get_card_retrievability(skill.true_card, now)
                curve.append(dict(seed=seed, day=day, skill=skill.name, adherence=adherence, R=r,
                                  R_true=true_r, pMastered=skill.p,
                                  effective_mastery=skill.p * r, true_effective=true_r))
    summary = [dict(seed=seed, skill=s.name, reviews=s.reviews, lapses=s.lapses,
                    memory_lapses=s.memory_lapses, slip_lapses=s.slip_lapses,
                    first_interval=s.due_intervals[0], final_interval=s.due_intervals[-1],
                    pMastered=s.p, R=est.get_card_retrievability(s.sched_card, START + timedelta(days=days)),
                    R_true=truths[i].get_card_retrievability(s.true_card, START + timedelta(days=days)))
               for i, s in enumerate(skills)]
    return summary, curve, load


def refresh_scenarios() -> list[dict]:
    """Prerequisite check immediately after a break from an initially mastered skill.

    A refresh is one immediate, fresh-item review; recall at lesson start is measured on
    the next day. This isolates the R threshold from the normal daily review schedule.
    """
    rows = []
    for break_days in (10, 30, 60, 120):
        for threshold in (0.6, 0.7, 0.8, 0.9):
            n_fire, r_without, r_with = 0, 0.0, 0.0
            for i, name in enumerate(SKILLS):
                if name not in PREREQ:
                    continue
                est = scheduler()
                grade = (Rating.Hard, Rating.Good, Rating.Easy)[i % 3]
                card, _ = est.review_card(Card(card_id=i + 1), grade, START)
                now = START + timedelta(days=break_days)
                r0 = est.get_card_retrievability(card, now)
                r_without += est.get_card_retrievability(card, now + timedelta(days=1))
                if r0 < threshold:
                    n_fire += 1
                    card, _ = est.review_card(card, Rating.Good, now)
                r_with += est.get_card_retrievability(card, now + timedelta(days=1))
            n = len(PREREQ)
            rows.append(dict(break_days=break_days, threshold=threshold,
                             refreshes=n_fire, prerequisites=n,
                             recall_without=r_without / n, recall_with=r_with / n))
    return rows
