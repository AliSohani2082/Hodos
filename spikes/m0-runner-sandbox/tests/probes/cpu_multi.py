import os, time, sys
def obs(k, v): print(f"OBS {k}={v}", flush=True)
t0 = time.monotonic()
kids = []
for _ in range(4):                       # 4 spinning processes for ~1.5 s wall: a 1-CPU cap must show ~1.5 CPU-seconds
    pid = os.fork()
    if pid == 0:
        while time.monotonic() - t0 < 1.5: pass
        os._exit(0)
    kids.append(pid)
for k in kids: os.waitpid(k, 0)
obs("cpu.wall_s", round(time.monotonic() - t0, 2))
