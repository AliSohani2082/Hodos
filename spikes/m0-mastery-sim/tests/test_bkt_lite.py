"""One test group per rule in PRD MS-1/MS-2 (ALI-63 acceptance)."""

import math

import pytest

from mastery_sim.bkt_lite import (
    Attempt,
    BktParams,
    blame_shares,
    evidence,
    gate_open,
    hint_fraction,
    item_guess_slip,
    logit,
    posteriors,
    sigmoid,
    update,
    update_multi,
)

D = BktParams()  # section 3.2 defaults: p0 0.1, T 0.15, s0 0.10, g0 0.15


# ---- difficulty-adjusted guess/slip ------------------------------------------------------------
def test_typical_item_uses_base_guess_and_slip():
    g, s = item_guess_slip(D, 0.0)
    assert g == pytest.approx(D.g0) and s == pytest.approx(D.s0)


def test_hard_items_slip_more_and_guess_less():
    g0, s0 = item_guess_slip(D, 0.0)
    g1, s1 = item_guess_slip(D, 1.5)
    assert g1 < g0 and s1 > s0


def test_easy_items_guess_more_and_slip_less():
    g0, s0 = item_guess_slip(D, 0.0)
    g1, s1 = item_guess_slip(D, -1.5)
    assert g1 > g0 and s1 < s0


def test_guess_slip_stay_probabilities_for_extreme_difficulty():
    for b in (-8, -3, 3, 8):
        g, s = item_guess_slip(D, b)
        assert 0 < g < 1 and 0 < s < 1


def test_difficulty_matters_for_the_update():
    # A correct answer on an easy item is weaker evidence than on a hard item.
    assert update(0.3, x=1, b=-1.5, mode="checkpoint") < update(0.3, x=1, b=1.5, mode="checkpoint")
    # A wrong answer on a hard item is weaker evidence than on an easy item.
    assert update(0.6, x=0, b=1.5, mode="checkpoint") > update(0.6, x=0, b=-1.5, mode="checkpoint")


def test_ablation_ignores_difficulty():
    p = BktParams(use_difficulty=False)
    assert update(0.3, x=1, b=2.0, params=p) == pytest.approx(update(0.3, x=1, b=0.0, params=p))


# ---- soft evidence -----------------------------------------------------------------------------
def test_soft_evidence_is_a_mixture_of_the_two_posteriors():
    g, s = item_guess_slip(D, 0.0)
    post_c, post_w = posteriors(0.4, g, s)
    for x in (0.0, 0.25, 0.5, 1.0):
        expected = x * post_c + (1 - x) * post_w
        assert update(0.4, x=x, mode="checkpoint") == pytest.approx(expected)


def test_posterior_is_monotone_in_score_and_stays_in_unit_interval():
    prev = -1.0
    for i in range(11):
        v = update(0.37, x=i / 10, mode="practice")
        assert 0 <= v <= 1 and v > prev
        prev = v


def test_score_outside_unit_interval_is_rejected():
    with pytest.raises(ValueError):
        update(0.5, x=1.2)
    with pytest.raises(ValueError):
        update(0.5, x=-0.1)


def test_multiple_checkpoint_successes_must_use_distinct_items():
    repeated = [Attempt("a", "checkpoint", 1.0, 0.0), Attempt("a", "checkpoint", 1.0, 0.0),
                Attempt("b", "practice", 1.0, 0.0), Attempt("c", "practice", 1.0, 0.0)]
    assert not gate_open(0.99, repeated, min_unassisted_checkpoints=2)
    distinct = [*repeated, Attempt("b", "checkpoint", 1.0, 0.0)]
    assert gate_open(0.99, distinct, min_unassisted_checkpoints=2)


# ---- hint discount -----------------------------------------------------------------------------
def test_hint_fraction_and_discount_formula():
    assert hint_fraction(0, 5) == 0 and hint_fraction(5, 5) == 1 and hint_fraction(2, 5) == pytest.approx(0.4)
    assert evidence(1.0, 0.4) == pytest.approx(0.6)
    assert evidence(0.5, 0.4) == pytest.approx(0.3)
    with pytest.raises(ValueError):
        hint_fraction(6, 5)


