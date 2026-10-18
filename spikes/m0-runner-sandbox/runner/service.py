"""Policy + orchestration. The HTTP layer authenticates; this layer validates the job spec against
a closed schema (so a caller cannot choose mounts, network, image, limits, kind or variant: DP-3),
runs the fixed profile, grades *outside* the sandbox and logs every spec.

Two grading tiers:
  * tier 1 ("io"): only *inputs* enter the sandbox; the expected output is produced by running the
    reference solution in a SEPARATE sandbox container and compared here, outside. Neither the
    reference nor the expected values ever enter the learner's container.
  * tier 2 ("call"): a grader process (uid 10001) drives the learner process (uid 10002) over a
    JSON-only RPC inside the same container; the hidden tests live only in the grader's memory and
    the verdict returns on a pipe the learner can't write. The frame is validated here.
"""
import hashlib
import json
import os
import pathlib
import random
import re
import threading
import time

from . import engine, profiles
from .exercises import probe, sort_list, sum_two

HERE = pathlib.Path(__file__).resolve().parent
RUNS_DIR = HERE.parent / "runs"
EXERCISES = {sum_two.ID: sum_two, sort_list.ID: sort_list}
if os.environ.get("ALI40_ENABLE_PROBE_EXERCISE") == "1":   # operator/test-only
    EXERCISES[probe.ID] = probe
ALLOWED_FIELDS = {"profile", "exercise_id", "mode", "student_id", "submission"}
MAX_SUBMISSION = 64 * 1024
STUDENT_RE = re.compile(r"^[a-z0-9_-]{1,32}$")

# How a grader `why` code is phrased to the learner on `run` (never leaks an expected value).
WHY_STUDENT = {"": "passed", "assertion": "wrong answer", "timeout": "timed out",
               "died": "your program exited early", "raised": "your function raised an exception",
               "protocol": "your program sent an invalid response"}


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

    def run_history(self, student_id, exercise_id):
        """Prior JOB records for (student, exercise), oldest first (for pass_after_zero flag)."""
        recs = []
        try:
            with open(self.path) as fh:
                for line in fh:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("event") == "JOB" and r.get("student_id") == student_id and r.get("exercise_id") == exercise_id:
                        recs.append(r)
        except OSError:
            pass
        return recs


LOG = JobLog()


def _variant():
    """Operator-only insecure control, from server env; NEVER request-selectable. Default secure."""
    v = os.environ.get("ALI40_INSECURE_VARIANT")
    return v if v in ("colocated", "same-uid") else "secure"


def validate(req):
    if not isinstance(req, dict):
        raise Rejected(400, "body_not_object")
    extra = sorted(set(req) - ALLOWED_FIELDS)
    if extra:  # mounts / network / image / limits / kind / variant ... are all just "unknown field"
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


# ---------------------------------------------------------------------------- flags (teacher-only)

def _normalise_lines(text):
    return {ln.strip() for ln in text.splitlines() if len(ln.strip()) >= 24}


def leak_flags(ex, learner_text):
    """Does the learner's own output contain the hidden test source / canary? (output_contains_test_source)
    Scans for the exercise's canary and for any normalised >=24-char line of the hidden source."""
    flags = []
    canary = getattr(ex, "HIDDEN_CANARY", None)
    answer = getattr(ex, "ANSWER_KEY", None)
    if canary and canary in learner_text:
        flags.append({"flag": "output_contains_test_source", "detail": "hidden canary in learner output"})
        return flags
    if answer and answer in learner_text:
        flags.append({"flag": "output_contains_test_source", "detail": "answer key in learner output"})
        return flags
    hidden = getattr(ex, "HIDDEN_SOURCE", None)
    if hidden:
        hidden_lines = _normalise_lines(hidden)
        out_lines = _normalise_lines(learner_text)
        if hidden_lines & out_lines:
            flags.append({"flag": "output_contains_test_source", "detail": "hidden-source line echoed"})
    return flags


# ---------------------------------------------------------------------------- tier 1 ("io")

def _io_job(submission, cases, nonce, prof):
    return {"v": 1, "nonce": nonce, "kind": "io", "submission": submission,
            "cases": [{"stdin": c["stdin"]} for c in cases],
            "limits": {"case_s": prof["case_s"], "out_bytes": prof["out_bytes"]}}


