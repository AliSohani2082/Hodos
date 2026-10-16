"""Fixed sandbox profiles (PRD §9.4, DP-3). Callers pick a profile *name*; everything below is
decided here and cannot be influenced by a request: image, mounts, network, caps, limits."""
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
IMAGE_TAG = "localhost/ali40-learner-py:1"
ALLOWLIST_FILE = HERE.parent / "image" / "IMAGE_ID"  # written by scripts/build-image.sh

# Only learner-code is implemented in this spike; the other §9.4 zones are listed so that a
# request for them is *rejected by policy* rather than by accident.
IMPLEMENTED_PROFILES = {"learner-code"}
KNOWN_PROFILES = {"app", "agent-job", "fetcher", "plugin-worker", "learner-code", "materializer"}

LEARNER_CODE = {
    "memory": "256m",       # cgroup memory.max (== memory.swap.max: no swap)
    "pids": 64,             # cgroup pids.max: supervisor + grader + learner + all descendants
    "cpus": "1",            # cgroup cpu.max
    "work_tmpfs": "16m",    # the ONLY writable path: this is the disk cap
    "shm": "1m",
    "nofile": 256,
    "case_s": 2.0,          # wall time for one learner program run / one grader call
    "out_bytes": 32 * 1024, # per-stream capture cap; the kernel pipe is drained, the rest dropped
    "frame_cap": 2 * 1024 * 1024,   # the runner never reads more than this from the container's stdout
    "startup_s": 8.0,       # allowance for container create/start before the job clock matters
}


def allowed_image_ids():
    try:
        return {ln.strip() for ln in ALLOWLIST_FILE.read_text().split() if ln.strip()}
    except OSError:
        return set()


def resolve_image():
    """Resolve the profile's image to an ID and require it to be on the allowlist. The container
    is then started by ID, never by tag, so a retag cannot swap the image under us."""
    out = subprocess.run(["podman", "image", "inspect", IMAGE_TAG, "--format", "{{.Id}}"],
                         capture_output=True, text=True, timeout=20)
    image_id = out.stdout.strip()
    if out.returncode != 0 or image_id not in allowed_image_ids():
        raise PermissionError(f"image {IMAGE_TAG} id={image_id!r} is not on the allowlist")
    return image_id


def podman_argv(name, image_id, wall_s, profile=LEARNER_CODE):
    """The complete, fixed `podman run` command line for the learner-code profile."""
    p = profile
    return [
        "podman", "run", "--rm", "-i", "--name", name, "--label", "ali40=1", "--pull", "never",
        "--network", "none",                                  # TM-013: no network at all
        "--read-only", "--read-only-tmpfs=false",             # immutable rootfs, no implicit tmpfs
        "--tmpfs", f"/work:rw,size={p['work_tmpfs']},mode=1777,noexec,nosuid,nodev",
        "--shm-size", p["shm"],
        "--cap-drop", "all", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP", "--cap-add", "KILL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", str(p["pids"]),
        "--memory", p["memory"], "--memory-swap", p["memory"], "--cpus", p["cpus"],
        "--ulimit", f"nofile={p['nofile']}:{p['nofile']}", "--ulimit", "core=0",
        "--log-driver", "none",                               # no host-side copy of a flooded stream
        "--hostname", "ali40-sandbox", "--no-hosts",
        "--timeout", str(int(wall_s) + 5),                    # podman-side backstop to our own kill
        image_id, "/usr/local/bin/python3", "-I", "-B", "/opt/ali40/sandbox_init.py",
    ]
