"""Policy + orchestration. The HTTP layer authenticates; this layer validates the job spec against
a closed schema (so a caller cannot choose mounts, network, image or limits: DP-3), runs the
fixed profile, grades *outside* the sandbox and logs every spec."""
import hashlib
import json
import pathlib
import re
import threading
import time

from . import engine, profiles
import os

from .exercises import probe, sum_two

HERE = pathlib.Path(__file__).resolve().parent
RUNS_DIR = HERE.parent / "runs"
EXERCISES = {sum_two.ID: sum_two}
if os.environ.get("ALI40_ENABLE_PROBE_EXERCISE") == "1":   # operator/test-only
    EXERCISES[probe.ID] = probe
ALLOWED_FIELDS = {"profile", "exercise_id", "mode", "student_id", "submission"}
MAX_SUBMISSION = 64 * 1024
STUDENT_RE = re.compile(r"^[a-z0-9_-]{1,32}$")


class Rejected(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status, self.reason = status, reason


class JobLog:
    """Append-only JSONL: every job spec and every rejected spec (DP-3: log all, alert on rejects)."""

    def __init__(self):
        RUNS_DIR.mkdir(exist_ok=True)
        self.path = RUNS_DIR / "jobs.jsonl"
        self.lock = threading.Lock()
        self.counters = {"jobs": 0, "rejected": 0, "unauthorized": 0}

    def write(self, rec):
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **rec}
        with self.lock:
            with open(self.path, "a") as fh:
                fh.write(json.dumps(rec, separators=(",", ":")) + "\n")

    def rejected(self, status, reason, detail=None):
        self.counters["rejected" if status != 401 else "unauthorized"] += 1
        self.write({"event": "REJECTED", "status": status, "reason": reason, **(detail or {})})
        # In production this would raise an alert (DP-3); the spike counts and logs.


LOG = JobLog()


def validate(req):
    if not isinstance(req, dict):
        raise Rejected(400, "body_not_object")
    extra = sorted(set(req) - ALLOWED_FIELDS)
    if extra:  # mounts / network / image / limits / privileged ... are all just "unknown field"
        raise Rejected(400, "unknown_fields:" + ",".join(extra))
    missing = sorted(ALLOWED_FIELDS - set(req))
    if missing:
        raise Rejected(400, "missing_fields:" + ",".join(missing))
    if not all(isinstance(req[k], str) for k in ALLOWED_FIELDS):
        raise Rejected(400, "field_types")
    if req["profile"] not in profiles.KNOWN_PROFILES:
        raise Rejected(400, "unknown_profile")
    if req["profile"] not in profiles.IMPLEMENTED_PROFILES:
        raise Rejected(400, "profile_not_enabled")
    if req["exercise_id"] not in EXERCISES:
        raise Rejected(400, "unknown_exercise")
    if req["mode"] not in ("run", "submit"):
        raise Rejected(400, "bad_mode")
    if not STUDENT_RE.match(req["student_id"]):
        raise Rejected(400, "bad_student_id")
    if len(req["submission"].encode()) > MAX_SUBMISSION:
        raise Rejected(413, "submission_too_large")
    return EXERCISES[req["exercise_id"]]


def norm(text):
    return "\n".join(ln.rstrip() for ln in text.strip().splitlines())


def trunc(text, n=300):
    return text if len(text) <= n else text[:n] + f"...[+{len(text) - n} chars]"


def grade_io(cases, results):
    """Compare outside the sandbox. A missing/odd result is a failure, never a pass."""
    tests = []
    for i, case in enumerate(cases):
        r = results[i] if i < len(results) else None
        ok, msg = False, "no result"
        if r is not None:
            if r["reason"] == "timeout":
                msg = "timed out"
            elif r["reason"] == "output_flood":
                msg = "too much output"
            elif r["exit"] != 0:
                msg = "runtime error: " + trunc(r["stderr"].strip().splitlines()[-1] if r["stderr"].strip() else f"exit {r['exit']}", 160)
            elif norm(r["stdout"]) == norm(case["expected"]):
                ok, msg = True, ""
            else:
                msg = f"expected {trunc(norm(case['expected']), 80)!r}, got {trunc(norm(r['stdout']), 80)!r}"
        tests.append({"name": case["name"], "passed": ok, "message": msg})
    return tests


def execute(req, debug=False):
    """Run one validated request. Returns the response body (the caller's view)."""
    ex = validate(req)
    t0 = time.monotonic()
    prof = profiles.LEARNER_CODE
    image_id = profiles.resolve_image()  # PermissionError if not on the allowlist
    nonce = engine.new_nonce()
    cases = ex.PRACTICE
    job = {"v": 1, "nonce": nonce, "kind": "io", "submission": req["submission"],
           "cases": [{"stdin": c["stdin"]} for c in cases],
           "limits": {"case_s": prof["case_s"], "out_bytes": prof["out_bytes"]}}
    wall_s = len(cases) * prof["case_s"] + 4
    out = engine.run_container(job, image_id, wall_s, prof)
    frame, problem = engine.parse_frame(out, nonce)
    resp = {"job_id": out.name, "mode": req["mode"], "exercise_id": ex.ID}
    if frame is None:
        resp.update(verdict="error", error=problem, tests=[])
    else:
        tests = grade_io(cases, frame["cases"])
        resp.update(verdict="passed" if tests and all(t["passed"] for t in tests) else "failed", tests=tests)
        if req["mode"] == "run":
            for t, r in zip(tests, frame["cases"]):
                t["stdout"], t["stderr"] = trunc(r["stdout"]), trunc(r["stderr"])
        resp["limits_hit"] = sorted({r["reason"] for r in frame["cases"] if r["reason"]})
        resp["cgroup"] = frame.get("cgroup")
    resp["timing_ms"] = {"container": out.wall_ms, "total": int((time.monotonic() - t0) * 1000)}
    LOG.counters["jobs"] += 1
    LOG.write({"event": "JOB", "job_id": out.name, "profile": req["profile"], "student_id": req["student_id"],
               "exercise_id": ex.ID, "mode": req["mode"], "image_id": image_id,
               "submission_sha256": hashlib.sha256(req["submission"].encode()).hexdigest(),
               "podman_argv": out.argv, "exit_code": out.exit_code, "problem": problem, "verdict": resp["verdict"],
               "timing_ms": resp["timing_ms"]})
    if debug:
        resp["debug"] = {"frame": frame, "stderr": out.stderr, "problem": problem}
    return resp