def test_correct_after_bottom_out_hint_counts_as_a_failure():
    assert update(0.5, x=1, hint_level=5) == pytest.approx(update(0.5, x=0, hint_level=0))
    assert update(0.5, x=1, hint_level=5, mode="checkpoint") == pytest.approx(
        update(0.5, x=0, hint_level=0, mode="checkpoint")
    )


def test_more_help_means_less_credit():
    vals = [update(0.4, x=1, hint_level=lv, mode="checkpoint") for lv in range(6)]
    assert vals == sorted(vals, reverse=True) and vals[0] > vals[-1]


def test_alternative_discounts_used_by_the_simulation():
    none = BktParams(hint_discount="none")
    anyh = BktParams(hint_discount="any_hint")
    assert update(0.4, x=1, hint_level=5, params=none) == pytest.approx(update(0.4, x=1, hint_level=0, params=none))
    assert update(0.4, x=1, hint_level=1, params=anyh) == pytest.approx(update(0.4, x=0, hint_level=0, params=anyh))


# ---- per-mode lambda ---------------------------------------------------------------------------
def test_checkpoint_has_no_learning_transition():
    g, s = item_guess_slip(D, 0.0)
    post_c, _ = posteriors(0.4, g, s)
    assert update(0.4, x=1, mode="checkpoint") == pytest.approx(post_c)


def test_lambda_scales_the_transition_practice_1_review_half_checkpoint_0():
    g, s = item_guess_slip(D, 0.0)
    post_c, _ = posteriors(0.4, g, s)
    gain = lambda mode: update(0.4, x=1, mode=mode) - post_c  # noqa: E731
    assert gain("checkpoint") == pytest.approx(0.0)
    assert gain("practice") == pytest.approx((1 - post_c) * D.T)
    assert gain("review") == pytest.approx(0.5 * gain("practice"))


# ---- arithmetic claims in intelligent-tutoring.md section 3.2 ------------------------------------
def test_three_clean_correct_answers_from_p0_0_1_reach_0_98():
    p = 0.10
    for _ in range(3):
        p = update(p, x=1, mode="practice")
    assert p == pytest.approx(0.98, abs=0.005) and p >= 0.95


def test_two_correct_answers_from_p0_0_3_pass_0_95_but_two_from_0_1_do_not():
    p = 0.30
    for _ in range(2):
        p = update(p, x=1, mode="practice")
    assert p >= 0.95
    q = 0.10
    for _ in range(2):
        q = update(q, x=1, mode="practice")
    assert q < 0.95


# ---- conjunctive multi-skill blame ---------------------------------------------------------------
def test_single_skill_multi_update_equals_single_update():
    for x, lv, mode in [(1, 0, "practice"), (0, 0, "practice"), (0.6, 2, "review"), (1, 0, "checkpoint")]:
        multi = update_multi({"a": 0.35}, [("a", 1.0)], x=x, hint_level=lv, mode=mode)["a"]
        assert multi == pytest.approx(update(0.35, x=x, hint_level=lv, mode=mode))


def test_blame_goes_to_the_weakest_skill_and_sums_to_one():
    shares = blame_shares({"a": 0.95, "b": 0.30}, [("a", 1.0), ("b", 1.0)])
    assert sum(shares.values()) == pytest.approx(1.0)
    assert shares["b"] > 0.9 > shares["a"]


def test_blame_scales_with_weight():
    shares = blame_shares({"a": 0.5, "b": 0.5}, [("a", 1.0), ("b", 0.25)])
    assert shares["a"] == pytest.approx(0.8) and shares["b"] == pytest.approx(0.2)


def test_failure_drops_the_weak_skill_more_than_the_strong_one():
    before = {"a": 0.95, "b": 0.30}
    after = update_multi(before, [("a", 1.0), ("b", 1.0)], x=0, mode="checkpoint")
    assert before["b"] - after["b"] > before["a"] - after["a"]
    assert before["a"] - after["a"] < 0.1


