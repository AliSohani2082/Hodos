#!/usr/bin/env python3
"""ALI-62 measurements for the ADR: latency of secure tier-2 (call) and tier-1 (submit) jobs, and a
small concurrency check. Writes results/perf.json. Run: python3 -I tests/measure.py [runs]"""
import json
import pathlib
import statistics
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harness as H  # noqa: E402
from harness import SPIKE  # noqa: E402

sys.path.insert(0, str(SPIKE))
from runner.exercises import sort_list, sum_two  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 20


def stats(xs):
    xs = sorted(xs)
    return {"n": len(xs), "p50": round(statistics.median(xs)), "p95": xs[min(len(xs) - 1, int(len(xs) * 0.95))],
            "min": xs[0], "max": xs[-1], "mean": round(statistics.mean(xs))}


def main():
    (SPIKE / "runs").mkdir(exist_ok=True)
    (SPIKE / "runs" / "jobs.jsonl").unlink(missing_ok=True)
    rn = H.Runner(debug=False)
    perf = {}
    try:
        call_lat, io_lat = [], []
        for i in range(N):
            _, r = rn.job("sort-list", sort_list.EXAMPLE_SOLUTION, mode="run", student=f"c{i}")
            call_lat.append(r["timing_ms"]["total"])
        for i in range(N):
            _, r = rn.job("sum-two", sum_two.EXAMPLE_SOLUTION, mode="submit", student=f"i{i}")
            io_lat.append(r["timing_ms"]["total"])
        perf["call_run_ms"] = stats(call_lat)
        perf["io_submit_ms"] = stats(io_lat)   # 2 containers each (learner + reference)

        # concurrency: 3 students at once (global cap is 3)
        results, t0 = {}, time.monotonic()
        def worker(k):
            results[k] = rn.job("sort-list", sort_list.EXAMPLE_SOLUTION, mode="submit", student=f"p{k}")[1]["verdict"]
        ths = [threading.Thread(target=worker, args=(k,)) for k in range(3)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        perf["concurrency"] = {"parallel": 3, "wall_ms": int((time.monotonic() - t0) * 1000),
                               "verdicts": results}
    finally:
        rn.stop()
    perf["note"] = ("rootless podman 6.1.2 + crun; measured end-to-end through the HTTP API incl. "
                    "container create/start/run/teardown; io_submit runs the reference in a 2nd container.")
    (SPIKE / "results").mkdir(exist_ok=True)
    (SPIKE / "results" / "perf.json").write_text(json.dumps(perf, indent=1) + "\n")
    print(json.dumps(perf, indent=1))


if __name__ == "__main__":
    main()
