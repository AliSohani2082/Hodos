"""Golden vectors for porting BKT-lite to TypeScript (ALI-161): `python run.py --golden` rewrites them."""

from __future__ import annotations

import json
from pathlib import Path

from .bkt_lite import P_EPS, BktParams, update, update_multi

PATH = Path(__file__).resolve().parent.parent / "fixtures" / "bkt_golden.json"

SINGLE = {
    "clean_run_from_p0_0.1": (0.10, [dict(x=1, hint_level=0, b=0.0, mode="practice")] * 4),
    "two_correct_from_p0_0.3": (0.30, [dict(x=1, hint_level=0, b=0.0, mode="practice")] * 2),
    "wrong_answers_settle": (0.50, [dict(x=0, hint_level=0, b=0.0, mode="practice")] * 5),
    "bottom_out_is_failure": (0.50, [dict(x=1, hint_level=5, b=0.0, mode="practice")] * 3),
    "partial_hint_and_soft_score": (
        0.20,
        [
            dict(x=1.0, hint_level=2, b=0.5, mode="practice"),
            dict(x=0.6, hint_level=0, b=-0.5, mode="practice"),
            dict(x=0.0, hint_level=0, b=1.0, mode="review"),
            dict(x=1.0, hint_level=0, b=1.0, mode="checkpoint"),
        ],
    ),
    "review_after_lapse": (
        0.97,
        [dict(x=0, hint_level=0, b=0.0, mode="review"), dict(x=1, hint_level=0, b=0.0, mode="review")],
    ),
}

MULTI = {
    "two_skill_failure_blames_weak": (
        {"a": 0.95, "b": 0.30},
        [("a", 1.0), ("b", 1.0)],
        [dict(x=0, hint_level=0, b=0.0, mode="checkpoint"), dict(x=1, hint_level=0, b=0.0, mode="practice")],
    ),
    "weighted_success": (
        {"a": 0.40, "b": 0.50, "c": 0.70},
        [("a", 1.0), ("b", 0.5)],
        [dict(x=1, hint_level=1, b=0.3, mode="practice")],
    ),
}


def build() -> dict:
    p = BktParams()
    out: dict = {
        "params": {"p0": p.p0, "T": p.T, "s0": p.s0, "g0": p.g0, "max_hint_level": p.max_hint_level,
                   "lambda": dict(p.lam), "p_eps": P_EPS},
        "single": [],
        "multi": [],
    }
    for name, (p0, steps) in SINGLE.items():
        pk, trace = p0, []
        for st in steps:
            pk = update(pk, params=p, **st)
            trace.append(pk)
        out["single"].append({"name": name, "p0": p0, "steps": steps, "expected": trace})
    for name, (p0, skills, steps) in MULTI.items():
        cur, trace = dict(p0), []
        for st in steps:
            cur = update_multi(cur, skills, params=p, **st)
            trace.append(dict(cur))
        out["multi"].append({"name": name, "p0": p0, "skills": skills, "steps": steps, "expected": trace})
    return out


def write() -> None:
    PATH.parent.mkdir(exist_ok=True)
    PATH.write_text(json.dumps(build(), indent=1, sort_keys=True) + "\n")
