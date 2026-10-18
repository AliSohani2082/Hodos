import sys, os, errno
def obs(k, v): print(f"OBS {k}={v}", flush=True)
import time
kids = []
try:
    for i in range(500):
        pid = os.fork()
        if pid == 0:
            time.sleep(30); os._exit(0)
        kids.append(pid)
    obs("fork.error", "none")
except OSError as e:
    obs("fork.error", errno.errorcode[e.errno])
obs("fork.children_started", len(kids))
for k in kids:
    try: os.kill(k, 9)
    except OSError: pass
