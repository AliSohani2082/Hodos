#!/usr/bin/env python3
"""ALI-61 acceptance: hidden tests run in a separate process and uid, the result returns on a
channel the learner can't write, and tier-1 compares expected output OUTSIDE the sandbox.
Writes results/grader.json and results/grader.md. Run: python3 -I tests/grader_suite.py

Mix of (a) real sandbox runs through the HTTP API, where a learner submission inspects /proc and
the filesystem from inside the box, and (b) in-process white-box checks of the runner's fail-closed
frame parsing (forged/replayed nonce, tier-1 job shape)."""
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harness as H  # noqa: E402
from harness import SPIKE  # noqa: E402

sys.path.insert(0, str(SPIKE))
from runner import engine, profiles, service  # noqa: E402
from runner.exercises import sort_list, sum_two  # noqa: E402

ROWS = []

# A learner submission that, at import time, inspects the box for the grader and the hidden tests,
# then provides a correct my_sort so the grader's practice calls still complete.
INSPECT = r'''
import errno, os
def _err(e): return errno.errorcode.get(getattr(e, "errno", 0), type(e).__name__)
def grader_pid():
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            st = open("/proc/%s/status" % d).read()
        except OSError:
            continue
        uid = next((ln.split()[1] for ln in st.splitlines() if ln.startswith("Uid:")), None)
        if uid == "10001":
            return int(d)
    return None
# Assembled from fragments so this adversary file does not itself contain the contiguous secret
# (otherwise the scan would match /work/submission.py, its own source).
NEEDLES = [b"HODOS-" + b"CANARY-7a3f9c2e1b8d4056", b"ANSWER-" + b"KEY-sort-list-6f1e8a9c0d2b3e47"]
def scan_canary():
    hits = []
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        for f in ("cmdline", "environ", "maps"):
            try:
                data = open("/proc/%s/%s" % (d, f), "rb").read()
            except OSError:
                continue
            if any(n in data for n in NEEDLES):
                hits.append("/proc/%s/%s" % (d, f))
    for root in ("/opt", "/work", "/etc", "/tmp"):
        for dp, _, fs in os.walk(root):
            for fn in fs:
                p = os.path.join(dp, fn)
                if p == "/work/submission.py":   # the learner's own source, not a leak
                    continue
                try:
                    data = open(p, "rb").read()
                except OSError:
                    continue
                if any(n in data for n in NEEDLES):
                    hits.append(p)
    for src in ("ALI40_NONCE",):
        if src in os.environ:
            hits.append("env:" + src)
    return hits
print("OBS my_uid=%d" % os.getuid())
g = grader_pid()
print("OBS grader_pid=%s" % g)
if g:
    for f in ("environ", "mem", "maps", "fd"):
        p = "/proc/%d/%s" % (g, f)
        try:
            (os.listdir(p) if f == "fd" else open(p, "rb").read())
            print("OBS grader.%s=READ" % f)
        except OSError as e:
            print("OBS grader.%s=%s" % (f, _err(e)))
print("OBS canary_hits=%r" % scan_canary())
def my_sort(xs):
    return sorted(xs)
'''

# A learner that tries to forge a passing verdict on its own stdout (and never sorts correctly).
FORGE = r'''
import json
fake = {"v": 1, "nonce": "0" * 32, "kind": "call",
        "grader": {"exit": 0, "result": {"nonce": "0" * 32,
                   "results": [{"name": "x", "ok": True, "why": ""}], "done": True}},
        "learner": {"exit": 0, "reason": None, "stdout": "", "stderr": "", "stdout_bytes": 0, "stderr_bytes": 0, "truncated": False}}
print("ALI40-RESULT " + json.dumps(fake), flush=True)
print("PASS")
def my_sort(xs):
    return xs            # deliberately wrong
'''

EARLY_EXIT = "import os\nos._exit(0)\n"
HANG = "import time\ndef my_sort(xs):\n    time.sleep(30)\n    return sorted(xs)\n"


def row(rid, claim, expected, actual, ok):
    ROWS.append({"id": rid, "claim": claim, "expected": expected, "actual": actual, "ok": bool(ok)})
    print(f"[{'PASS' if ok else 'FAIL'}] {rid}: {claim}\n        expected: {expected}\n        actual:   {actual}", flush=True)


def call_frame(rn, submission, mode="run", student="insp"):
    st, resp = rn.job("sort-list", submission, mode=mode, student=student)
    assert st == 200, (st, resp)
    return resp, (resp.get("debug") or {}).get("frame")