def _run_io(submission, cases, prof, image_id):
    """Run `submission` against the stdin of each case in ONE container. Returns (outcome, frame, problem)."""
    nonce = engine.new_nonce()
    job = _io_job(submission, cases, nonce, prof)
    wall_s = len(cases) * prof["case_s"] + 4
    out = engine.run_container(job, image_id, wall_s, prof)
    frame, problem = engine.parse_frame(out, nonce)
    return out, frame, problem


def grade_io(cases, results):
    """Compare outside the sandbox. A missing/odd result is a failure, never a pass."""
    tests = []
    for i, case in enumerate(cases):
        r = results[i] if results and i < len(results) else None
        ok, msg = False, "no result"
        if r is not None:
            if r["reason"] == "timeout":
                msg = "timed out"
            elif r["reason"] == "output_flood":
                msg = "too much output"
            elif r["exit"] != 0:
                tail = r["stderr"].strip().splitlines()[-1] if r["stderr"].strip() else f"exit {r['exit']}"
                msg = "runtime error: " + trunc(tail, 160)
            elif norm(r["stdout"]) == norm(case["expected"]):
                ok, msg = True, ""
            else:
                msg = f"expected {trunc(norm(case['expected']), 80)!r}, got {trunc(norm(r['stdout']), 80)!r}"
        tests.append({"name": case["name"], "passed": ok, "message": msg})
    return tests


def _execute_io(req, ex, prof, image_id, t0, debug):
    mode = req["mode"]
    containers = 1
    if mode == "run":
        cases = [dict(c) for c in ex.PRACTICE]
        out, frame, problem = _run_io(req["submission"], cases, prof, image_id)
        ref_out = None
    else:
        # submit: generate hidden inputs, run the REFERENCE in a SEPARATE container to get expected.
        seed = engine.new_nonce()
        gen = ex.gen_hidden(random.Random(seed))
        cases = [dict(c) for c in gen]
        result = {}
        def run_ref():
            result["ref"] = _run_io(ex.REFERENCE_SOLUTION, cases, prof, image_id)
        th = threading.Thread(target=run_ref)
        th.start()
        out, frame, problem = _run_io(req["submission"], cases, prof, image_id)
        th.join()
        ref_out, ref_frame, ref_problem = result["ref"]
        containers = 2
        if ref_frame is None:
            problem = problem or f"reference_{ref_problem}"
            frame = None          # cannot grade without expected values: fail closed as "error"
        else:
            # The reference's stdout becomes the expected value — computed outside the learner box.
            for i, c in enumerate(cases):
                rc = ref_frame["cases"][i] if i < len(ref_frame["cases"]) else None
                c["expected"] = rc["stdout"] if rc and rc["exit"] == 0 else "\0REF-FAILED"

    learner_text, limits_hit = "", []
    if frame is None:
        verdict, tests = "error", []
    else:
        learner_text = "".join(c.get("stdout", "") + c.get("stderr", "") for c in frame["cases"])
        limits_hit = sorted({c["reason"] for c in frame["cases"] if c["reason"]})
        tests = grade_io(cases, frame["cases"])
        verdict = "passed" if tests and all(t["passed"] for t in tests) else "failed"

    resp = {"job_id": out.name, "mode": mode, "exercise_id": ex.ID, "verdict": verdict}
    if mode == "run" and frame is not None:
        for t, r in zip(tests, frame["cases"]):
            t["stdout"], t["stderr"] = trunc(r["stdout"]), trunc(r["stderr"])
        resp["tests"] = tests
    elif mode == "run":
        resp["tests"] = []
    else:  # submit: score only, no per-case detail, no learner output
        resp["score"] = {"passed": sum(1 for t in tests if t["passed"]), "total": len(tests)}
    resp["error"] = problem
    _finish(resp, req, ex, out, image_id, problem, t0, frame, learner_text, limits_hit, containers, debug, tests)
    return resp


# ---------------------------------------------------------------------------- tier 2 ("call")

