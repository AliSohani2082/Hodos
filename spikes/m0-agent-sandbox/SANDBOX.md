# Agent-job profile (ALI-55)

`scripts/sandbox-exec.sh` is the single launcher. It mounts one throwaway
checkout at `/workspace`, starts as uid/gid 10001 with all Linux capabilities
dropped and `no-new-privileges`, uses a read-only image root, and gives the job
temporary `/tmp` and `/home/agent` filesystems. The job joins only the
`ali39-agent` internal network. `--http-proxy=false` prevents Podman from
copying the host's proxy environment into the job. The default 1 CPU, 1 GiB
memory, 256 processes, and 900-second job time limit are Podman arguments;
the ACP client has a separate wall-clock watchdog.

Run `./scripts/up.sh && ./scripts/profile-test.sh`. The recorded output in
`results/ali55-profile.txt` confirms the cgroup limits (`cpu.max=100000
100000`, `memory.max=1073741824`, `pids.max=256`), uid 10001, zero effective
capabilities, `NoNewPrivs=1`, no default route, no external DNS resolution,
a writable checkout, and no visible app secret, other checkout, or host
container socket. A 10-second sleep was terminated by a 2-second job timeout
with exit 255. `ACP.md` records two mock-backed ACP prompt turns across this
container boundary.

The approved user-level gVisor trial is recorded in
`results/ali55-gvisor.txt`. Its published SHA512 checksum matched, but rootless
Podman could not set up runsc's cgroup under this workstation's delegation.
The measured sandbox baseline therefore uses rootless Podman with crun 1.30.1.
