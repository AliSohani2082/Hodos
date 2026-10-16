"""BKT-lite estimator and mastery gate (PRD MS-1, MS-2; intelligent-tutoring.md section 3.2).

Pure functions on plain floats and dataclasses, standard library only, so it can be ported to
TypeScript line by line (golden vectors for the port: fixtures/bkt_golden.json).

Rules implemented:
  * difficulty-adjusted guess/slip:  g_i = sigma(logit(g0) - b_i),  s_i = sigma(logit(s0) + b_i)
  * soft evidence x in [0,1] and hint discount:  h = hint_level / max_level,  e = x * (1 - h)
    (a correct answer after the bottom-out hint, h = 1, gives e = 0, i.e. it counts as a failure)
  * Jeffrey-style mixture:  P_obs = e * post_correct + (1 - e) * post_wrong
  * learning transition:  P_next = P_obs + (1 - P_obs) * T * lambda_mode
    (lambda: practice 1.0, review 0.5, checkpoint 0)
  * conjunctive multi-skill blame: success interpolates every tagged skill by its weight, failure is
    blamed on skills in proportion to w_k * (1 - P_k), normalised
  * the gate: P >= theta  AND  an unassisted correct checkpoint answer  AND  >= 3 distinct items

Choices the section 3.2 pseudocode leaves open are marked `# CHOICE` and listed in the README.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterable, Literal, Mapping, Sequence

Mode = Literal["practice", "review", "checkpoint"]
HintDiscount = Literal["linear", "none", "any_hint"]

MODE_LAMBDA: Mapping[str, float] = {"practice": 1.0, "review": 0.5, "checkpoint": 0.0}

# CHOICE: P is clamped away from 0 and 1. At exactly 0 or 1 Bayes' rule can never move again.
P_EPS = 1e-4


@dataclass(frozen=True)
class BktParams:
    """Defaults from intelligent-tutoring.md section 3.2 (no data to fit them)."""

    p0: float = 0.10  # prior when the diagnostic has no estimate
    T: float = 0.15  # learning transition per instructional opportunity
    s0: float = 0.10  # slip on a typical item
    g0: float = 0.15  # guess on a typical open-answer item; max(0.15, 1/k) for k-option MCQ
    max_hint_level: int = 5  # hint ladder L1..L5, L5 is bottom-out
    lam: Mapping[str, float] = field(default_factory=lambda: dict(MODE_LAMBDA))
    # "linear" is the PRD rule. "none" and "any_hint" exist only so the simulation can show why.
    hint_discount: HintDiscount = "linear"
    use_difficulty: bool = True  # False ignores item difficulty (ablation for the simulation)


def sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z))


def logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def clamp_p(p: float) -> float:
    return min(1.0 - P_EPS, max(P_EPS, p))


def item_guess_slip(params: BktParams, b: float) -> tuple[float, float]:
    """Guess and slip for an item of difficulty `b` logits (0 = typical, > 0 harder)."""
    if not params.use_difficulty:
        b = 0.0
    g = sigmoid(logit(params.g0) - b)  # easy item -> higher guess -> a correct answer counts for less
    s = sigmoid(logit(params.s0) + b)  # hard item -> higher slip -> a wrong answer counts for less
    return g, s


def hint_fraction(hint_level: int, max_level: int) -> float:
    """h in [0,1]: highest hint level used over the ladder length; the bottom-out hint gives 1."""
    if hint_level < 0 or hint_level > max_level:
        raise ValueError(f"hint_level {hint_level} outside 0..{max_level}")
    return hint_level / max_level


def evidence(x: float, h: float, discount: HintDiscount = "linear") -> float:
    """Evidence of unaided success, e = x * (1 - h) under the PRD rule."""
    if not 0.0 <= x <= 1.0:
        raise ValueError(f"score x={x} outside [0,1]")
    if discount == "linear":
        return x * (1.0 - h)
    if discount == "none":
        return x
    if discount == "any_hint":
        return x if h == 0.0 else 0.0
    raise ValueError(f"unknown hint discount {discount!r}")


def posteriors(p: float, g: float, s: float) -> tuple[float, float]:
    """Bayes posterior of 'knows the skill' after a correct and after a wrong answer."""
    post_c = p * (1.0 - s) / (p * (1.0 - s) + (1.0 - p) * g)
    post_w = p * s / (p * s + (1.0 - p) * (1.0 - g))
    return post_c, post_w


def update(
    p: float,
    *,
    x: float,
    hint_level: int = 0,
    b: float = 0.0,
    mode: Mode = "practice",
    params: BktParams = BktParams(),
) -> float:
    """One observation on a single skill. Returns the new P(L)."""
    p = clamp_p(p)
    g, s = item_guess_slip(params, b)
    h = hint_fraction(hint_level, params.max_hint_level)
    e = evidence(x, h, params.hint_discount)
    post_c, post_w = posteriors(p, g, s)
    p_obs = e * post_c + (1.0 - e) * post_w
    return clamp_p(p_obs + (1.0 - p_obs) * params.T * params.lam[mode])


def blame_shares(p: Mapping[str, float], skills: Sequence[tuple[str, float]]) -> dict[str, float]:
    """Conjunctive blame for a failed multi-skill item: proportional to w_k * (1 - P_k), normalised."""
    raw = {k: w * (1.0 - clamp_p(p[k])) for k, w in skills}
    total = sum(raw.values())
    return {k: v / total for k, v in raw.items()}


def update_multi(
    p: Mapping[str, float],
    skills: Sequence[tuple[str, float]],
    *,
    x: float,
    hint_level: int = 0,
    b: float = 0.0,
    mode: Mode = "practice",
    params: BktParams = BktParams(),
) -> dict[str, float]:
    """One observation on an item tagged with `skills = [(skill_id, weight)]`, weights in (0,1].

    Success moves every tagged skill toward its 'correct' posterior by its weight. Failure moves each
    toward its 'wrong' posterior by its blame share, so the weakest required skill takes most of it.
    The soft-evidence mixture and the transition are applied per skill. With one skill of weight 1
    this reduces exactly to `update`.
    """
    for _, w in skills:
        if not 0.0 < w <= 1.0:
            raise ValueError(f"skill weight {w} outside (0,1]")
    g, s = item_guess_slip(params, b)
    h = hint_fraction(hint_level, params.max_hint_level)
    e = evidence(x, h, params.hint_discount)
    blame = blame_shares(p, skills)
    out = dict(p)
    for k, w in skills:
        pk = clamp_p(p[k])
        post_c, post_w = posteriors(pk, g, s)
        success = pk + w * (post_c - pk)
        failure = pk + blame[k] * (post_w - pk)
        p_obs = e * success + (1.0 - e) * failure
        # CHOICE: the transition is scaled by the skill weight (a skill that is half of an item gets
        # half the practice credit). Section 3.2 does not say.
        out[k] = clamp_p(p_obs + (1.0 - p_obs) * params.T * params.lam[mode] * w)
    return out


@dataclass(frozen=True)
class Attempt:
    """One graded attempt, as the gate sees it."""

    item_id: str
    mode: Mode
    e: float  # evidence after the hint discount
    h: float  # hint fraction, 0 = unassisted


def gate_open(
    p: float,
    window: Iterable[Attempt],
    *,
    theta: float = 0.95,
    require_unassisted_checkpoint: bool = True,
    require_distinct_items: bool = True,
    min_distinct_items: int = 3,
    min_checkpoint_e: float = 0.8,
    min_unassisted_checkpoints: int = 1,
) -> bool:
    """MS-2. `window` holds the attempts in the current gate window (the caller decides where it starts).

    The two `require_*` switches exist so the simulation can show what each clause buys; production
    has both on. `min_unassisted_checkpoints` is 1 in the PRD; the simulation tries 2 and 3.
    """
    attempts = list(window)
    if p < theta:
        return False
    if require_unassisted_checkpoint and (
        len({a.item_id for a in attempts if a.mode == "checkpoint" and a.e >= min_checkpoint_e and a.h == 0.0})
        < min_unassisted_checkpoints
    ):
        return False
    if require_distinct_items and len({a.item_id for a in attempts}) < min_distinct_items:
        return False
    return True
