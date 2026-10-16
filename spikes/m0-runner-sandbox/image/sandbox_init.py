#!/usr/bin/env python3
"""PID 1 of the learner-code container (ALI-40 spike, throwaway).

Runs as container-root (a host *unprivileged* user, via the rootless user namespace) with only
CAP_SETUID/CAP_SETGID/CAP_KILL. It is the only process that writes to the container's stdout,
which the runner (the parent) reads. Learner code runs as uid 10002 with no capabilities, its
stdin/stdout/stderr are private pipes that this process captures and caps, and it never holds a
descriptor for the container's stdout.

Protocol: the runner writes ONE JSON job on stdin, then closes it:
  {"v":1, "nonce":"<hex>", "kind":"io", "submission":"<py source>",
   "cases":[{"stdin":"..."}], "limits":{"wall_s":..,"case_s":..,"out_bytes":..}}
and reads ONE line from stdout:  ALI40-RESULT <json>
"""
import ctypes
import json
import os
import resource
import select
import signal
import socket
import subprocess
import sys
import time

UID_LEARNER = GID_LEARNER = 10002
UID_GRADER = GID_GRADER = 10001
PY = "/usr/local/bin/python3"
WORK = "/work"
FRAME = b"ALI40-RESULT "
MAX_JOB = 8 * 1024 * 1024
OUT_FD = os.dup(1)  # the result channel; closed in every child (close_fds=True)


TRACKED = set()  # pids owned by a Popen object; reap() must never steal their exit status
MYPID = os.getpid()


def reap():
    """Collect orphaned zombies re-parented to us (PID 1). Zombies still count against the cgroup
    pids.max, so a fork bomb's corpses must be cleared. Tracked children are left to Popen."""
    for ent in os.listdir("/proc"):
        if not ent.isdigit() or int(ent) in TRACKED:
            continue
        try:
            with open(f"/proc/{ent}/stat") as fh:
                rest = fh.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if rest[0] == "Z" and int(rest[1]) == MYPID:
            try:
                os.waitpid(int(ent), os.WNOHANG)
            except ChildProcessError:
                pass


def proc_uids():
    """pid -> real uid for every live (non-zombie) process in this PID namespace, from
    /proc/<pid>/status, which is world-readable even for non-dumpable processes."""
    out = {}
    for ent in os.listdir("/proc"):
        if not ent.isdigit():
            continue
        uid, zombie = None, False
        try:
            with open(f"/proc/{ent}/status") as fh:
                for line in fh:
                    if line.startswith("State:"):
                        zombie = "Z" in line.split(None, 2)[1]
                    elif line.startswith("Uid:"):
                        uid = int(line.split()[1])
                        break
        except OSError:
            continue
        if uid is not None and not zombie:
            out[int(ent)] = uid
    return out


def kill_uid(uid, tries=200):
    """SIGKILL every process of `uid`, repeating until none is left (fork-bomb safe: signalling
    needs no new PID, and we reap zombies between rounds)."""
    for _ in range(tries):
        victims = [p for p, u in proc_uids().items() if u == uid]
        if not victims:
            return True
        for p in victims:
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
        time.sleep(0.01)
        reap()
    return False


_LIBC = ctypes.CDLL(None, use_errno=True)
PR_CAPBSET_DROP, CAP_SETPCAP = 24, 8
with open("/proc/sys/kernel/cap_last_cap") as _fh:
    _CAP_LAST = int(_fh.read())


def child_setup(uid, gid, cpu_s, fsize, nofile):
    """Runs in the forked child, still as container-root, just before exec. Order matters:
    1. empty the capability *bounding* set (SETPCAP last, it is needed to drop caps), so that even
       a setuid/file-capability binary could never regain anything;
    2. switch to the unprivileged uid/gid with no supplementary groups; changing uid away from 0
       clears the effective, permitted and ambient sets;
    3. lower rlimits (lowering needs no privilege)."""
    def pre():
        for cap in [c for c in range(_CAP_LAST + 1) if c != CAP_SETPCAP] + [CAP_SETPCAP]:
            _LIBC.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s))
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_NOFILE, (nofile, nofile))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return pre


