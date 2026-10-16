#!/usr/bin/env python3
"""Grader process (runs as uid 10001, a different uid from learner code).

argv: <rpc_fd> <result_fd>. The hidden tests, the per-attempt seed and the per-run nonce arrive on
stdin as one JSON object from the supervisor and exist only in this process's memory: never in a
file, in argv or in the environment. The hidden tests call the learner's functions through
`learner.call(name, *args)`: arguments and return values cross a JSON boundary, so the learner can't
hand the grader an object with a lying __eq__, and everything it sends is validated as data.

The verdict goes out on `result_fd`, a pipe whose only other end is the supervisor (uid 0). The
learner process has no descriptor for it and (different uid) can't open /proc/<pid>/fd/<n> either."""
import json
import os
import random
import select
import socket
import struct
import sys
import time

MAX_FRAME = 1 << 20


class LearnerError(Exception):
    """The learner failed in a way that fails the test (timeout, died, garbage, raised)."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def _reject_constant(name):
    raise ValueError("non-finite number")


class Proxy:
    def __init__(self, sock, call_s):
        self.sock, self.call_s, self.n, self.dead = sock, call_s, 0, None

    def _recv_exact(self, n, deadline):
        buf = b""
        while len(buf) < n:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.sock], [], [], left)[0]:
                raise LearnerError("timeout")
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise LearnerError("died")
            buf += chunk
        return buf

    def call(self, fn, *args):
        if self.dead:                       # channel already broken: fail fast, don't wait again
            raise LearnerError(self.dead)
        self.n += 1
        deadline = time.monotonic() + self.call_s
        try:
            payload = json.dumps({"id": self.n, "fn": fn, "args": list(args)}, allow_nan=False).encode()
            self.sock.settimeout(self.call_s)
            self.sock.sendall(struct.pack(">I", len(payload)) + payload)
            (size,) = struct.unpack(">I", self._recv_exact(4, deadline))
            if size > MAX_FRAME:
                raise LearnerError("protocol")
            body = self._recv_exact(size, deadline)
            resp = json.loads(body, parse_constant=_reject_constant)
        except LearnerError as e:
            self.dead = e.kind
            raise
        except (OSError, ValueError, RecursionError, MemoryError):   # timeout on send, EPIPE, bad JSON, deep nesting ...
            self.dead = "protocol"
            raise LearnerError("protocol")
        if type(resp) is not dict or resp.get("id") != self.n:
            self.dead = "protocol"           # wrong/forged/out-of-order reply
            raise LearnerError("protocol")
        if "error" in resp:
            raise LearnerError("raised")     # the learner function raised: this test fails, channel stays usable
        if "result" not in resp:
            self.dead = "protocol"
            raise LearnerError("protocol")
        return resp["result"]


def main():
    sock = socket.socket(fileno=int(sys.argv[1]))
    result_fd = int(sys.argv[2])
    spec = json.loads(sys.stdin.buffer.read())
    proxy = Proxy(sock, spec["call_s"])
    ns = {"learner": proxy, "rnd": random.Random(spec["seed"]), "LearnerError": LearnerError}
    exec(compile(spec["tests_source"], "<hidden>", "exec"), ns)
    results = []
    for name, fn in [(k, v) for k, v in ns.items() if k.startswith("test_") and callable(v)]:
        try:
            fn()
            ok, why = True, ""
        except AssertionError:
            ok, why = False, "assertion"     # never the assertion text: it could contain an expected value
        except LearnerError as e:
            ok, why = False, e.kind
        except Exception as e:
            ok, why = False, "grader_error:" + type(e).__name__
        results.append({"name": name, "ok": ok, "why": why})
    data = json.dumps({"nonce": spec["nonce"], "results": results, "done": True}).encode() + b"\n"
    while data:
        data = data[os.write(result_fd, data):]


if __name__ == "__main__":
    main()
