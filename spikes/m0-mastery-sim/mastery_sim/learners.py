"""Simulated learners for the gate experiment (ALI-64). The generative model is stated in README.md.

Two knowledge models:
  * binary      latent L in {0,1}; P(L: 0 -> 1) = T_true per practice item. BKT-shaped, but with
                heterogeneous learners and noisy item difficulty, so the estimator's defaults are
                *not* the truth.
  * continuous  ability a (logits) grows by eta per practice item; p(correct) = g + (1-g-s)*sigma(a-b).
                There is no 'learned' moment, which is the case BKT assumes away. 'Mastered' means
                expected unaided accuracy over the item distribution >= MASTERY_ACCURACY.
"""

from __future__ import annotations

import math
import random
from statistics import NormalDist
from dataclasses import dataclass
from functools import lru_cache

from .bkt_lite import logit, sigmoid

# P(a not-yet-solved item gets solved | hint level L1..L5 shown). L1 only orients, L5 is bottom-out.
# ASSUMPTION: the prototype of the ladder in intelligent-tutoring.md section 5.2; not measured.
HINT_BOOST = (0.05, 0.15, 0.35, 0.70, 0.98)

ITEM_B_SD = 0.7  # true item difficulty spread, logits
ITEM_B_EST_SD = 0.5  # error of the difficulty the estimator is given (LLM estimate -> teacher edit)
POOL_SIZE = 15
MASTERY_ACCURACY = 0.85  # continuous model: unaided accuracy over the pool that counts as 'mastered'
CONT_SLIP_FLOOR = 0.05
_STD_NORMAL = NormalDist()

FORMATS = {
    # estimator g0 (section 3.2: max(0.15, 1/k) for k-option MCQ), and learner guess ranges
    "mcq4": dict(g0=0.25, g_typ=(0.20, 0.40), g_chance=0.25, g_testwise=0.40),
    "open": dict(g0=0.15, g_typ=(0.05, 0.20), g_chance=0.10, g_testwise=0.20),
}


@dataclass(frozen=True)
class Item:
    id: int
    b_true: float
    b_est: float


class ItemPool:
    """Cycles a shuffled pool, so ids are distinct until the pool is exhausted."""

    def __init__(self, rng: random.Random, size: int = POOL_SIZE):
        self.items = [
            Item(i, b := rng.gauss(0.0, ITEM_B_SD), b + rng.gauss(0.0, ITEM_B_EST_SD)) for i in range(size)
        ]
        self.rng = rng
        self._order: list[int] = []

    def next(self) -> Item:
        if not self._order:
            self._order = list(range(len(self.items)))
            self.rng.shuffle(self._order)
        return self.items[self._order.pop()]


@dataclass(frozen=True)
class Population:
    name: str
    kind: str = "binary"  # binary | continuous
    p_init_true: float = 0.0  # binary: P(already knows the skill)
    p0_est: float = 0.10  # the prior the estimator starts from (diagnostic output or default)
    T_median: float = 0.12  # binary: median true learning rate per practice item
    T_sigma: float = 0.6  # log-normal spread
    never_learns: bool = False
    guess: str = "typ"  # typ | chance | testwise
    guess_depends_on_b: bool = True  # False = constant (chance-level) guessing
    hints: str = "honest"  # honest | none | first | retry
    pi_range: tuple[float, float] = (0.2, 0.9)  # honest: P(ask for a hint after a wrong first attempt)
    note: str = ""


POPULATIONS = {
    p.name: p
    for p in [
        Population("typical", note="starts unmastered, learns at a heterogeneous rate, uses hints honestly"),
        Population("knower", p_init_true=1.0, note="already knows the skill, no diagnostic (prior 0.10)"),
        Population("diag_calibrated", p_init_true=0.8, p0_est=0.8, note="diagnostic prior 0.8, truth 0.8"),
        Population("diag_miscalibrated", p_init_true=0.5, p0_est=0.8, note="diagnostic prior 0.8, truth 0.5"),
        Population("guesser_chance", never_learns=True, guess="chance", guess_depends_on_b=False, hints="none",
                   note="never learns, answers at chance, asks for no hints"),
        Population("guesser_testwise", never_learns=True, guess="testwise", guess_depends_on_b=False,
                   hints="none", note="never learns, 'test-wise' guesser, above the estimator's g0"),
        Population("hint_abuser_first", never_learns=True, hints="first",
                   note="never learns; requests hints before attempting, escalates until correct"),
        Population("hint_abuser_retry", never_learns=True, hints="retry", pi_range=(1.0, 1.0),
                   note="never learns; guesses first, then climbs the ladder after every miss"),
        Population("typical_continuous", kind="continuous",
                   note="graded ability with no learning moment (model misspecified for BKT)"),
    ]
}