def spawn(argv, uid, gid, stdin, cpu_s, cwd=WORK, env=None, pass_fds=(), fsize=8 << 20, nofile=64):
    p = subprocess.Popen(
        argv, cwd=cwd, env=env or {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
        stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
        pass_fds=pass_fds, start_new_session=True, preexec_fn=child_setup(uid, gid, cpu_s, fsize, nofile),
    )
    TRACKED.add(p.pid)
    try:  # make the learner the OOM killer's first choice so the supervisor survives
        with open(f"/proc/{p.pid}/oom_score_adj", "w") as fh:
            fh.write("1000")
    except OSError:
        pass
    return p


class Capture:
    """A capped, non-blocking sink for one child stream. `total` keeps counting after the cap
    so a flood is visible; `flood` trips once total exceeds `hard`."""

    def __init__(self, fd, cap, hard):
        self.fd, self.cap, self.hard = fd, cap, hard
        self.buf, self.total, self.eof = bytearray(), 0, False
        os.set_blocking(fd, False)

    def pump(self):
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self.eof = True
            return
        self.total += len(data)
        room = self.cap - len(self.buf)
        if room > 0:
            self.buf += data[:room]

    @property
    def flood(self):
        return self.total > self.hard

    def text(self):
        return self.buf.decode("utf-8", "replace")


def run_case(source_path, stdin_bytes, limits):
    """Run the learner's program once (fresh interpreter) and return its observable behaviour."""
    case_s, out_cap = limits["case_s"], limits["out_bytes"]
    t0 = time.monotonic()
    r_in, w_in = os.pipe()
    p = spawn([PY, "-I", "-B", source_path], UID_LEARNER, GID_LEARNER, r_in, cpu_s=int(case_s) + 1)
    os.close(r_in)
    os.set_blocking(w_in, False)
    out = Capture(p.stdout.fileno(), out_cap, out_cap * 8)
    err = Capture(p.stderr.fileno(), out_cap, out_cap * 8)
    pending, w_open, reason = memoryview(stdin_bytes), True, None
    deadline, drain_until = t0 + case_s, None
    while True:
        now = time.monotonic()
        if now >= deadline:
            reason = "timeout"
            break
        if out.flood or err.flood:
            reason = "output_flood"
            break
        open_streams = [c for c in (out, err) if not c.eof]
        if p.poll() is not None:
            # main process is gone; grandchildren may still hold the pipes, so only drain briefly
            drain_until = drain_until or now + 0.2
            if not open_streams or now >= drain_until:
                break
        if w_open and not pending:
            os.close(w_in)
            w_open = False
        r, w, _ = select.select([c.fd for c in open_streams], [w_in] if w_open else [], [], 0.05)
        for c in open_streams:
            if c.fd in r:
                c.pump()
        if w:
            try:
                pending = pending[os.write(w_in, pending[:65536]):]
            except BlockingIOError:
                pass
            except BrokenPipeError:
                pending = memoryview(b"")
        reap()
    if w_open:
        os.close(w_in)
    t_loop = time.monotonic()
    kill_uid(UID_LEARNER)  # nothing from this case may survive: setsid escapees, forks
    t_kill = time.monotonic()
    for c in (out, err):
        for _ in range(8):
            if c.eof:
                break
            c.pump()
    status = p.wait()
    TRACKED.discard(p.pid)
    if reason is None and status < 0:
        reason = f"signal_{-status}"
    return {
        "exit": status, "reason": reason, "ms": int((time.monotonic() - t0) * 1000),
        "loop_ms": int((t_loop - t0) * 1000), "kill_ms": int((t_kill - t_loop) * 1000),
        "stdout": out.text(), "stderr": err.text(),
        "stdout_bytes": out.total, "stderr_bytes": err.total,
        "truncated": out.total > out_cap or err.total > out_cap,
    }


def run_call(job):
    """Keep hidden source in the grader's stdin and its verdict on a private pipe."""
    limits = job["limits"]
    variant = job.get("variant", "secure")
    src = os.path.join(WORK, "submission.py")
    with open(src, "w") as fh:
        fh.write(job["submission"])
    os.chmod(src, 0o444)
    spec = job["grader"]
    if variant == "colocated":
        with open(os.path.join(WORK, "hidden_tests.py"), "w") as fh:
            fh.write(spec["tests_source"])
        with open(os.path.join(WORK, "spec.json"), "w") as fh:
            json.dump({"seed": spec["seed"]}, fh)
        p = spawn([PY, "-I", "-B", "/opt/ali40/colocated_harness.py"], UID_LEARNER,
                  GID_LEARNER, subprocess.DEVNULL, int(limits["wall_s"]) + 1,
                  env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "ALI40_NONCE": job["nonce"]})
        # This control deliberately uses the same stdout channel. Copy only its frame.
        stdout, stderr = p.communicate(timeout=limits["wall_s"])
        TRACKED.discard(p.pid)
        kill_uid(UID_LEARNER)
        if p.returncode == 0:
            os.write(OUT_FD, stdout)
        else:
            sys.stderr.write(stderr.decode("utf-8", "replace")[:4096])
        return None

    sg, sl = socket.socketpair()
    rr, rw = os.pipe()
    grader_uid = UID_LEARNER if variant == "same-uid" else UID_GRADER
    grader_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    if variant == "same-uid":
        grader_env["ALI40_NONCE"] = job["nonce"]
    g = spawn([PY, "-I", "-B", "/opt/ali40/grader_harness.py", str(sg.fileno()), str(rw)],
              grader_uid, grader_uid, subprocess.PIPE, int(limits["wall_s"]) + 1,
              env=grader_env, pass_fds=(sg.fileno(), rw))
    l = spawn([PY, "-I", "-B", "/opt/ali40/learner_harness.py", str(sl.fileno()), src],
              UID_LEARNER, GID_LEARNER, subprocess.DEVNULL, int(limits["wall_s"]) + 1,
              pass_fds=(sl.fileno(),))
    sg.close(); sl.close(); os.close(rw)
    os.set_blocking(g.stdin.fileno(), False)
    os.set_blocking(rr, False)
    captures = [Capture(l.stdout.fileno(), limits["out_bytes"], limits["out_bytes"] * 8),
                Capture(l.stderr.fileno(), limits["out_bytes"], limits["out_bytes"] * 8),
                Capture(g.stdout.fileno(), 4096, 32768), Capture(g.stderr.fileno(), 4096, 32768)]
    pending = memoryview(json.dumps({**spec, "nonce": job["nonce"], "call_s": limits["case_s"]}).encode())
    result = bytearray()
    result_eof = False
    reason = None
    deadline = time.monotonic() + limits["wall_s"]
    grace = None
    while time.monotonic() < deadline:
        if captures[0].flood or captures[1].flood:
            reason = "output_flood"
            kill_uid(UID_LEARNER)
        if g.poll() is not None:
            grace = grace or time.monotonic() + 0.2
            if result_eof or time.monotonic() >= grace:
                break
        reads = [c.fd for c in captures if not c.eof]
        if not result_eof:
            reads.append(rr)
        writes = [g.stdin.fileno()] if not g.stdin.closed and pending else []
        ready, writable, _ = select.select(reads, writes, [], 0.05)
        for c in captures:
            if c.fd in ready:
                c.pump()
        if rr in ready:
            chunk = os.read(rr, 65536)
            if chunk:
                result += chunk
                if len(result) > 256 * 1024:
                    reason = "result_flood"
                    break
            else:
                result_eof = True
        if writable:
            try:
                pending = pending[os.write(g.stdin.fileno(), pending[:65536]):]
            except (BlockingIOError, BrokenPipeError):
                pending = memoryview(b"")
        if not pending and not g.stdin.closed:
            g.stdin.close()
        reap()
    else:
        reason = "timeout"
    if not g.stdin.closed:
        g.stdin.close()
    kill_uid(UID_LEARNER)
    if grader_uid != UID_LEARNER:
        kill_uid(UID_GRADER)
    for c in captures:
        for _ in range(8):
            if c.eof:
                break
            c.pump()
    lstatus, gstatus = l.wait(), g.wait()
    TRACKED.difference_update((l.pid, g.pid))
    os.close(rr)
    try:
        parsed = json.loads(result) if len(result.splitlines()) == 1 else None
    except ValueError:
        parsed = None
    return {"grader": {"exit": gstatus, "result": parsed, "result_bytes": len(result),
                       "stderr_tail": captures[3].text()},
            "learner": {"exit": lstatus, "reason": reason, "stdout": captures[0].text(),
                        "stderr": captures[1].text(), "stdout_bytes": captures[0].total,
                        "stderr_bytes": captures[1].total,
                        "truncated": any(c.total > limits["out_bytes"] for c in captures[:2])},
            "reason": reason}