def test_success_raises_all_tagged_skills_and_leaves_others_alone():
    before = {"a": 0.4, "b": 0.5, "c": 0.7}
    after = update_multi(before, [("a", 1.0), ("b", 0.5)], x=1, mode="checkpoint")
    assert after["a"] > before["a"] and after["b"] > before["b"] and after["c"] == before["c"]
    # a half-weight skill moves about half as far toward the correct posterior
    assert (after["b"] - before["b"]) < (after["a"] - before["a"]) * 1.2


def test_bad_weights_are_rejected():
    with pytest.raises(ValueError):
        update_multi({"a": 0.5}, [("a", 0.0)], x=1)


def test_multi_skill_hint_discount_applies_to_every_skill():
    a = update_multi({"a": 0.5, "b": 0.5}, [("a", 1.0), ("b", 1.0)], x=1, hint_level=5, mode="checkpoint")
    f = update_multi({"a": 0.5, "b": 0.5}, [("a", 1.0), ("b", 1.0)], x=0, hint_level=0, mode="checkpoint")
    assert a["a"] == pytest.approx(f["a"]) and a["b"] == pytest.approx(f["b"])


# ---- clamping ------------------------------------------------------------------------------------
def test_extreme_priors_can_still_move():
    assert update(1.0, x=0, mode="checkpoint") < 1.0
    assert update(0.0, x=1, mode="checkpoint") > 0.0


# ---- the gate --------------------------------------------------------------------------------------
def att(item, mode="practice", e=1.0, h=0.0):
    return Attempt(item, mode, e, h)


GOOD = [att("i1"), att("i2"), att("i3", "checkpoint")]


def test_gate_needs_p_at_least_theta():
    assert gate_open(0.96, GOOD, theta=0.95)
    assert not gate_open(0.94, GOOD, theta=0.95)
    assert gate_open(0.91, GOOD, theta=0.90) and not gate_open(0.91, GOOD, theta=0.95)


def test_gate_needs_an_unassisted_correct_checkpoint_answer():
    no_ckpt = [att("i1"), att("i2"), att("i3")]
    assert not gate_open(0.99, no_ckpt)
    assisted = [att("i1"), att("i2"), att("i3", "checkpoint", e=0.8, h=0.2)]
    assert not gate_open(0.99, assisted)
    failed = [att("i1"), att("i2"), att("i3", "checkpoint", e=0.0, h=0.0)]
    assert not gate_open(0.99, failed)
    partial = [att("i1"), att("i2"), att("i3", "checkpoint", e=0.79, h=0.0)]
    assert not gate_open(0.99, partial)


def test_gate_needs_three_distinct_items():
    two = [att("i1"), att("i1", "checkpoint")]
    assert not gate_open(0.99, two)
    repeated = [att("i1"), att("i2"), att("i2", "checkpoint")]
    assert not gate_open(0.99, repeated)
    assert gate_open(0.99, GOOD)


def test_clause_switches_for_the_ablation():
    assert gate_open(0.99, [], require_unassisted_checkpoint=False, require_distinct_items=False)
    assert not gate_open(0.99, [att("i1")], require_unassisted_checkpoint=False)
    assert gate_open(0.99, [att("i1"), att("i2"), att("i3")], require_unassisted_checkpoint=False)


def test_gate_can_require_more_than_one_unassisted_checkpoint_answer():
    one = [att("i1"), att("i2"), att("i3", "checkpoint")]
    two = one + [att("i4", "checkpoint")]
    assert gate_open(0.99, one) and not gate_open(0.99, one, min_unassisted_checkpoints=2)
    assert gate_open(0.99, two, min_unassisted_checkpoints=2)


def test_logit_sigmoid_roundtrip():
    for p in (0.01, 0.3, 0.5, 0.97):
        assert sigmoid(logit(p)) == pytest.approx(p) and not math.isnan(logit(p))


# ---- golden vectors for the TypeScript port --------------------------------------------------------
def test_committed_golden_vectors_match_the_implementation():
    import json

    from mastery_sim import golden

    assert json.loads(golden.PATH.read_text()) == json.loads(json.dumps(golden.build(), sort_keys=True))
