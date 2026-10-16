"""Small statistics helpers (standard library only)."""

from __future__ import annotations

import math
import statistics


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """Point estimate and Wilson score interval for a binomial proportion."""
    if n == 0:
        return float("nan"), float("nan"), float("nan")
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return p, max(0.0, centre - half), min(1.0, centre + half)


def mean_ci(xs: list[float], z: float = 1.96) -> tuple[float, float, float]:
    if not xs:
        return float("nan"), float("nan"), float("nan")
    m = statistics.fmean(xs)
    if len(xs) < 2:
        return m, m, m
    half = z * statistics.stdev(xs) / math.sqrt(len(xs))
    return m, m - half, m + half


def quantile(xs: list[float], q: float) -> float:
    s = sorted(xs)
    if not s:
        return float("nan")
    i = min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))
    return s[i]


def pct(p: float) -> str:
    return "n/a" if p != p else f"{100 * p:.1f}%"


def pct_ci(k: int, n: int) -> str:
    p, lo, hi = wilson(k, n)
    return f"{pct(p)} [{pct(lo)}, {pct(hi)}]"
