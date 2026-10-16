#!/usr/bin/env python3
"""Authenticated runner API (ALI-40 spike). stdlib only.

  ALI40_RUNNER_SECRET=<per-service secret> python3 runner/server.py [--port 18740]

POST /v1/jobs  (Authorization: Bearer <secret>)  body: see service.ALLOWED_FIELDS
GET  /healthz   unauthenticated liveness
GET  /v1/metrics  authenticated counters (jobs, rejected, unauthorized)
Binds 127.0.0.1 only. Never talks to a container-engine socket: see engine.py.
"""
import argparse
import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from runner import service  # noqa: E402

MAX_BODY = 128 * 1024
MAX_CONCURRENT = 3                       # global queue/quota: at most 3 sandboxes at once
GLOBAL = threading.BoundedSemaphore(MAX_CONCURRENT)
BUSY_STUDENTS, BUSY_LOCK = set(), threading.Lock()   # per-student quota: one job in flight
SECRET = ""
DEBUG = False


class Handler(BaseHTTPRequestHandler):
    server_version = "ali40-runner"

    def log_message(self, *a):  # quiet; the JSONL job log is the audit trail
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authed(self):
        got = self.headers.get("Authorization", "")
        ok = got.startswith("Bearer ") and hmac.compare_digest(got[7:].encode(), SECRET.encode())
        if not ok:
            service.LOG.rejected(401, "bad_or_missing_secret", {"path": self.path, "remote": self.client_address[0]})
            self.reply(401, {"error": "unauthorized"})
        return ok

    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(200, {"ok": True})
        if self.path == "/v1/metrics" and self.authed():
            return self.reply(200, service.LOG.counters)
        if self.path != "/v1/metrics":
            self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/jobs":
            return self.reply(404, {"error": "not_found"})
        if not self.authed():
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > MAX_BODY:
                service.LOG.rejected(413, "body_size", {"bytes": n})
                return self.reply(413, {"error": "body_size"})
            req = json.loads(self.rfile.read(n))
            service.validate(req)
        except service.Rejected as e:
            keys = sorted(req) if isinstance(req, dict) else None
            service.LOG.rejected(e.status, e.reason, {"keys": keys, "remote": self.client_address[0]})
            return self.reply(e.status, {"error": e.reason})
        except ValueError:
            service.LOG.rejected(400, "bad_json")
            return self.reply(400, {"error": "bad_json"})
        student = req["student_id"]
        with BUSY_LOCK:
            if student in BUSY_STUDENTS:
                service.LOG.rejected(429, "student_busy", {"student_id": student})
                return self.reply(429, {"error": "student_busy"})
            BUSY_STUDENTS.add(student)
        try:
            if not GLOBAL.acquire(timeout=30):
                return self.reply(503, {"error": "queue_full"})
            try:
                self.reply(200, service.execute(req, debug=DEBUG))
            finally:
                GLOBAL.release()
        except PermissionError as e:
            service.LOG.rejected(503, "image_not_allowed", {"detail": str(e)})
            self.reply(503, {"error": "image_not_allowed"})
        finally:
            with BUSY_LOCK:
                BUSY_STUDENTS.discard(student)


def main():
    global SECRET, DEBUG
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18740)
    args = ap.parse_args()
    SECRET = os.environ.get("ALI40_RUNNER_SECRET", "")
    if len(SECRET) < 24:
        sys.exit("ALI40_RUNNER_SECRET must be set (>= 24 chars)")
    DEBUG = os.environ.get("ALI40_RUNNER_DEBUG") == "1"   # operator-only; never request-selectable
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"ali40 runner listening on 127.0.0.1:{args.port} debug={DEBUG}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
