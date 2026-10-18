#!/usr/bin/env python3
"""Learner-side RPC server (runs as uid 10002). It imports the submission and answers
function-call requests from the grader over an inherited socketpair (fd given in argv[1]).

This file is a convenience, NOT a boundary: the learner's code runs in this very interpreter and
can rewrite anything here, or ignore it and send arbitrary bytes on the socket. The grader treats
every byte from this socket as untrusted data (see grader_harness.py)."""
import json
import runpy
import socket
import struct
import sys

MAX_FRAME = 1 << 20


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def main():
    sock = socket.socket(fileno=int(sys.argv[1]))
    ns, import_error = {}, None
    try:
        ns = runpy.run_path(sys.argv[2], run_name="submission")
    except BaseException as e:  # the learner's traceback goes to its own stderr (shown on "run")
        import traceback
        traceback.print_exc()
        import_error = type(e).__name__
    while True:
        hdr = recv_exact(sock, 4)
        if hdr is None:
            return
        (n,) = struct.unpack(">I", hdr)
        if n > MAX_FRAME:
            return
        body = recv_exact(sock, n)
        if body is None:
            return
        req = json.loads(body)
        try:
            if import_error:
                raise RuntimeError(import_error)
            out = json.dumps({"id": req["id"], "result": ns[req["fn"]](*req["args"])}, allow_nan=False)
        except BaseException as e:
            out = json.dumps({"id": req["id"], "error": type(e).__name__})
        data = out.encode()
        sock.sendall(struct.pack(">I", len(data)) + data)


if __name__ == "__main__":
    main()
