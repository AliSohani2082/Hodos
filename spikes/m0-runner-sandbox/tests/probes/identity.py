import sys, os, errno
def obs(k, v): print(f"OBS {k}={v}", flush=True)
st = open("/proc/self/status").read()
def f(name): return st.split(name + ":")[1].split("\n")[0].strip().replace("\t", " ")
obs("uid", os.getuid()); obs("gid", os.getgid()); obs("groups", os.getgroups())
for k in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp"): obs(k, f(k))
obs("uid_map", " | ".join(open("/proc/self/uid_map").read().split("\n")[:2]).split())
obs("hostname", os.uname().nodename)
obs("environ_keys", sorted(os.environ))
for path in ("/", "/opt/ali40", "/etc", "/usr", "/tmp", "/work", "/dev/shm", "/run"):
    try:
        open(os.path.join(path, "ali40-probe"), "w").close(); os.unlink(os.path.join(path, "ali40-probe")); r = "writable"
    except OSError as e: r = errno.errorcode[e.errno]
    obs("write." + path, r)
obs("mounts", sorted({l.split()[4] for l in open("/proc/self/mountinfo")}))
obs("visible_pids", sorted(int(p) for p in os.listdir("/proc") if p.isdigit()))
for sock in ("/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock", "/run/user/1000/podman/podman.sock", "/run/containerd/containerd.sock", "/var/run/crio/crio.sock"):
    obs("exists." + sock, os.path.exists(sock))
