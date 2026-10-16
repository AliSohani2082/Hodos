#!/usr/bin/env python3
"""ALI-60 acceptance: the learner-code profile enforces its limits, through the real API.
Writes results/limits.json and results/limits.md. Run: python3 tests/limits_suite.py"""
import json
import pathlib
import statistics
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import harness as H  # noqa: E402
from harness import SPIKE, parse_obs  # noqa: E402

sys.path.insert(0, str(SPIKE))
from runner.exercises import sum_two  # noqa: E402

PROBES = SPIKE / "tests" / "probes"
ROWS = []


def row(rid, claim, expected, actual, ok):
    ROWS.append({"id": rid, "claim": claim, "expected": expected, "actual": actual, "ok": bool(ok)})
    print(f"[{'PASS' if ok else 'FAIL'}] {rid}: {claim}\n        expected: {expected}\n        actual:   {actual}", flush=True)


def probe(rn, name, host_ip):
    src = H.substitute((PROBES / f"{name}.py").read_text(), HOST_IP=host_ip,
                       CANARY_LOOP=H.PORT_CANARY_LOOP, CANARY_ALL=H.PORT_CANARY_ALL)
    status, resp = rn.job("probe-1", src)
    assert status == 200, (status, resp)
    assert resp["debug"]["frame"], (name, resp.get("error"), resp["debug"])
    case = resp["debug"]["frame"]["cases"][0]
    return resp, case, parse_obs(case["stdout"]), resp["debug"]["frame"]["cgroup"]