def _execute_call(req, ex, prof, image_id, t0, debug):
    mode = req["mode"]
    source = ex.PRACTICE_SOURCE if mode == "run" else ex.HIDDEN_SOURCE
    expected_names = ex.test_names(source)
    nonce = engine.new_nonce()
    seed = int.from_bytes(os.urandom(4), "big")
    variant = _variant()
    job = {"v": 1, "nonce": nonce, "kind": "call", "variant": variant, "submission": req["submission"],
           "limits": {"case_s": prof["case_s"], "out_bytes": prof["out_bytes"],
                      "wall_s": len(expected_names) * prof["case_s"] + 4},
           "grader": {"tests_source": source, "seed": seed}}
    wall_s = job["limits"]["wall_s"]
    out = engine.run_container(job, image_id, wall_s, prof)
    frame, problem = engine.parse_frame(out, nonce)

    learner_text, limits_hit, results = "", [], None
    if frame is not None:
        learner = frame.get("learner", {})
        learner_text = learner.get("stdout", "") + learner.get("stderr", "")
        if learner.get("reason"):
            limits_hit = [learner["reason"]]
        results, problem = engine.validate_call_frame(frame, nonce, expected_names)

    if results is None:
        verdict, tests = "error", []
    else:
        verdict = "passed" if all(r["ok"] for r in results) else "failed"
        tests = [{"name": r["name"], "passed": r["ok"], "message": WHY_STUDENT.get(r["why"], "failed")} for r in results]

    resp = {"job_id": out.name, "mode": mode, "exercise_id": ex.ID, "verdict": verdict, "variant": variant}
    if mode == "run":
        resp["tests"] = tests
        if frame is not None:
            resp["learner_stdout"] = trunc(frame.get("learner", {}).get("stdout", ""))
            resp["learner_stderr"] = trunc(frame.get("learner", {}).get("stderr", ""))
    else:  # submit: score only
        resp["score"] = {"passed": sum(1 for r in (results or []) if r["ok"]), "total": len(expected_names)}
    resp["error"] = problem
    _finish(resp, req, ex, out, image_id, problem, t0, frame, learner_text, limits_hit, 1, debug, tests)
    return resp


# ---------------------------------------------------------------------------- shared tail

def _finish(resp, req, ex, out, image_id, problem, t0, frame, learner_text, limits_hit, containers, debug, tests):
    # teacher-only integrity + leak signals (never shown to the learner).
    flags = list(leak_flags(ex, learner_text))
    if problem and (problem.startswith("nonce") or problem.startswith("grader") or
                    problem in ("frame_count", "frame_json", "frame_shape", "result_count",
                                "result_names", "result_not_bool", "no_grader")):
        flags.append({"flag": "forged_or_missing_result", "detail": problem})
    if limits_hit:
        flags.append({"flag": "resource_limit_hit", "detail": ",".join(limits_hit)})
    if "output_flood" in limits_hit:
        flags.append({"flag": "output_flood", "detail": "learner stream exceeded cap"})
    # pass_after_zero_passing_runs: a passing submit with no prior run that had >=1 passing test.
    if req["mode"] == "submit":
        history = LOG.run_history(req["student_id"], ex.ID)
        prior_runs = [h for h in history if h.get("mode") == "run"]
        any_prior_pass = any(h.get("passed_count", 0) >= 1 for h in prior_runs)
        if resp["verdict"] == "passed" and not any_prior_pass:
            flags.append({"flag": "pass_after_zero_passing_runs",
                          "detail": f"{len(prior_runs)} prior runs, none with a passing test"})
    resp["limits_hit"] = limits_hit
    resp["teacher"] = {"flags": flags}
    if frame is not None:
        resp["cgroup"] = frame.get("cgroup")
    resp["timing_ms"] = {"container": out.wall_ms, "total": int((time.monotonic() - t0) * 1000)}
    LOG.counters["jobs"] += 1
    LOG.write({"event": "JOB", "job_id": out.name, "profile": req["profile"], "student_id": req["student_id"],
               "exercise_id": ex.ID, "mode": req["mode"], "kind": getattr(ex, "KIND", "io"),
               "image_id": image_id, "containers": containers,
               "submission_sha256": hashlib.sha256(req["submission"].encode()).hexdigest(),
               "podman_argv": out.argv, "exit_code": out.exit_code, "problem": problem,
               "verdict": resp["verdict"], "passed_count": sum(1 for t in tests if t["passed"]),
               "flags": [f["flag"] for f in flags], "timing_ms": resp["timing_ms"]})
    if debug:
        resp["debug"] = {"frame": frame, "stderr": out.stderr, "problem": problem}


def execute(req, debug=False):
    """Run one validated request. Returns the response body (the caller's view)."""
    ex = validate(req)
    t0 = time.monotonic()
    prof = profiles.LEARNER_CODE
    image_id = profiles.resolve_image()  # PermissionError if not on the allowlist
    if getattr(ex, "KIND", "io") == "call":
        return _execute_call(req, ex, prof, image_id, t0, debug)
    return _execute_io(req, ex, prof, image_id, t0, debug)