def cgroup_stats():
    """Evidence that the kernel (not our code) enforced the caps: counters from the container's own cgroup."""
    out = {}
    for name in ("memory.events", "pids.events", "memory.peak", "pids.peak", "pids.max", "memory.max", "cpu.stat"):
        try:
            with open(f"/sys/fs/cgroup/{name}") as fh:
                text = fh.read().strip()
        except OSError:
            continue
        if "\n" in text or " " in text:
            out[name] = {k: v for k, v in (ln.split(None, 1) for ln in text.splitlines() if ln.strip())}
        else:
            out[name] = text
    return out


def emit(frame):
    data = FRAME + json.dumps(frame, separators=(",", ":")).encode() + b"\n"
    view = memoryview(data)
    while view:
        view = view[os.write(OUT_FD, view):]


def main():
    raw = sys.stdin.buffer.read(MAX_JOB + 1)
    os.close(0)
    os.open("/dev/null", os.O_RDONLY)  # fd 0 now /dev/null for any child that inherits by mistake
    job = json.loads(raw)
    del raw
    nonce, kind, limits = job["nonce"], job["kind"], job["limits"]
    frame = {"v": 1, "nonce": nonce, "kind": kind}
    t0 = time.monotonic()
    if kind == "io":
        src = os.path.join(WORK, "submission.py")
        with open(src, "w") as fh:
            fh.write(job["submission"])
        os.chmod(src, 0o444)
        frame["cases"] = [run_case(src, c["stdin"].encode(), limits) for c in job["cases"]]
    elif kind == "call":
        result = run_call(job)
        if result is None:  # insecure colocated control emitted its own frame
            return 0
        frame.update(result)
    else:
        frame["error"] = f"unsupported kind {kind!r}"
    frame["supervisor_ms"] = int((time.monotonic() - t0) * 1000)
    frame["cgroup"] = cgroup_stats()
    emit(frame)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:  # fail closed: the runner treats a missing frame / non-zero exit as an error
        sys.stderr.write(f"sandbox_init internal error: {type(e).__name__}: {e}\n")
        code = 70
    sys.exit(code)
