#!/usr/bin/env python3
"""ALI-62 adversarial suite. Runs every submission in attacks/catalog.py through the REAL runner API
(submit mode) and records expected-vs-actual. Secure runs must all be CONTAINED (no forged pass, no
leak, limits enforced, nothing left behind); the same read/forge attacks are also run against the
insecure controls (colocated / same-uid) to show they succeed there. Also two in-process white-box
checks (nonce brute force, replay). Writes results/attacks-secure|colocated|same-uid.{md,json}.

Run: python3 -I tests/attack_suite.py"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harness as H  # noqa: E402
from harness import SPIKE  # noqa: E402

sys.path.insert(0, str(SPIKE))
from runner import engine  # noqa: E402

sys.path.insert(0, str(SPIKE / "attacks"))
import catalog  # noqa: E402

NEEDLES = [b"HODOS-" + b"CANARY-7a3f9c2e1b8d4056", b"ANSWER-" + b"KEY-sort-list-6f1e8a9c0d2b3e47"]
# Which attacks are rerun against the insecure controls, and the OBS key that flips True there (or a
# forged pass, seen as verdict==passed). colocated: hidden tests in a readable file + nonce in the
# learner's own env + verdict on the shared stdout -> full break (leak AND a forged pass). same-uid:
# the grader shares the learner's uid, so the learner can SIGNAL/kill it (grading DoS); memory/env
# still resist reads here thanks to the non-dumpable flag + Yama (documented in the ADR).
CONTROL_CASES = {
    "colocated": [("read-fs-walk", "leaked"), ("read-env", "env_leak"),
                  ("steal-nonce", "nonce_found"), ("forge-colocated-pass", "forged")],
    "same-uid": [("kill-grader", "killed")],
}


def observable(resp):
    """All text the driver can see about what the learner did (stdout+stderr, both variants)."""
    parts = []
    frame = (resp.get("debug") or {}).get("frame")
    if frame and isinstance(frame.get("learner"), dict):
        parts += [frame["learner"].get("stdout", ""), frame["learner"].get("stderr", "")]
    parts.append((resp.get("debug") or {}).get("stderr", "") or "")
    return "\n".join(parts)


def leaked_needle(text):
    b = text.encode("utf-8", "replace")
    return any(n in b for n in NEEDLES)


def run_attack(rn, a):
    st, resp = rn.job(a["exercise"], a["submission"], mode=a["mode"], student="atk")
    obs = H.parse_obs(observable(resp))
    return st, resp, obs


def eval_secure(a, st, resp, obs, leftovers, needle):
    exp, reasons = a["secure"], []
    ok = True
    if exp.get("not_passed") and resp.get("verdict") == "passed":
        ok = False; reasons.append("FORGED PASS")
    if exp.get("no_leak") and needle:
        ok = False; reasons.append("CANARY LEAK")
    for k, want in exp.get("obs", {}).items():
        got = obs.get(k)
        if got != want:
            ok = False; reasons.append(f"{k}={got}!={want}")
    if exp.get("no_leftovers") and (leftovers["ali40_containers"] or leftovers["sandbox_init_procs"]):
        ok = False; reasons.append(f"LEFTOVERS {leftovers}")
    return ok, reasons


def main():
    catalog.main()  # (re)write attacks/manifest.json
    out = SPIKE / "results"
    out.mkdir(exist_ok=True)
    (SPIKE / "runs").mkdir(exist_ok=True)
    (SPIKE / "runs" / "jobs.jsonl").unlink(missing_ok=True)
    can = H.Canaries()
    secure_rows = []
    try:
        rn = H.Runner()
        try:
            for a in catalog.ATTACKS:
                st, resp, obs = run_attack(rn, a)
                left = H.leftovers()
                needle = leaked_needle(observable(resp))
                ok, reasons = eval_secure(a, st, resp, obs, left, needle)
                decisive = {k: obs.get(k) for k in a["secure"].get("obs", {})}
                actual = f"verdict={resp.get('verdict')} error={resp.get('error')} obs={decisive} leftovers={'none' if not (left['ali40_containers'] or left['sandbox_init_procs']) else left}"
                secure_rows.append({"id": a["id"], "category": a["category"], "claim": a["desc"],
                                    "expected": "contained: " + ", ".join(f"{k}" for k in a["secure"]),
                                    "actual": actual, "ok": ok, "reasons": reasons,
                                    "flags": [f["flag"] for f in (resp.get("teacher") or {}).get("flags", [])]})
                print(f"[{'PASS' if ok else 'FAIL'}] {a['id']} ({a['category']}): {actual}"
                      + ("" if ok else f"  <-- {reasons}"), flush=True)

            # ---- white-box: nonce is unguessable and single-use --------------------------
            N = engine.new_nonce()
            accepted = 0
            for _ in range(100000):
                guess = engine.new_nonce()
                line = engine.FRAME_PREFIX + json.dumps({"v": 1, "nonce": guess}).encode() + b"\n"
                f, p = engine.parse_frame(engine.Outcome(name="b", exit_code=0, stdout=line), N)
                if f is not None:
                    accepted += 1
            secure_rows.append({"id": "wb-nonce-brute", "category": "forge",
                                "claim": "100k forged frames with guessed nonces are all rejected",
                                "expected": "0 accepted", "actual": f"accepted={accepted}/100000",
                                "ok": accepted == 0, "reasons": [], "flags": []})
            print(f"[{'PASS' if accepted == 0 else 'FAIL'}] wb-nonce-brute: accepted={accepted}/100000", flush=True)

            N2 = engine.new_nonce()
            good = engine.FRAME_PREFIX + json.dumps({"v": 1, "nonce": N2}).encode() + b"\n"
            oc = engine.Outcome(name="r", exit_code=0, stdout=good)
            first = engine.parse_frame(oc, N2)[0] is not None
            replays = sum(1 for _ in range(1000) if engine.parse_frame(oc, N2)[0] is not None)
            secure_rows.append({"id": "wb-replay", "category": "forge",
                                "claim": "a captured valid frame replayed 1000x is rejected (single-use nonce)",
                                "expected": "first accepted, 0 replays accepted",
                                "actual": f"first={first} replays_accepted={replays}",
                                "ok": first and replays == 0, "reasons": [], "flags": []})
            print(f"[{'PASS' if first and replays == 0 else 'FAIL'}] wb-replay: first={first} replays_accepted={replays}", flush=True)
        finally:
            rn.stop()

        # ---- controls: the same attacks succeed when the isolation is absent --------------
        by_id = {a["id"]: a for a in catalog.ATTACKS}
        control_results = {}
        for variant, cases in CONTROL_CASES.items():
            rows = []
            rn = H.Runner(port=H.PORT_CONTROL, extra_env={"ALI40_INSECURE_VARIANT": variant})
            try:
                for aid, key in cases:
                    a = by_id[aid]
                    st, resp, obs = run_attack(rn, a)
                    needle = leaked_needle(observable(resp))
                    compromised = obs.get(key) == "True" or needle or resp.get("verdict") == "passed"
                    rows.append({"id": aid, "category": a["category"], "claim": a["desc"],
                                 "expected": f"COMPROMISED ({key} True / leak / forged pass): isolation absent",
                                 "actual": f"{key}={obs.get(key)} needle={needle} verdict={resp.get('verdict')}",
                                 "ok": bool(compromised), "reasons": [], "flags": []})
                    print(f"[{'PASS' if compromised else 'FAIL'}] control/{variant} {aid}: {key}={obs.get(key)} needle={needle} verdict={resp.get('verdict')}", flush=True)
            finally:
                rn.stop()
            control_results[variant] = rows
    finally:
        can.close()

    # canary listeners must never have been reached by any attack
    net_ok = len(can.hits) == 0
    secure_rows.append({"id": "net-canary-hits", "category": "network",
                        "claim": "no attack ever reached a host canary listener (TCP/UDP/abstract-unix)",
                        "expected": "0 canary hits", "actual": f"hits={can.hits}", "ok": net_ok, "reasons": [], "flags": []})
    left = H.leftovers()
    secure_rows.append({"id": "final-clean", "category": "cleanup",
                        "claim": "no ali40 container or supervisor process remains after the whole suite",
                        "expected": "none", "actual": json.dumps(left),
                        "ok": not left["ali40_containers"] and not left["sandbox_init_procs"], "reasons": [], "flags": []})

    def dump(name, rows):
        (out / f"attacks-{name}.json").write_text(json.dumps(rows, indent=1) + "\n")
        lines = ["| ID | Category | Attack | Expected | Actual | Result |", "|---|---|---|---|---|---|"]
        for r in rows:
            esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
            lines.append(f"| {r['id']} | {r['category']} | {esc(r['claim'])} | {esc(r['expected'])} | {esc(r['actual'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
        (out / f"attacks-{name}.md").write_text("\n".join(lines) + "\n")

    dump("secure", secure_rows)
    for variant, rows in control_results.items():
        dump(variant, rows)

    failed = [r["id"] for r in secure_rows if not r["ok"]]
    cfail = [f"{v}/{r['id']}" for v, rows in control_results.items() for r in rows if not r["ok"]]
    print(f"\nSECURE: {len(secure_rows) - len(failed)}/{len(secure_rows)} contained"
          + (f"; FAILED: {failed}" if failed else ""))
    print(f"CONTROLS: {sum(1 for rows in control_results.values() for r in rows if r['ok'])}"
          f"/{sum(len(rows) for rows in control_results.values())} demonstrated compromise"
          + (f"; NOT compromised: {cfail}" if cfail else ""))
    sys.exit(1 if failed or cfail else 0)


if __name__ == "__main__":
    main()
