"""Checks that the gate experiment represents its named populations and is repeatable."""

import random

from mastery_sim.gate_sim import Cell, run_one
from mastery_sim.learners import ItemPool, Learner, POPULATIONS


def test_fixed_seed_reproduces_an_entire_gate_trace():
    cell = Cell("typical", "mcq4", 0.95, "full_ms2")
    assert run_one(cell, 7, 13) == run_one(cell, 7, 13)


def test_known_truth_for_extreme_populations():
    for name in ("guesser_chance", "guesser_testwise", "hint_abuser_first", "hint_abuser_retry"):
        learner = Learner(POPULATIONS[name], "mcq4", random.Random(4), random.Random(5))
        for t in range(1, 30):
            learner.learn(t)
        assert not learner.mastered() and learner.t_master is None
    knower = Learner(POPULATIONS["knower"], "mcq4", random.Random(4), random.Random(5))
    assert knower.mastered() and knower.t_master == 0


def test_checkpoint_forces_one_unassisted_attempt():
    for name in ("hint_abuser_first", "hint_abuser_retry"):
        rng = random.Random(4)
        learner = Learner(POPULATIONS[name], "mcq4", rng, random.Random(5))
        _, level, first = learner.attempt(ItemPool(rng).next(), "checkpoint")
        assert level == 0 and first is not None


def test_hint_first_has_no_first_attempt():
    rng = random.Random(4)
    learner = Learner(POPULATIONS["hint_abuser_first"], "mcq4", rng, random.Random(5))
    _, level, first = learner.attempt(ItemPool(rng).next(), "practice")
    assert level > 0 and first is None
