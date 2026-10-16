import sys, os, errno
def obs(k, v): print(f"OBS {k}={v}", flush=True)
chunks = []
for i in range(1, 65):
    chunks.append(bytearray(b"\x01") * (16 << 20))   # touch every page: 16 MiB per step
    obs("mem.allocated_mib", 16 * i)
obs("mem.survived", True)
