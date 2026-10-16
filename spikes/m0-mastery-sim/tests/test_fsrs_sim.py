"""Scheduler and review experiment invariants."""

from datetime import timedelta
from pathlib import Path
import json

import pytest

from fsrs import Card, Rating

from mastery_sim.fsrs_sim import PREREQ, START, refresh_scenarios, scheduler, simulate


def test_first_good_review_is_about_two_days_and_decays():
    s = scheduler()
    card, _ = s.review_card(Card(card_id=1), Rating.Good, START)
    assert (card.due - START).days == 2
    assert s.get_card_retrievability(card, START + timedelta(days=2)) < s.get_card_retrievability(card, START + timedelta(days=1))


def test_fixed_seed_and_effective_mastery():
    a, curve, load = simulate(3, days=30)
    assert (a, curve, load) == simulate(3, days=30)
    assert len(a) == 12 and len(load) == 30
    assert all(0 <= x["R"] <= 1 and x["effective_mastery"] == x["pMastered"] * x["R"] for x in curve)
    assert all(x["memory_lapses"] + x["slip_lapses"] == x["lapses"] for x in a)


def test_prerequisite_refresh_fires_below_threshold():
    rows = refresh_scenarios()
    assert len(rows) == 16
    assert all(x["prerequisites"] == len(PREREQ) and 0 <= x["refreshes"] <= len(PREREQ) for x in rows)
    assert all(x["recall_with"] >= x["recall_without"] for x in rows)
    assert any(x["refreshes"] for x in rows if x["threshold"] == 0.7)


def test_python_scheduler_matches_ts_fsrs_golden_sequence():
    path = Path(__file__).resolve().parents[1] / "fixtures" / "ts_fsrs_golden.json"
    sequence = json.loads(path.read_text())["sequence"]
    s, card, day = scheduler(), Card(card_id=1), 0
    for row in sequence:
        day += row["elapsed"]
        now = START + timedelta(days=day)
        card, _ = s.review_card(card, Rating(row["grade"]), now)
        assert card.stability == pytest.approx(row["stability"], abs=1e-5)
        assert card.difficulty == pytest.approx(row["difficulty"], abs=1e-5)
        assert (card.due - now).days == row["interval"]
