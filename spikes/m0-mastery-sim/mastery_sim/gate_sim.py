"""Gate experiment (ALI-64): opportunities-to-mastery and false-mastery rate for theta = 0.90 / 0.95 / 0.98,
with and without the MS-2 clauses, for learners with known true mastery, guessers and hint abusers."""

from __future__ import annotations

import random
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, replace
from typing import Iterable

from .bkt_lite import Attempt, BktParams, MODE_LAMBDA, evidence, gate_open, update
from .learners import FORMATS, POPULATIONS, ItemPool, Learner
from .stats import mean_ci, pct, quantile, wilson

THETAS = (0.90, 0.95, 0.98)
CAP = 60  # opportunities (practice + checkpoint items) before the simulated learner gives up
SEEDS = tuple(range(20))
PER_SEED = 200  # learners per seed per cell -> 4000 per cell

# Gate variants: the two MS-2 clauses on/off. 'full' is what the PRD specifies.
VARIANTS = {
    "bkt_only": dict(unassisted=False, distinct=False, k=1),
    "distinct_only": dict(unassisted=False, distinct=True, k=1),
    "checkpoint_only": dict(unassisted=True, distinct=False, k=1),
    "full_ms2": dict(unassisted=True, distinct=True, k=1),
    # candidate changes, not in the PRD: more than one unassisted checkpoint success in the window
    "full_k2": dict(unassisted=True, distinct=True, k=2),
    "full_k3": dict(unassisted=True, distinct=True, k=3),
}


@dataclass(frozen=True)
class Cell:
    population: str
    fmt: str
    theta: float
    variant: str
    params_key: str = "default"  # name of an estimator variant, see PARAM_VARIANTS


def _params(fmt: str, key: str) -> BktParams:
    base = BktParams(g0=FORMATS[fmt]["g0"])
    if key == "default":
        return base
    kind, _, val = key.partition("=")
    if kind == "T":
        return replace(base, T=float(val))
    if kind == "g0":
        return replace(base, g0=float(val))
    if kind == "s0":
        return replace(base, s0=float(val))
    if kind == "hint":
        return replace(base, hint_discount=val)  # type: ignore[arg-type]
    if kind == "difficulty":
        return replace(base, use_difficulty=(val == "on"))
    if kind == "first_miss":  # exercise-layer rule, handled in run_one; the estimator is unchanged
        return base
    if kind == "lam_checkpoint":
        return replace(base, lam={**MODE_LAMBDA, "checkpoint": float(val)})
    raise ValueError(key)


def run_one(cell: Cell, seed: int, idx: int) -> dict:
    pop = POPULATIONS[cell.population]
    tag = f"{seed}/{pop.name}/{cell.fmt}/{idx}"
    traits, resp = random.Random(tag + "/traits"), random.Random(tag + "/resp")
    learner = Learner(pop, cell.fmt, traits, resp)
    pool = ItemPool(traits)
    params = _params(cell.fmt, cell.params_key)
    v = VARIANTS[cell.variant]
    first_miss = cell.params_key == "first_miss=on"  # a miss before the hint counts as a failure
    p = learner.p0_est
    window: list[Attempt] = []
    ckpt_ok: set[str] = set()
    t_open, mastered_at_open, acc_at_open = None, None, None
    n_ckpt = 0
    for t in range(1, CAP + 1):
        item = pool.next()
        mode = "checkpoint" if (v["unassisted"] and p >= cell.theta and len(ckpt_ok) < v["k"]) else "practice"
        x, level, first_ok = learner.attempt(item, mode)
        if first_miss and first_ok is False:
            x = 0.0
        p = update(p, x=x, hint_level=level, b=item.b_est, mode=mode, params=params)
        h = level / params.max_hint_level
        e = evidence(x, h, params.hint_discount)
        window.append(Attempt(str(item.id), mode, e, h))
        if mode == "practice":
            learner.learn(t)
        else:
            n_ckpt += 1
            if e >= 0.8 and h == 0.0:
                ckpt_ok.add(str(item.id))
            else:  # a failed checkpoint attempt starts a new gate window
                window, ckpt_ok = [], set()
        if p >= cell.theta and gate_open(
            p, window, theta=cell.theta,
            require_unassisted_checkpoint=v["unassisted"], require_distinct_items=v["distinct"],
            min_unassisted_checkpoints=v["k"],
        ):
            t_open, mastered_at_open, acc_at_open = t, learner.mastered(), learner.expected_accuracy(pool)
            break
    return dict(t_open=t_open, mastered_at_open=mastered_at_open, acc_at_open=acc_at_open,
                t_master=learner.t_master, n_ckpt=n_ckpt)


def run_cell(args: tuple[Cell, tuple[int, ...], int]) -> tuple[Cell, dict]:
    cell, seeds, per_seed = args
    res = [run_one(cell, s, i) for s in seeds for i in range(per_seed)]
    return cell, summarise(res)


def summarise(res: list[dict]) -> dict:
    n = len(res)
    opens = [r for r in res if r["t_open"] is not None]
    false_opens = [r for r in opens if not r["mastered_at_open"]]
    t_open = [r["t_open"] for r in opens]
    excess = [r["t_open"] - r["t_master"] for r in opens if r["mastered_at_open"] and r["t_master"] is not None]
    mastered = [r for r in res if r["t_master"] is not None]
    stuck = [r for r in mastered if r["t_open"] is None]
    out = dict(
        n=n, n_open=len(opens), n_false=len(false_opens), n_mastered=len(mastered), n_stuck=len(stuck),
        otm_median=quantile(t_open, 0.5), otm_p90=quantile(t_open, 0.9),
        excess_mean=mean_ci([float(x) for x in excess])[0],
        ckpt_items_mean=mean_ci([float(r["n_ckpt"]) for r in opens])[0] if opens else float("nan"),
    )
    otm_m, otm_lo, otm_hi = mean_ci([float(x) for x in t_open])
    out.update(otm_mean=otm_m, otm_mean_lo=otm_lo, otm_mean_hi=otm_hi)
    for cap in (15, 30, 60):  # cumulative false-open by opportunity, for never-learners
        out[f"false_by_{cap}"] = sum(1 for r in false_opens if r["t_open"] <= cap)
    accs = [r["acc_at_open"] for r in opens]
    out.update(acc_mean=mean_ci(accs)[0], acc_p10=quantile(accs, 0.1),
               acc_below_80=sum(a < 0.80 for a in accs), acc_below_85=sum(a < 0.85 for a in accs))
    for key, k, m in (("open", len(opens), n), ("false_per_learner", len(false_opens), n),
                      ("false_per_open", len(false_opens), len(opens)), ("stuck", len(stuck), len(mastered))):
        p_, lo, hi = wilson(k, m)
        out.update({f"{key}_rate": p_, f"{key}_lo": lo, f"{key}_hi": hi})
    return out


def run_cells(cells: Iterable[Cell], seeds=SEEDS, per_seed=PER_SEED, workers: int | None = None) -> dict[Cell, dict]:
    tasks = [(c, tuple(seeds), per_seed) for c in cells]
    out: dict[Cell, dict] = {}
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for cell, summ in ex.map(run_cell, tasks, chunksize=1):
            out[cell] = summ
    return out


def fmt_rate(s: dict, key: str) -> str:
    return f"{pct(s[key + '_rate'])} [{pct(s[key + '_lo'])}, {pct(s[key + '_hi'])}]"


def fmt_otm(s: dict) -> str:
    if s["n_open"] == 0:
        return "n/a"
    return f"{s['otm_median']:.0f} / {s['otm_mean']:.1f} / {s['otm_p90']:.0f}"
