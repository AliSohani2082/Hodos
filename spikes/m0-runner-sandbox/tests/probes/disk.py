import sys, os, errno
def obs(k, v): print(f"OBS {k}={v}", flush=True)
buf = b"x" * (1 << 20)
written = 0
try:
    for f in range(40):                      # 4 MiB files (RLIMIT_FSIZE is 8 MiB per file) until the tmpfs is full
        with open(f"/work/f{f}", "wb") as fh:
            for i in range(4):
                fh.write(buf); fh.flush(); written += 1
    obs("disk.error", "none")
except OSError as e:
    obs("disk.error", errno.errorcode[e.errno])
obs("disk.written_mib", written)
for f in os.listdir("/work"):
    if f.startswith("f"): os.unlink("/work/" + f)   # (submission.py is root-owned in a sticky dir: not ours to delete)
try:
    with open("/work/big", "wb") as fh:      # one file past the per-file rlimit (8 MiB)
        for i in range(12): fh.write(buf); fh.flush()
    obs("fsize.error", "none")
except OSError as e:
    obs("fsize.error", errno.errorcode[e.errno])
os.unlink("/work/big")
n = 0
try:
    for n in range(1, 60001):
        open(f"/work/i{n}", "w").close()
    obs("inodes.error", "none")
except OSError as e:
    obs("inodes.error", errno.errorcode[e.errno])
obs("inodes.created", n)
try:
    with open("/dev/shm/fill", "wb") as fh:
        for i in range(5): fh.write(buf); fh.flush()
    obs("shm.error", "none")
except OSError as e:
    obs("shm.error", errno.errorcode[e.errno])
