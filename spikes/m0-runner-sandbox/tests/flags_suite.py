#!/usr/bin/env python3
"""ALI-62 teacher-only detection signals. Shows the two required flags fire end-to-end and as unit
checks, and that benign activity does not raise them. Writes results/flags.{md,json}.
Run: python3 -I tests/flags_suite.py"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harness as H  # noqa: E402
from harness import SPIKE  # noqa: E402

sys.path.insert(0, str(SPIKE))
from runner import service  # noqa: E402
from runner.exercises import sort_list  # noqa: E402

ROWS = []


def row(rid, claim, expected, actual, ok):
    ROWS.append({"id": rid, "claim": claim, "expected": expected, "actual": actual, "ok": bool(ok)})
    print(f"[{'PASS' if ok else 'FAIL'}] {rid}: {claim}\n        expected: {expected}\n        actual:   {actual}", flush=True)


def flags_of(resp):
    return [f["flag"] for f in (resp.get("teacher") or {}).get("flags", [])]


def main():
    (SPIKE / "runs").mkdir(exist_ok=True)
    (SPIKE / "runs" / "jobs.jsonl").unlink(missing_ok=True)

    # ---- unit: the leak detector ---------------------------------------------------------
    fire_canary = service.leak_flags(sort_list, "noise\n" + sort_list.HIDDEN_CANARY + "\nmore")
    hidden_line = next(ln for ln in sort_list.HIDDEN_SOURCE.splitlines()
                       if len(ln.strip()) >= 24 and "learner.call" in ln)
    fire_line = service.leak_flags(sort_list, "some noise\n" + hidden_line + "\nmore noise")
    benign = service.leak_flags(sort_list, "1 2 3\nsorted fine\n")
    row("F-LEAK-U1", "leak detector fires output_contains_test_source when the learner's output contains the hidden canary",
        "flag present", f"flags={[f['flag'] for f in fire_canary]}",
        any(f["flag"] == "output_contains_test_source" for f in fire_canary))
    row("F-LEAK-U2", "leak detector fires on an echoed >=24-char line of the hidden source",
        "flag present", f"flags={[f['flag'] for f in fire_line]}",
        any(f["flag"] == "output_contains_test_source" for f in fire_line))
    row("F-LEAK-U3", "benign output raises no leak flag (true negative)", "no flags",
        f"flags={[f['flag'] for f in benign]}", not benign)

    rn = H.Runner()
    try:
        # ---- end-to-end: a learner whose OUTPUT contains the canary is flagged ------------
        echo = f'print({sort_list.HIDDEN_CANARY!r})\ndef my_sort(xs):\n    return sorted(xs)\n'
        st, resp = rn.job("sort-list", echo, mode="run", student="echoer")
        row("F-LEAK-E1", "end-to-end: a run whose captured output contains the hidden canary is flagged (teacher-only)",
            "output_contains_test_source in teacher.flags", f"verdict={resp['verdict']} flags={flags_of(resp)}",
            "output_contains_test_source" in flags_of(resp))

        # ---- pass_after_zero_passing_runs -------------------------------------------------
        st, r_submit = rn.job("sort-list", sort_list.EXAMPLE_SOLUTION, mode="submit", student="sneaky")
        row("F-ZERO-1", "a passing submit with no prior passing practice run is flagged pass_after_zero_passing_runs",
            "flag present, verdict passed", f"verdict={r_submit['verdict']} flags={flags_of(r_submit)}",
            r_submit["verdict"] == "passed" and "pass_after_zero_passing_runs" in flags_of(r_submit))

        rn.job("sort-list", sort_list.EXAMPLE_SOLUTION, mode="run", student="honest")       # a passing run first
        st, r_ok = rn.job("sort-list", sort_list.EXAMPLE_SOLUTION, mode="submit", student="honest")
        row("F-ZERO-2", "a passing submit AFTER a passing run is NOT flagged (true negative)",
            "pass_after_zero_passing_runs absent", f"verdict={r_ok['verdict']} flags={flags_of(r_ok)}",
            r_ok["verdict"] == "passed" and "pass_after_zero_passing_runs" not in flags_of(r_ok))

        # ---- resource/integrity signals ---------------------------------------------------
        flood = 'import sys\nwhile True:\n    sys.stdout.write("X"*65536)\n'
        st, r_flood = rn.job("sort-list", flood, mode="submit", student="flooder")
        row("F-RES-1", "an output flood raises the resource_limit_hit / output_flood teacher signals and never passes",
            "resource_limit_hit present, verdict != passed", f"verdict={r_flood['verdict']} flags={flags_of(r_flood)}",
            r_flood["verdict"] != "passed" and "resource_limit_hit" in flags_of(r_flood))
    finally:
        rn.stop()

    out = SPIKE / "results"
    out.mkdir(exist_ok=True)
    (out / "flags.json").write_text(json.dumps(ROWS, indent=1) + "\n")
    lines = ["| ID | Claim | Expected | Actual | Result |", "|---|---|---|---|---|"]
    for r in ROWS:
        esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r['id']} | {esc(r['claim'])} | {esc(r['expected'])} | {esc(r['actual'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
    (out / "flags.md").write_text("\n".join(lines) + "\n")
    failed = [r["id"] for r in ROWS if not r["ok"]]
    print(f"\n{len(ROWS) - len(failed)}/{len(ROWS)} passed" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