def main():
    (SPIKE / "runs").mkdir(exist_ok=True)
    (SPIKE / "runs" / "jobs.jsonl").unlink(missing_ok=True)   # start from a clean audit log
    can, rn, ip = H.Canaries(), H.Runner(), H.host_ip()
    try:
        # ---- identity / profile -----------------------------------------------------------
        resp, case, o, cg = probe(rn, "identity", ip)
        row("L-ID-1", "learner runs non-root with an empty capability set (effective, permitted AND bounding), no_new_privs, seccomp filter",
            "uid=10002 CapEff=0 CapBnd=0 NoNewPrivs=1 Seccomp=2",
            f"uid={o['uid']} CapEff={o['CapEff']} CapBnd={o['CapBnd']} NoNewPrivs={o['NoNewPrivs']} Seccomp={o['Seccomp']}",
            o["uid"] == "10002" and set(o["CapEff"]) == {"0"} and set(o["CapBnd"]) == {"0"} and o["NoNewPrivs"] == "1" and o["Seccomp"] == "2")
        writes = {k[6:]: v for k, v in o.items() if k.startswith("write.")}
        row("L-FS-1", "the only writable path is /work (16 MiB tmpfs); rootfs, /tmp, /etc, /opt and /dev/shm are read-only",
            "writable: /work only; every other probed path EROFS", json.dumps(writes),
            [p for p, v in writes.items() if v == "writable"] == ["/work"])
        row("L-ENV-1", "no application environment leaks into the sandbox", "environ keys subset of {PATH, LANG}",
            o["environ_keys"], set(eval(o["environ_keys"])) <= {"PATH", "LANG"})
        mounts = eval(o["mounts"])
        bad = [m for m in mounts if any(m.startswith(p) for p in ("/home", "/root", "/run/user", "/var/run", "/run/podman", "/mnt", "/media", "/host", "/var/lib"))]
        socks = {k[7:]: v for k, v in o.items() if k.startswith("exists.")}
        row("L-NOSOCK-1", "no host container-engine socket and no host bind mount is visible (TM-013)",
            "no docker/podman/containerd/crio socket path exists; no mount under /home,/run/user,/var/run,...",
            f"sockets_present={[k for k, v in socks.items() if v == 'True']} suspicious_mounts={bad} all_mounts={mounts}",
            not [k for k, v in socks.items() if v == "True"] and not bad)

        # ---- network ---------------------------------------------------------------------
        before = len(can.hits)
        resp, case, o, cg = probe(rn, "network", ip)
        outs = {k: v for k, v in o.items() if k not in ("interfaces", "routes")}
        refused = all(v not in ("CONNECTED", "ANSWERED", "RESOLVED", "OPENED") for v in outs.values() if v) and o["dns.example.com"].startswith("FAILED")
        row("L-NET-1", "no network: only loopback, no route; TCP/UDP/DNS/abstract-unix/raw to dummy host listeners and public IPs all fail",
            "interfaces=['lo'], routes=0, zero host listener hits, raw socket EPERM",
            f"interfaces={o['interfaces']} routes={o['routes']} hits={can.hits[before:]} results={outs}",
            eval(o["interfaces"]) == ["lo"] and o["routes"] == "0" and len(can.hits) == before and refused and o["raw_socket"] == "EPERM")

        # ---- PID cap ---------------------------------------------------------------------
        resp, case, o, cg = probe(rn, "pids", ip)
        n = int(o["fork.children_started"])
        row("L-PID-1", "PID cap 64 (cgroup pids.max): bounded fork loop stops with EAGAIN near the cap; kernel counts the hits",
            "fork.error=EAGAIN, children in [55,63], pids.events max >= 1, pids.max=64",
            f"fork.error={o['fork.error']} children={n} pids.peak={cg['pids.peak']} pids.events={cg['pids.events']} pids.max={cg['pids.max']}",
            o["fork.error"] == "EAGAIN" and 55 <= n <= 63 and int(cg["pids.events"]["max"]) >= 1 and cg["pids.max"] == "64")

        # ---- memory ----------------------------------------------------------------------
        resp, case, o, cg = probe(rn, "memory", ip)
        last = int(o.get("mem.allocated_mib", 0))
        row("L-MEM-1", "memory cap 256 MiB (no swap): allocator is OOM-killed, supervisor survives and reports",
            "learner exit -9, never reaches 'survived', oom_kill>=1, last alloc < 256 MiB",
            f"exit={case['exit']} last_alloc_mib={last} oom_kill={cg['memory.events']['oom_kill']} memory.peak={int(cg['memory.peak'])>>20}MiB survived={'mem.survived' in o}",
            case["exit"] == -9 and "mem.survived" not in o and int(cg["memory.events"]["oom_kill"]) >= 1 and last < 256)

        # ---- disk ------------------------------------------------------------------------
        resp, case, o, cg = probe(rn, "disk", ip)
        row("L-DISK-1", "disk cap: the /work tmpfs is 16 MiB (ENOSPC), one file is capped at 8 MiB (EFBIG), /dev/shm is read-only",
            "disk.error=ENOSPC with written <= 16 MiB; fsize.error=EFBIG; shm.error=EROFS",
            f"disk.error={o.get('disk.error')} written_mib={o.get('disk.written_mib')} fsize.error={o.get('fsize.error')} shm.error={o.get('shm.error')}",
            o.get("disk.error") == "ENOSPC" and int(o.get("disk.written_mib", 99)) <= 16 and o.get("fsize.error") == "EFBIG" and o.get("shm.error") == "EROFS")
        row("L-DISK-2", "inode exhaustion of /work is bounded (podman cannot set nr_inodes; the 256 MiB memory cap is the real bound)",
            "60k empty files either hit ENOSPC or complete without killing the supervisor/host",
            f"inodes.created={o.get('inodes.created')} inodes.error={o.get('inodes.error')} exit={case['exit']} memory.peak={int(cg['memory.peak'])>>20}MiB",
            "inodes.created" in o and cg["pids.events"]["max"] == "0")

        # ---- output cap ------------------------------------------------------------------
        resp, case, o, cg = probe(rn, "output", ip)
        cap = 32 * 1024
        row("L-OUT-1", "output cap: an unbounded stdout+stderr flood is cut by the supervisor (kept 32 KiB/stream, killed past 8x)",
            "reason=output_flood, kept <= 32 KiB per stream, killed within 2 s, runner stdout stays 1 line",
            f"reason={case['reason']} stdout_kept={len(case['stdout'])} stderr_kept={len(case['stderr'])} read_total={case['stdout_bytes']+case['stderr_bytes']} ms={case['ms']}",
            case["reason"] == "output_flood" and len(case["stdout"]) <= cap and len(case["stderr"]) <= cap and case["ms"] < 2000)

        # ---- wall time / cpu -------------------------------------------------------------
        t0 = time.monotonic()
        resp, case, o, cg = probe(rn, "cpu_spin", ip)
        row("L-TIME-1", "wall-time cap: busy loop killed at the 2.0 s per-case limit and nothing survives",
            "reason=timeout, 2.0 s <= ms < 2.5 s, kill_ms < 250", f"reason={case['reason']} ms={case['ms']} kill_ms={case['kill_ms']}",
            case["reason"] == "timeout" and 2000 <= case["ms"] < 2500 and case["kill_ms"] < 250)
        resp, case, o, cg = probe(rn, "sleeper", ip)
        row("L-TIME-2", "a sleeping program is also killed at the wall limit", "reason=timeout",
            f"reason={case['reason']} ms={case['ms']}", case["reason"] == "timeout")
        resp, case, o, cg = probe(rn, "cpu_multi", ip)
        cpu_s = int(cg["cpu.stat"]["usage_usec"]) / 1e6
        row("L-CPU-1", "CPU cap (cpus=1): 4 spinning processes for 1.5 s wall consume ~1.5 CPU-s, not 6",
            "cgroup CPU usage <= 2.2 s (4x1.5 = 6.0 s uncapped)",
            f"cpu_usage_s={cpu_s:.2f} wall_s={o['cpu.wall_s']} nr_throttled={cg['cpu.stat']['nr_throttled']}", cpu_s <= 2.2)

        # ---- API policy (DP-3) ------------------------------------------------------------
        ok_body = {"profile": "learner-code", "exercise_id": "sum-two", "mode": "run", "student_id": "s1", "submission": "print(5)\n"}
        st_none, _ = rn.call("POST", "/v1/jobs", ok_body, secret=None)
        st_bad, _ = rn.call("POST", "/v1/jobs", ok_body, secret="wrong-secret-of-some-length")
        row("L-API-1", "runner API requires the per-service secret", "no secret -> 401; wrong secret -> 401", f"none={st_none} wrong={st_bad}",
            st_none == 401 and st_bad == 401)
        rejects = {}
        for key, val in (("mounts", ["/:/host"]), ("volumes", ["/var/run/docker.sock:/var/run/docker.sock"]), ("network", "host"),
                         ("image", "evil/image:latest"), ("privileged", True), ("limits", {"pids": 100000}),
                         ("env", {"X": "1"}), ("cap_add", ["SYS_ADMIN"]), ("docker_socket", True)):
            st, r = rn.call("POST", "/v1/jobs", {**ok_body, key: val})
            rejects[key] = (st, r.get("error"))
        row("L-API-2", "callers cannot choose mounts, network, image, limits, caps or sockets: every such field is rejected before any container starts",
            "all 400 unknown_fields:<field>", json.dumps(rejects), all(v[0] == 400 and v[1] == f"unknown_fields:{k}" for k, v in rejects.items()))
        st_prof, r_prof = rn.call("POST", "/v1/jobs", {**ok_body, "profile": "agent-job"})
        st_big, r_big = rn.call("POST", "/v1/jobs", {**ok_body, "submission": "#" * 70000})
        row("L-API-3", "only the learner-code profile is enabled; other §9.4 profiles and oversized submissions are rejected",
            "agent-job -> 400 profile_not_enabled; 70 KB submission -> 413", f"agent-job={st_prof}/{r_prof.get('error')} big={st_big}/{r_big.get('error')}",
            st_prof == 400 and r_prof.get("error") == "profile_not_enabled" and st_big == 413)
        st_m, metrics = rn.call("GET", "/v1/metrics")
        log = [json.loads(ln) for ln in (SPIKE / "runs" / "jobs.jsonl").read_text().splitlines()]
        argv = next(e["podman_argv"] for e in log if e.get("event") == "JOB")
        forbidden = [a for a in argv if "docker.sock" in a or "podman.sock" in a or a in ("-v", "--volume", "--mount", "--privileged", "--network=host")]
        row("L-API-4", "every job spec is logged and rejected specs are counted (alert hook); the logged podman argv has no socket/volume/privileged",
            "policy rejects == 11, unauthorized == 2, REJECTED log lines == 13, logged argv contains --network none and none of the forbidden flags",
            f"counters={metrics} rejected_events={sum(1 for e in log if e.get('event') == 'REJECTED')} net_none={'none' in argv[argv.index('--network')+1]} forbidden={forbidden}",
            metrics["rejected"] == 11 and metrics["unauthorized"] == 2 and sum(1 for e in log if e.get("event") == "REJECTED") == 13 and argv[argv.index("--network") + 1] == "none" and not forbidden)

        # ---- functional: Python submission against practice tests, latency ---------------
        st, ok = rn.job("sum-two", sum_two.EXAMPLE_SOLUTION)
        st2, bad = rn.job("sum-two", "print(42)\n")
        row("L-RUN-1", "a correct Python submission passes the practice tests; a wrong one fails with per-test feedback",
            "correct -> passed (3/3), wrong -> failed (0/3)",
            f"correct={ok['verdict']} {[t['passed'] for t in ok['tests']]} wrong={bad['verdict']} {[t['passed'] for t in bad['tests']]}",
            ok["verdict"] == "passed" and bad["verdict"] == "failed")
        lat = []
        for _ in range(20):
            lat.append(rn.job("sum-two", sum_two.EXAMPLE_SOLUTION)[1]["timing_ms"]["total"])
        lat.sort()
        row("L-PERF-1", "end-to-end latency of a 3-case run (container create+start+run+teardown), 20 sequential runs",
            "recorded (no threshold)", f"p50={statistics.median(lat)} ms p95={lat[18]} ms min={lat[0]} max={lat[-1]}", True)

        left = H.leftovers()
        row("L-CLEAN-1", "no containers or supervisor processes are left behind by the suite", "none", json.dumps(left),
            not left["ali40_containers"] and left["sandbox_init_procs"] == 0)
    finally:
        rn.stop()
        can.close()
    out = SPIKE / "results"
    out.mkdir(exist_ok=True)
    (out / "limits.json").write_text(json.dumps(ROWS, indent=1) + "\n")
    lines = ["| ID | Claim | Expected | Actual | Result |", "|---|---|---|---|---|"]
    for r in ROWS:
        esc = lambda s: str(s).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {r['id']} | {esc(r['claim'])} | {esc(r['expected'])} | {esc(r['actual'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
    (out / "limits.md").write_text("\n".join(lines) + "\n")
    failed = [r["id"] for r in ROWS if not r["ok"]]
    print(f"\n{len(ROWS) - len(failed)}/{len(ROWS)} passed" + (f"; FAILED: {failed}" if failed else ""))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
