"""Runs the ALI-64 experiment grids, writes the CSVs and renders the markdown tables."""

from __future__ import annotations

import csv
from pathlib import Path

from .bkt_lite import BktParams, update
from .gate_sim import CAP, PER_SEED, SEEDS, THETAS, Cell, fmt_otm, fmt_rate, run_cells
from .learners import FORMATS, POPULATIONS
from .stats import pct

MAIN_VARIANTS = ("bkt_only", "distinct_only", "checkpoint_only", "full_ms2", "full_k2", "full_k3")
SENS_POPS = ("typical", "guesser_testwise", "hint_abuser_retry", "typical_continuous")
SENS_KEYS = (
    "default", "T=0.05", "T=0.10", "T=0.25", "g0=0.15", "g0=0.35", "g0=0.45", "s0=0.05", "s0=0.20",
    "hint=none", "hint=any_hint", "difficulty=off", "lam_checkpoint=0.5", "lam_checkpoint=1.0", "first_miss=on",
)
CSV_FIELDS = [
    "format", "population", "variant", "estimator", "theta", "n", "open_rate", "open_lo", "open_hi",
    "false_per_learner_rate", "false_per_learner_lo", "false_per_learner_hi",
    "false_per_open_rate", "false_per_open_lo", "false_per_open_hi",
    "stuck_rate", "stuck_lo", "stuck_hi", "otm_median", "otm_mean", "otm_mean_lo", "otm_mean_hi", "otm_p90",
    "excess_mean", "ckpt_items_mean", "false_by_15", "false_by_30", "false_by_60",
    "acc_mean", "acc_p10", "acc_below_80", "acc_below_85",
]


def main_cells() -> list[Cell]:
    return [Cell(p, f, th, v) for f in FORMATS for p in POPULATIONS for th in THETAS for v in MAIN_VARIANTS]


def sens_cells() -> list[Cell]:
    return [Cell(p, "mcq4", 0.95, v, k) for p in SENS_POPS for v in ("bkt_only", "full_ms2") for k in SENS_KEYS]


def _row(c: Cell, s: dict) -> dict:
    row = {"format": c.fmt, "population": c.population, "variant": c.variant, "estimator": c.params_key,
           "theta": c.theta}
    for f in CSV_FIELDS:
        if f in s:
            row[f] = s[f]
    return row


def write_csv(path: Path, res: dict[Cell, dict]) -> None:
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_FIELDS, lineterminator="\n")
        w.writeheader()
        for c, s in res.items():
            r = _row(c, s)
            w.writerow({k: (f"{v:.4f}" if isinstance(v, float) else v) for k, v in r.items()})


def hint_level_table() -> list[dict]:
    """Analytic: a learner who is always right but at hint level L on every practice item, from p0 = 0.10."""
    rows = []
    for g0 in (0.15, 0.25):
        params = BktParams(g0=g0)
        for level in range(6):
            p, traj = params.p0, []
            for _ in range(60):
                p = update(p, x=1, hint_level=level, params=params)
                traj.append(p)
            reach = {th: next((i + 1 for i, v in enumerate(traj) if v >= th), None) for th in THETAS}
            rows.append(dict(g0=g0, hint_level=level, e=round(1 - level / 5, 2), p_after_3=traj[2],
                             p_after_10=traj[9], p_steady=traj[-1],
                             items_to_090=reach[0.90], items_to_095=reach[0.95], items_to_098=reach[0.98]))
    return rows


def write_hint_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: (f"{v:.4f}" if isinstance(v, float) else ("never" if v is None else v)) for k, v in r.items()})


# -- markdown ---------------------------------------------------------------------------------------
def _g(res, pop, fmt, th, var, key="default"):
    return res[Cell(pop, fmt, th, var, key)]


