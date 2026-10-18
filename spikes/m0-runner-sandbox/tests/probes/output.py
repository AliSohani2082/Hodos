import sys, os, errno
def obs(k, v): print(f"OBS {k}={v}", flush=True)
line = "A" * 1023 + "\n"
while True:
    sys.stdout.write(line); sys.stderr.write(line)
