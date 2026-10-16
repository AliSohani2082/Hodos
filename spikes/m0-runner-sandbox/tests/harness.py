"""Shared helpers for the spike's drivers: start the real runner API as a subprocess, talk to it
over HTTP, and run dummy host-side listeners that stand in for Postgres / the runner API / the LAN.
Nothing here points at a real host service."""
import json
import os
import pathlib
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

SPIKE = pathlib.Path(__file__).resolve().parent.parent
PORT_RUNNER, PORT_CONTROL = 18740, 18743      # runner API (secure) / runner API (insecure control variants)
PORT_CANARY_LOOP, PORT_CANARY_ALL = 18741, 18742
ABSTRACT_CANARY = "\0ali40-host-canary"


def host_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))   # UDP connect: selects the outbound interface, sends nothing
        return s.getsockname()[0]
    finally:
        s.close()


class Canaries:
    """Dummy listeners on the host. Any accepted connection means the sandbox reached the host."""

    def __init__(self):
        self.hits, self._socks, self._stop = [], [], False
        for label, family, addr in (("loopback", socket.AF_INET, ("127.0.0.1", PORT_CANARY_LOOP)),
                                    ("all-interfaces", socket.AF_INET, ("0.0.0.0", PORT_CANARY_ALL)),
                                    ("abstract-unix", socket.AF_UNIX, ABSTRACT_CANARY)):
            s = socket.socket(family, socket.SOCK_STREAM)
            if family == socket.AF_INET:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(addr)
            s.listen(8)
            s.settimeout(0.2)
            self._socks.append(s)
            threading.Thread(target=self._accept, args=(label, s), daemon=True).start()

    def _accept(self, label, s):
        while not self._stop:
            try:
                c, _ = s.accept()
                self.hits.append(label)
                c.close()
            except (socket.timeout, OSError):
                pass

    def close(self):
        self._stop = True
        for s in self._socks:
            s.close()


class Runner:
    """The real runner API in a subprocess (so auth, policy and quotas are exercised end to end)."""

    def __init__(self, port=PORT_RUNNER, debug=True, extra_env=None):
        self.port, self.secret = port, secrets.token_urlsafe(24)
        env = {**os.environ, "ALI40_RUNNER_SECRET": self.secret, "ALI40_ENABLE_PROBE_EXERCISE": "1",
               "ALI40_RUNNER_DEBUG": "1" if debug else "0", **(extra_env or {})}
        (SPIKE / "runs").mkdir(exist_ok=True)
        self.log = open(SPIKE / "runs" / f"server-{port}.log", "w")
        self.proc = subprocess.Popen([sys.executable, "-I", str(SPIKE / "runner" / "server.py"), "--port", str(port)],
                                     env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1).read()
                return
            except OSError:
                time.sleep(0.1)
        self.stop()
        raise RuntimeError("runner did not start; see runs/server-%d.log" % port)

    def call(self, method, path, body=None, secret="default", raw=None):
        hdr = {"Content-Type": "application/json"}
        if secret == "default":
            secret = self.secret
        if secret is not None:
            hdr["Authorization"] = f"Bearer {secret}"
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, headers=hdr, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def job(self, exercise_id, submission, mode="run", student="s1", profile="learner-code", **extra):
        body = {"profile": profile, "exercise_id": exercise_id, "mode": mode, "student_id": student,
                "submission": submission, **extra}
        return self.call("POST", "/v1/jobs", body)

    def stop(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        self.log.close()


def parse_obs(text):
    out = {}
    for ln in text.splitlines():
        if ln.startswith("OBS ") and "=" in ln:
            k, v = ln[4:].split("=", 1)
            out[k] = v
    return out


def leftovers(settle=5.0):
    """What this spike left running. `podman rm -f` is asynchronous, so after a killed container
    (e.g. a fork bomb) the container/supervisor can take a moment to disappear; poll until the state
    is clean or `settle` seconds elapse. A persistent leftover still shows up (it never clears)."""
    deadline = time.monotonic() + settle
    while True:
        names = subprocess.run(["podman", "ps", "-a", "--format", "{{.Names}}"], capture_output=True, text=True).stdout.split()
        # pgrep -fc would self-match on a shell wrapper; pgrep (no -c) excludes its own pid, so count lines.
        out = subprocess.run(["pgrep", "-f", "sandbox_init.py"], capture_output=True, text=True).stdout.split()
        containers = [n for n in names if n.startswith("ali40-")]
        res = {"ali40_containers": containers, "sandbox_init_procs": len(out)}
        if (not containers and not out) or time.monotonic() >= deadline:
            return res
        time.sleep(0.25)


def substitute(src, **kw):
    for k, v in kw.items():
        src = src.replace(f"@@{k}@@", str(v))
    return src
