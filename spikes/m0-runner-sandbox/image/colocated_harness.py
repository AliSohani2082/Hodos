#!/usr/bin/env python3
"""INSECURE CONTROL (variant "colocated"), used only by the adversarial suite to prove that the
attacks work when the isolation is missing. This is what a naive harness looks like: hidden tests
in a file next to the submission, the nonce in the environment, tests run in the SAME process and
uid as learner code, and the verdict printed on the container's own stdout.
Never reachable through the runner API (operator env ALI40_INSECURE_VARIANT only)."""
import json
import os
import random
import runpy

import builtins  # noqa: F401  (tests run in this namespace, so patched builtins affect them)

spec = json.load(open("/work/spec.json"))
nonce = os.environ["ALI40_NONCE"]
sub = runpy.run_path("/work/submission.py", run_name="submission")


class Direct:
    def call(self, fn, *args):
        return sub[fn](*args)


ns = {"learner": Direct(), "rnd": random.Random(spec["seed"])}
exec(compile(open("/work/hidden_tests.py").read(), "/work/hidden_tests.py", "exec"), ns)
results = []
for name, fn in [(k, v) for k, v in ns.items() if k.startswith("test_") and callable(v)]:
    try:
        fn()
        results.append({"name": name, "ok": True, "why": ""})
    except AssertionError:
        results.append({"name": name, "ok": False, "why": "assertion"})
    except Exception as e:
        results.append({"name": name, "ok": False, "why": "grader_error:" + type(e).__name__})
frame = {"v": 1, "nonce": nonce, "kind": "call", "grader": {"exit": 0, "result": {"nonce": nonce, "results": results, "done": True}},
         "learner": {"exit": 0, "reason": None, "stdout": "", "stderr": "", "stdout_bytes": 0, "stderr_bytes": 0, "truncated": False}}
print("ALI40-RESULT " + json.dumps(frame), flush=True)
