#!/usr/bin/env python3
"""ALI-62 OPTIONAL gVisor comparison (coordinator-approved; runsc downloaded + checksum-verified in
.tools/gvisor/). Runs the SAME supervisor + grader/learner design under podman with the gVisor
runtime (runsc) instead of crun, and re-checks the core isolation properties: honest grading, grader
uid separation, hidden tests unreadable, no network, no host socket. Writes results/gvisor.{md,json}.

Rootless gVisor under podman requires `--cgroup-manager=cgroupfs --runtime-flag ignore-cgroups`
(podman's default systemd cgroup path needs interactive auth; cgroup delegation to runsc fails).
A consequence is that the cgroup-based PID/memory/CPU caps are NOT applied via cgroups in this
rootless configuration — recorded as a caveat in the ADR. Run: python3 -I tests/gvisor_compare.py"""
import json
import pathlib
import secrets
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harness as H  # noqa: E402
from harness import SPIKE, parse_obs  # noqa: E402

sys.path.insert(0, str(SPIKE))
from runner import engine, profiles  # noqa: E402
from runner.exercises import sort_list  # noqa: E402

sys.path.insert(0, str(SPIKE / "attacks"))
import catalog  # noqa: E402

RUNSC = SPIKE / ".tools" / "gvisor" / "runsc"
ROWS = []


def row(rid, claim, expected, actual, ok):
    ROWS.append({"id": rid, "claim": claim, "expected": expected, "actual": actual, "ok": bool(ok)})
    print(f"[{'PASS' if ok else 'FAIL'}] {rid}: {claim}\n        expected: {expected}\n        actual:   {actual}", flush=True)


def gvisor_argv(name, image_id, wall_s):
    p = profiles.LEARNER_CODE
    return [
        "podman", "--cgroup-manager=cgroupfs", "run", "--rm", "-i", "--name", name, "--label", "ali40=1",
        "--runtime", str(RUNSC), "--runtime-flag", "ignore-cgroups", "--pull", "never",
        "--network", "none", "--read-only", "--read-only-tmpfs=false",
        "--tmpfs", f"/work:rw,size={p['work_tmpfs']},mode=1777,noexec,nosuid,nodev",
        "--cap-drop", "all", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP", "--cap-add", "KILL",
        "--security-opt", "no-new-privileges", "--log-driver", "none", "--hostname", "ali40-gvisor", "--no-hosts",
        image_id, "/usr/local/bin/python3", "-I", "-B", "/opt/ali40/sandbox_init.py",
    ]


def run_call(image_id, submission, source, wall_s=12.0):
    name = f"ali40-gv-{secrets.token_hex(4)}"
    nonce = engine.new_nonce()
    job = {"v": 1, "nonce": nonce, "kind": "call", "variant": "secure", "submission": submission,
           "limits": {"case_s": 3.0, "out_bytes": 32768, "wall_s": wall_s},
           "grader": {"tests_source": source, "seed": 7}}
    argv = gvisor_argv(name, image_id, wall_s)
    try:
        p = subprocess.run(argv, input=json.dumps(job).encode(), capture_output=True, timeout=wall_s + 20)
    except subprocess.TimeoutExpired:
        subprocess.run(["podman", "rm", "-f", name], capture_output=True)
        return None, None, "container_timeout", ""
    oc = engine.Outcome(name=name, exit_code=p.returncode, stdout=p.stdout,
                        stderr=p.stderr[:4096].decode("utf-8", "replace"))
    frame, problem = engine.parse_frame(oc, nonce)
    names = sort_list.test_names(source)
    results = None
    if frame is not None:
        results, problem = engine.validate_call_frame(frame, nonce, names)
    return frame, results, problem, oc.stderr


def main():
    if not RUNSC.exists():
        print("runsc not present; skipping gVisor comparison"); return
    image_id = profiles.resolve_image()
    rc = subprocess.run([str(RUNSC), "--version"], capture_output=True, text=True).stdout.strip().splitlines()[0]
    row("GV-RUN-0", "runsc is present, checksum-verified, and runs on this kernel", "runsc --version prints a release",
        rc, rc.startswith("runsc version"))

    can = H.Canaries()
    try:
        # honest grading under gVisor
        f, res, prob, _ = run_call(image_id, sort_list.EXAMPLE_SOLUTION, sort_list.HIDDEN_SOURCE)
        good_pass = res is not None and all(r["ok"] for r in res)
        f2, res2, prob2, _ = run_call(image_id, "def my_sort(xs):\n    return xs\n", sort_list.HIDDEN_SOURCE)
        bad_fail = res2 is not None and not all(r["ok"] for r in res2)
        row("GV-CALL-1", "under gVisor, a correct solution passes the hidden tests and a wrong one fails (honest grading)",
            "good -> all ok; wrong -> some fail", f"good_all_ok={good_pass} (problem={prob}) wrong_all_ok={res2 and all(r['ok'] for r in res2)} (problem={prob2})",
            good_pass and bad_fail)

        atk = {a["id"]: a for a in catalog.ATTACKS}
        # read-proc-grader attack under gVisor
        f, res, prob, _ = run_call(image_id, atk["read-proc-grader"]["submission"], sort_list.HIDDEN_SOURCE)
        o = parse_obs((f["learner"]["stdout"] + f["learner"]["stderr"]) if f else "")
        forged = res is not None and all(r["ok"] for r in res)
        row("GV-ISO-1", "under gVisor, the hidden tests remain unreadable from the learner and no pass is forged",
            "leaked=False and not a forced pass", f"leaked={o.get('leaked')} forged_pass={forged} grader_pid={o.get('grader_pid')}",
            o.get("leaked") == "False" and not forged)

        # network blocked under gVisor
        f, res, prob, _ = run_call(image_id, atk["net-exfil"]["submission"], sort_list.HIDDEN_SOURCE)
        o = parse_obs((f["learner"]["stdout"] + f["learner"]["stderr"]) if f else "")
        row("GV-NET-1", "under gVisor, no network is reachable and no host canary is hit",
            "net_ok=False, 0 canary hits", f"net_ok={o.get('net_ok')} canary_hits={can.hits}",
            o.get("net_ok") == "False" and not can.hits)

        # host sockets absent under gVisor
        f, res, prob, _ = run_call(image_id, atk["escape-sockets"]["submission"], sort_list.HIDDEN_SOURCE)
        o = parse_obs((f["learner"]["stdout"] + f["learner"]["stderr"]) if f else "")
        row("GV-ESC-1", "under gVisor, no host container-engine socket or pid-1 root is reachable",
            "sockets_exist=False", f"sockets_exist={o.get('sockets_exist')}",
            o.get("sockets_exist") == "False")
    finally:
        can.close()
        subprocess.run("podman ps -a --format '{{.Names}}' | grep '^ali40-gv' | xargs -r podman rm -f",
                       shell=True, capture_output=True)

    (SPIKE / "results").mkdir(exist_ok=True)
    (SPIKE / "results" / "gvisor.json").write_text(json.dumps(ROWS, indent=1) + "\n")
    lines = ["| ID | Claim | Expected | Actual | Result |", "|---|---|---|---|---|"]
    for r in ROWS:
        esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r['id']} | {esc(r['claim'])} | {esc(r['expected'])} | {esc(r['actual'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
    (SPIKE / "results" / "gvisor.md").write_text("\n".join(lines) + "\n")
    failed = [r["id"] for r in ROWS if not r["ok"]]
    print(f"\n{len(ROWS) - len(failed)}/{len(ROWS)} passed" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