def _md(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(out) + "\n"


def render_gate(main: dict, cand: dict, sens: dict, hints: list[dict], n_seeds: int, per_seed: int) -> str:
    n = next(iter(main.values()))["n"]
    out: list[str] = []
    out.append(f"All rows: {n_seeds} seeds x {per_seed} learners = {n} learners per cell; cap of {CAP} opportunities "
               "(practice + checkpoint items) per learner. Intervals are 95% (Wilson for rates, normal for means).\n")

    for fmt in FORMATS:
        out.append(f"### G1. Typical learners: theta x gate clauses, format `{fmt}` (estimator g0 = {FORMATS[fmt]['g0']})\n")
        out.append("False-mastery rate = share of gate openings where the learner did not truly know the skill at that moment. "
                   "OTM = opportunities to gate opening (median / mean / p90). Excess = opportunities after true mastery.\n")
        rows = []
        for var in ("bkt_only", "distinct_only", "checkpoint_only", "full_ms2"):
            for th in THETAS:
                s = _g(main, "typical", fmt, th, var)
                rows.append([f"`{var}`" + (" (PRD)" if var == "full_ms2" else ""), f"{th:.2f}", fmt_otm(s),
                             f"{s['excess_mean']:.1f}", fmt_rate(s, "false_per_open"), fmt_rate(s, "stuck")])
        out.append(_md(["gate", "theta", "OTM med / mean / p90", "excess", "false-mastery rate", "never opened (but mastered)"], rows))

    out.append("### G2. Knowers and diagnostic priors (full MS-2 gate, format `mcq4`)\n")
    rows = []
    for pop in ("knower", "diag_calibrated", "diag_miscalibrated"):
        for var in ("bkt_only", "full_ms2"):
            for th in THETAS:
                s = _g(main, pop, "mcq4", th, var)
                rows.append([pop, f"`{var}`", f"{th:.2f}", fmt_otm(s), fmt_rate(s, "false_per_open")])
    out.append(_md(["population", "gate", "theta", "OTM med / mean / p90", "false-mastery rate"], rows))

    for fmt in FORMATS:
        out.append(f"### G3. Guessers and hint abusers: share who reach the gate, format `{fmt}`\n")
        out.append("Every learner here never learns, so every opening is false. Columns after the first give the share opened "
                   "within 15 / 30 / 60 opportunities (the cap).\n")
        rows = []
        for pop in ("guesser_chance", "guesser_testwise", "hint_abuser_first", "hint_abuser_retry"):
            for var in ("bkt_only", "full_ms2"):
                for th in THETAS:
                    s = _g(main, pop, fmt, th, var)
                    nn = s["n"]
                    rows.append([pop, f"`{var}`", f"{th:.2f}", pct(s["false_by_15"] / nn), pct(s["false_by_30"] / nn),
                                 fmt_rate(s, "false_per_learner")])
        out.append(_md(["population", "gate", "theta", "<= 15 opp.", "<= 30 opp.", "<= 60 opp. [95% CI]"], rows))

    out.append("### G4. Candidate changes to the gate at theta = 0.95\n")
    out.append("`full_k2` / `full_k3` need 2 / 3 unassisted checkpoint successes (distinct items) in the window instead of 1. "
               "`first_miss` counts a wrong first attempt as a failure even if the learner then succeeds after a hint. "
               "Typical rows show false-mastery rate per opening and median OTM; adversary rows show the share that reach the gate within the cap.\n")
    rows = []
    for fmt in FORMATS:
        for rule, src, key in (("PRD evidence", main, "default"), ("first_miss", cand, "first_miss=on")):
            for var in (("bkt_only",) if rule == "PRD evidence" else ()) + ("full_ms2", "full_k2", "full_k3"):
                get = lambda pop, _s=src, _f=fmt, _v=var, _k=key: _g(_s, pop, _f, 0.95, _v, _k)  # noqa: E731
                t = get("typical")
                rows.append([fmt, "**PRD**" if (rule == "PRD evidence" and var == "full_ms2") else "", f"`{var}`", rule,
                             fmt_rate(t, "false_per_open"), f"{t['otm_median']:.0f}",
                             pct(get("guesser_chance")["false_per_learner_rate"]), pct(get("guesser_testwise")["false_per_learner_rate"]),
                             pct(get("hint_abuser_first")["false_per_learner_rate"]), pct(get("hint_abuser_retry")["false_per_learner_rate"])])
    out.append(_md(["format", "", "gate", "evidence rule", "typical: false-mastery", "typical OTM", "chance guesser", "test-wise guesser",
                    "hint-first abuser", "hint-retry abuser"], rows))

    out.append("### G5. Graded-ability learners (BKT assumption broken), full MS-2 gate\n")
    out.append("No 'learned' moment exists here: ability grows continuously. 'Accuracy at opening' is the learner's true unaided "
               "accuracy over the item pool when the gate opened. Mastered would mean >= 85%; shares below 80% / 85% shown.\n")
    rows = []
    for fmt in FORMATS:
        for var in ("bkt_only", "full_ms2", "full_k3"):
            for th in THETAS:
                s = _g(main, "typical_continuous", fmt, th, var)
                rows.append([fmt, f"`{var}`", f"{th:.2f}", fmt_otm(s), f"{s['acc_mean']:.2f}", f"{s['acc_p10']:.2f}",
                             pct(s["acc_below_80"] / s["n_open"]), pct(s["acc_below_85"] / s["n_open"])])
    out.append(_md(["format", "gate", "theta", "OTM med / mean / p90", "accuracy at opening (mean)", "(p10)", "< 80%", "< 85%"], rows))

    out.append("### G6. Sensitivity of the defaults (format `mcq4`, theta = 0.95)\n")
    out.append("One estimator parameter changed per row; learners are unchanged. Typical: false-mastery per opening and median OTM. "
               "Adversaries: share reaching the gate within the cap. `lam_checkpoint` is lambda for checkpoint mode (PRD: 0).\n")
    rows = []
    for key in SENS_KEYS:
        for var in ("bkt_only", "full_ms2"):
            t = _g(sens, "typical", "mcq4", 0.95, var, key)
            gw = _g(sens, "guesser_testwise", "mcq4", 0.95, var, key)
            hr = _g(sens, "hint_abuser_retry", "mcq4", 0.95, var, key)
            c = _g(sens, "typical_continuous", "mcq4", 0.95, var, key)
            rows.append([f"`{key}`", f"`{var}`", pct(t["false_per_open_rate"]), f"{t['otm_median']:.0f}", pct(gw["false_per_learner_rate"]),
                         pct(hr["false_per_learner_rate"]), f"{c['acc_mean']:.2f}"])
    out.append(_md(["estimator change", "gate", "typical: false-mastery", "typical OTM", "test-wise guesser", "hint-retry abuser",
                    "graded learner: accuracy at opening"], rows))

    out.append("### G7. Hint discount arithmetic: always correct, always at hint level L, from p0 = 0.10 (practice mode)\n")
    out.append("`e = 1 - L/5`. P after 3 and 10 items, the steady state after 60, and items needed to reach each theta.\n")
    rows = [[f"{r['g0']:.2f}", str(r["hint_level"]), f"{r['e']:.1f}", f"{r['p_after_3']:.3f}", f"{r['p_after_10']:.3f}", f"{r['p_steady']:.3f}",
             str(r["items_to_090"] or "never"), str(r["items_to_095"] or "never"), str(r["items_to_098"] or "never")] for r in hints]
    out.append(_md(["g0", "hint level", "e", "P after 3", "P after 10", "steady state", "to 0.90", "to 0.95", "to 0.98"], rows))
    return "\n".join(out)


def run_gate(out_dir: Path, quick: bool = False) -> str:
    seeds, per_seed = (SEEDS[:3], 60) if quick else (SEEDS, PER_SEED)
    main = run_cells(main_cells(), seeds=seeds, per_seed=per_seed)
    # candidate rule (first_miss) at theta 0.95 for every population and both formats
    cand_cells = [Cell(p, f, 0.95, v, "first_miss=on") for f in FORMATS for p in POPULATIONS
                  for v in ("full_ms2", "full_k2", "full_k3")]
    cand = run_cells(cand_cells, seeds=seeds, per_seed=per_seed)
    sens = run_cells(sens_cells(), seeds=seeds, per_seed=per_seed)
    hints = hint_level_table()
    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "gate_main.csv", {**main, **cand})
    write_csv(out_dir / "gate_sensitivity.csv", sens)
    write_hint_csv(out_dir / "hint_levels.csv", hints)
    return render_gate(main, cand, sens, hints, len(seeds), per_seed)