@lru_cache(maxsize=None)
def _accuracy_over_pool(a: float, g: float, s: float) -> float:
    """Expected unaided accuracy over b ~ N(0, ITEM_B_SD), on a fixed 101-point quantile grid."""
    n = 101
    total = 0.0
    for i in range(n):
        b = _STD_NORMAL.inv_cdf((i + 0.5) / n) * ITEM_B_SD
        total += g + (1 - g - s) * sigmoid(a - b)
    return total / n


@lru_cache(maxsize=None)
def ability_for_mastery(g: float, s: float = CONT_SLIP_FLOOR) -> float:
    lo, hi = -6.0, 10.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if _accuracy_over_pool(round(mid, 6), g, s) < MASTERY_ACCURACY:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


class Learner:
    """One simulated learner. All randomness comes from the two streams it is given."""

    def __init__(self, pop: Population, fmt: str, traits: random.Random, resp: random.Random):
        f = FORMATS[fmt]
        self.pop, self.resp = pop, resp
        self.p0_est = pop.p0_est
        self.s = traits.uniform(0.05, 0.15)
        if pop.guess == "typ":
            self.g = traits.uniform(*f["g_typ"])
        else:
            self.g = f["g_chance"] if pop.guess == "chance" else f["g_testwise"]
        self.pi = traits.uniform(*pop.pi_range)
        self.t_master: int | None = None  # opportunity at which the learner became mastered (0 = from start)
        if pop.kind == "binary":
            self.T = 0.0 if pop.never_learns else min(0.5, max(0.02, traits.lognormvariate(math.log(pop.T_median), pop.T_sigma)))
            self.L = traits.random() < pop.p_init_true
            self.t_master = 0 if self.L else None
        else:
            self.eta = traits.lognormvariate(math.log(0.30), 0.5)
            self.a = traits.gauss(-1.5, 0.7)
            self.a_star = ability_for_mastery(round(self.g, 2))
            self.t_master = 0 if self.a >= self.a_star else None
        self.n_practice = 0

    # -- truth ------------------------------------------------------------------------------------
    def mastered(self) -> bool:
        return self.L if self.pop.kind == "binary" else self.a >= self.a_star

    def learn(self, t: int) -> None:
        """Called after each practice item (not after checkpoint items: assessment is not instruction)."""
        if self.pop.kind == "binary":
            if not self.L and self.resp.random() < self.T:
                self.L = True
        else:
            self.a += self.eta
        if self.t_master is None and self.mastered():
            self.t_master = t

    # -- responses --------------------------------------------------------------------------------
    def p_unaided(self, item: Item) -> float:
        if self.pop.kind == "binary":
            if self.L:
                return 1.0 - sigmoid(logit(self.s) + item.b_true)
            if self.pop.guess_depends_on_b:
                return sigmoid(logit(self.g) - item.b_true)
            return self.g
        return self.g + (1.0 - self.g - CONT_SLIP_FLOOR) * sigmoid(self.a - item.b_true)

    def expected_accuracy(self, pool: ItemPool) -> float:
        """True unaided accuracy over the item pool right now (the quantity 'mastery' stands for)."""
        return sum(self.p_unaided(i) for i in pool.items) / len(pool.items)

    def attempt(self, item: Item, mode: str) -> tuple[float, int, bool | None]:
        """Returns (x, hint_level, first_attempt_correct). The last is None when the learner asked for a
        hint before attempting. Checkpoint: one unaided try. Practice: depends on the hint policy."""
        p = self.p_unaided(item)
        r = self.resp
        if mode == "checkpoint" or self.pop.hints == "none":
            ok = r.random() < p
            return (1.0 if ok else 0.0), 0, ok
        if self.pop.hints == "first":
            x, level = self._climb(p)
            return x, level, None
        if r.random() < p:
            return 1.0, 0, True
        if r.random() < self.pi:  # honest and retry learners ask for help after a miss
            x, level = self._climb(p)
            return x, level, False
        return 0.0, 0, False

    def _climb(self, p: float) -> tuple[float, int]:
        for level, boost in enumerate(HINT_BOOST, start=1):
            if self.resp.random() < p + (1.0 - p) * boost:
                return 1.0, level
        return 0.0, len(HINT_BOOST)