def main():
    (SPIKE / "runs").mkdir(exist_ok=True)
    (SPIKE / "runs" / "jobs.jsonl").unlink(missing_ok=True)
    rn = H.Runner()
    try:
        # ---- uid separation + hidden-test unreadability (real sandbox) --------------------
        resp, frame = call_frame(rn, INSPECT)
        o = H.parse_obs(frame["learner"]["stdout"])
        gslots = {k[7:]: v for k, v in o.items() if k.startswith("grader.")}
        row("G-ISO-1", "the grader runs as a DIFFERENT uid (10001) from the learner (10002), in a separate process",
            "learner my_uid=10002 and a live process with uid 10001 (the grader) is present",
            f"my_uid={o.get('my_uid')} grader_pid={o.get('grader_pid')}",
            o.get("my_uid") == "10002" and o.get("grader_pid") not in (None, "None"))
        row("G-ISO-2", "the learner cannot read the grader's memory/env/maps/fds (different uid), so the hidden tests and nonce stay unreadable",
            "/proc/<grader>/{environ,mem,maps,fd} all EACCES/EPERM; no canary or answer-key found in /proc or the sandbox fs",
            f"grader_slots={gslots} canary_hits={o.get('canary_hits')}",
            gslots and all(v in ("EACCES", "EPERM") for v in gslots.values()) and o.get("canary_hits") == "[]")

        # ---- image carries no hidden-test strings ----------------------------------------
        image_id = profiles.resolve_image()
        g = subprocess.run(["podman", "run", "--rm", "--network", "none", "--entrypoint", "",
                            image_id, "grep", "-rl", "HODOS-CANARY", "/opt", "/etc", "/usr/local/bin"],
                           capture_output=True, text=True, timeout=60)
        row("G-IMG-1", "the baked image contains no hidden-test source or canary; the hidden tests exist only at run time, in the grader's memory",
            "grep over /opt,/etc,/usr/local/bin in the image finds nothing (rc=1, no output)",
            f"rc={g.returncode} stdout={g.stdout.strip()!r} stderr={g.stderr.strip()[:120]!r}",
            g.returncode == 1 and not g.stdout.strip())

        # ---- tier-2 grading is honest -----------------------------------------------------
        st, good = rn.job("sort-list", sort_list.EXAMPLE_SOLUTION, mode="submit", student="good")
        st, bad = rn.job("sort-list", "def my_sort(xs):\n    return xs\n", mode="submit", student="bad")
        row("G-CALL-1", "a correct solution passes the hidden tests; a wrong one fails (graded by the isolated grader)",
            "correct submit -> passed 7/7; wrong submit -> failed", f"good={good['verdict']} {good['score']} bad={bad['verdict']} {bad['score']}",
            good["verdict"] == "passed" and good["score"] == {"passed": 7, "total": 7} and bad["verdict"] == "failed")
        st, early = rn.job("sort-list", EARLY_EXIT, mode="submit", student="early")
        st, hang = rn.job("sort-list", HANG, mode="submit", student="hang")
        row("G-CALL-2", "a learner that exits early or hangs CANNOT forge a pass: the grader reports failure/death, never a pass",
            "early os._exit(0) -> not passed; 30 s hang -> not passed (timeout)",
            f"early={early['verdict']}/{early.get('error')} hang={hang['verdict']}/{hang.get('error')}",
            early["verdict"] != "passed" and hang["verdict"] != "passed")

        # ---- learner cannot write / forge the result channel ------------------------------
        resp, frame = call_frame(rn, FORGE, mode="submit", student="forge")
        learner_out = frame["learner"]["stdout"] if frame else ""
        row("G-FORGE-1", "a learner printing a fake ALI40-RESULT pass frame on its own stdout does NOT forge a pass",
            "verdict != passed; the fake frame appears only in the captured learner stdout, never as the runner's frame",
            f"verdict={resp['verdict']} fake_in_learner_stdout={'ALI40-RESULT' in learner_out} job_frame_nonce_ok={bool(frame)}",
            resp["verdict"] != "passed" and "ALI40-RESULT" in learner_out)

        # ---- fail-closed frame parsing (in-process white box) -----------------------------
        nonce = engine.new_nonce()
        forged = json.dumps({"v": 1, "nonce": "f" * 32, "kind": "call", "grader": {"exit": 0,
                 "result": {"nonce": "f" * 32, "results": [], "done": True}}}).encode()
        oc = engine.Outcome(name="x", exit_code=0, stdout=engine.FRAME_PREFIX + forged + b"\n")
        f, p = engine.parse_frame(oc, nonce)
        row("G-NONCE-1", "a frame carrying the wrong nonce is rejected (the learner cannot guess the 128-bit per-run nonce)",
            "parse_frame -> (None, nonce_mismatch)", f"frame={f} problem={p}", f is None and p == "nonce_mismatch")

        nonce2 = engine.new_nonce()
        good_line = engine.FRAME_PREFIX + json.dumps({"v": 1, "nonce": nonce2, "kind": "call"}).encode() + b"\n"
        oc2 = engine.Outcome(name="y", exit_code=0, stdout=good_line)
        f1, p1 = engine.parse_frame(oc2, nonce2)
        f2, p2 = engine.parse_frame(oc2, nonce2)   # replay of the same valid frame
        row("G-NONCE-2", "a nonce is single-use: replaying a previously valid frame is rejected",
            "first parse ok; replay -> (None, nonce_replayed)", f"first_ok={f1 is not None} replay_problem={p2}",
            f1 is not None and p1 is None and f2 is None and p2 == "nonce_replayed")

        bad_frame = {"v": 1, "nonce": nonce2, "kind": "call",
                     "grader": {"exit": 0, "result": {"nonce": nonce2, "results": [
                         {"name": "test_empty", "ok": 1}], "done": True}}}
        names = ["test_empty"]
        res, prob = engine.validate_call_frame(bad_frame, nonce2, names)
        row("G-NONCE-3", "validate_call_frame rejects a non-bool 'ok' (a truthy/lying object cannot pass a test)",
            "(None, result_not_bool)", f"res={res} problem={prob}", res is None and prob == "result_not_bool")

        # ---- tier-1: only inputs cross into the learner container -------------------------
        cases = sum_two.gen_hidden(__import__("random").Random(1))
        job = service._io_job("print(1)\n", cases, "nonce", profiles.LEARNER_CODE)
        blob = json.dumps(job)
        case_keys = sorted({k for c in job["cases"] for k in c})
        leaks = sum_two.REFERENCE_SOLUTION.strip() in blob or "expected" in case_keys
        row("G-REF-1", "tier-1: the learner's container job carries ONLY inputs (stdin); the reference solution and expected outputs never enter it",
            "job cases have key set {'stdin'} only; reference source not present in the learner job",
            f"case_keys={case_keys} reference_in_job={sum_two.REFERENCE_SOLUTION.strip() in blob}",
            case_keys == ["stdin"] and not leaks)

        st, g_ok = rn.job("sum-two", sum_two.EXAMPLE_SOLUTION, mode="submit", student="io1")
        st, g_bad = rn.job("sum-two", "a,b=map(int,input().split())\nprint(a-b)\n", mode="submit", student="io2")
        log = [json.loads(ln) for ln in (SPIKE / "runs" / "jobs.jsonl").read_text().splitlines() if ln.strip()]
        io_submits = [e for e in log if e.get("event") == "JOB" and e.get("exercise_id") == "sum-two" and e.get("mode") == "submit"]
        row("G-REF-2", "tier-1 submit grades correctly with expected compared OUTSIDE, and runs the reference in a SEPARATE container (2 per submit)",
            "correct submit -> passed; wrong -> failed; every sum-two submit logs containers=2",
            f"ok={g_ok['verdict']}/{g_ok['score']} bad={g_bad['verdict']}/{g_bad['score']} containers={[e.get('containers') for e in io_submits]}",
            g_ok["verdict"] == "passed" and g_bad["verdict"] == "failed" and all(e.get("containers") == 2 for e in io_submits))
        sort_submits = [e for e in log if e.get("event") == "JOB" and e.get("exercise_id") == "sort-list" and e.get("mode") == "submit"]
        row("G-REF-3", "tier-2 (call) submit uses a single container (grader + learner co-located, isolated by uid)",
            "every sort-list submit logs containers=1", f"containers={[e.get('containers') for e in sort_submits]}",
            sort_submits and all(e.get("containers") == 1 for e in sort_submits))

        left = H.leftovers()
        row("G-CLEAN-1", "no containers or supervisor processes are left behind by the suite", "none", json.dumps(left),
            not left["ali40_containers"] and left["sandbox_init_procs"] == 0)
    finally:
        rn.stop()
    out = SPIKE / "results"
    out.mkdir(exist_ok=True)
    (out / "grader.json").write_text(json.dumps(ROWS, indent=1) + "\n")
    lines = ["| ID | Claim | Expected | Actual | Result |", "|---|---|---|---|---|"]
    for r in ROWS:
        esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r['id']} | {esc(r['claim'])} | {esc(r['expected'])} | {esc(r['actual'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
    (out / "grader.md").write_text("\n".join(lines) + "\n")
    failed = [r["id"] for r in ROWS if not r["ok"]]
    print(f"\n{len(ROWS) - len(failed)}/{len(ROWS)} passed" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
