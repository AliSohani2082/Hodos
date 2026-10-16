"""Runs one job in one container. The runner is the *parent*: it feeds the job on stdin, reads the
container's stdout (written only by the in-container supervisor) with a hard byte cap and a
deadline, and fails closed on anything unexpected. No Docker/Podman socket is involved: this is
the daemonless `podman` CLI forking conmon + crun as the unprivileged runner user."""
import hmac
import json
import os
import select
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, field

from . import profiles

FRAME_PREFIX = b"ALI40-RESULT "


@dataclass
class Outcome:
    name: str
    exit_code: int | None = None
    stdout: bytes = b""
    stderr: str = ""
    timed_out: bool = False
    flooded: bool = False
    wall_ms: int = 0
    argv: list = field(default_factory=list)


def new_nonce():
    return secrets.token_hex(16)  # 128 bits, single use, known to the runner and the grader only


def run_container(job, image_id, wall_s, profile=profiles.LEARNER_CODE):
    """Start the container, return what the *parent* observed. `job` is JSON-serialisable."""
    name = f"ali40-{secrets.token_hex(4)}"
    argv = profiles.podman_argv(name, image_id, wall_s, profile)
    payload = json.dumps(job, separators=(",", ":")).encode()
    t0 = time.monotonic()
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True)

    def feed():
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass
    threading.Thread(target=feed, daemon=True).start()

    out, err = bytearray(), bytearray()
    cap = profile["frame_cap"]
    deadline = t0 + wall_s + profile["startup_s"]
    timed_out = flooded = False
    streams = {proc.stdout.fileno(): out, proc.stderr.fileno(): err}
    for fd in streams:
        os.set_blocking(fd, False)
    while streams:
        now = time.monotonic()
        if now >= deadline:
            timed_out = True
            break
        if len(out) > cap:
            flooded = True
            break
        ready, _, _ = select.select(list(streams), [], [], min(0.1, deadline - now))
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                continue
            if not data:
                del streams[fd]
            else:
                buf = streams[fd]
                if len(buf) < cap + 65536:
                    buf += data
    if timed_out or flooded:
        _kill(name)
    try:
        code = proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        _kill(name)
        proc.kill()
        code = proc.wait()
    return Outcome(name=name, exit_code=code, stdout=bytes(out), stderr=bytes(err[:4096]).decode("utf-8", "replace"),
                   timed_out=timed_out, flooded=flooded, wall_ms=int((time.monotonic() - t0) * 1000), argv=argv)


def _kill(name):
    for cmd in (["podman", "kill", name], ["podman", "rm", "-f", name]):
        subprocess.run(cmd, capture_output=True, timeout=20)


def parse_frame(outcome, nonce):
    """Fail-closed frame extraction. Returns (frame, problem). A frame is trusted only if the
    container exited 0, stdout is exactly one well-formed frame line, and the nonce matches."""
    if outcome.timed_out:
        return None, "timeout"
    if outcome.flooded:
        return None, "stdout_flood"
    if outcome.exit_code != 0:
        return None, f"exit_{outcome.exit_code}"
    lines = outcome.stdout.splitlines()
    if len(lines) != 1 or not lines[0].startswith(FRAME_PREFIX):
        return None, "frame_count"
    try:
        frame = json.loads(lines[0][len(FRAME_PREFIX):])
    except ValueError:
        return None, "frame_json"
    if not isinstance(frame, dict) or frame.get("v") != 1:
        return None, "frame_shape"
    got = frame.get("nonce")
    if not isinstance(got, str) or not hmac.compare_digest(got.encode(), nonce.encode()):
        return None, "nonce_mismatch"
    return frame, None
