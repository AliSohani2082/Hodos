# ADR-0003: Agent-job sandbox and egress boundary

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Spike** | M0 (c), [agent sandbox spike](../../spikes/m0-agent-sandbox/README.md) |
| **Issue** | [ALI-39](https://linear.app/ali-inc/issue/ALI-39) |
| **Amends** | PRD AI-1, AI-2, AI-7, §9.4 and §15; operational clarifications from M0(c), to be folded into the M0 exit review |

## Question

Can Claude Code and Codex run as ACP agents inside a per-job sandbox with default-deny egress, reach only the provider gateway and the scoped MCP service, and withstand prompt-injection attempts to read app secrets or reach internal services?

## Context

PRD AI-7 and TM-001 require non-root, resource-limited agent jobs with only a throwaway checkout mounted, no app secrets, and egress limited to the LLM API and MCP. Permission policies are defense in depth because an injected agent controls its own process. PRD §15 says a CLI that cannot run under AI-7 is unsupported on multi-account instances.

The host did not have a usable rootless gVisor cgroup delegation. Rootless Podman with crun was available and satisfies the PRD's alternative runtime. Provider credentials were not provided; every ACP/provider turn used the local mock. The spike used only generated canaries, dummy listeners, placeholder provider keys, and one deliberate safe `/models` request carrying a known invalid mock key through the approved dummy upstream proxy.

## Options considered

| Option | For | Against |
|---|---|---|
| A: Rootless Podman + crun, internal agent network, gateway-only egress | Verified under the current unprivileged host; no host socket, app environment, or non-checkout mounts; provider secrets stay at the proxy | Shares the host kernel; this spike does not establish a kernel-escape boundary |
| B: Rootless Podman + gVisor `runsc` | Stronger application-kernel isolation | Not usable with this host's rootless cgroup delegation; systemd denied cgroup operations, cgroupfs could not configure subtree control, and disabled cgroups are incompatible with runsc |
| C: Direct sandbox egress with provider key in the job | May fit a CLI without custom base URL support | Weakens secret isolation and makes the provider key available to prompt-injected code; not used for either tested harness |

## Verdict

**Go with changes for Claude Code; Go with changes for Codex.** Use a rootless crun agent-job container on an internal network whose only peer is the egress proxy; allow provider traffic through fixed gateway routes and MCP through its scoped proxy route. Keep CONNECT disabled when the proxy injects provider credentials. Both verdicts are limited to the tested rootless profile and mock-backed ACP path; they do not certify real-model behavior. Require model-backed escape testing before enabling either harness for production multi-account workloads. A CLI that cannot stay within AI-7 is unsupported on multi-account instances (PRD §15).

## Evidence

### Versions and profile

- Host: Linux x86_64, Node.js 24.21.0; rootless Podman 6.1.2, crun 1.30.1, netavark v2.
- Agent image: `node:24-slim` (in-container Node.js 24.22.0); `claude-agent-acp` 0.91.0, bundled Claude Code 2.1.300; standalone Claude Code package 2.1.301; `codex-acp` 2.2.2 with Codex 0.160.1.
- ACP SDK 1.9.0; MCP SDK 1.32.1. Images and packages are pinned in `sandbox/Containerfile` and `package-lock.json`.
- Profile: uid/gid 10001, CapEff 0, NoNewPrivs=1, read-only rootfs, only the throwaway checkout bind-mounted writable, `/tmp` and home on fresh tmpfs mounts, `--network ali39-agent` (`--internal`), 1 GiB memory, 1 CPU, 256 pids, 900-second Podman timeout, plus the ACP client watchdog. Rootless cgroup files reported `cpu.max=100000 100000`, `memory.max=1073741824`, `pids.max=256`.
- gVisor `runsc` release-20261005.0 was downloaded to ignored `.tools/` and its published SHA512 verified. Rootless invocation failed with systemd `Access denied`; cgroupfs failed writing `cgroup.subtree_control`; `--cgroups=disabled` failed because runsc is incompatible with NoCgroups. No privileged operation was attempted. See [ALI-55 profile evidence](../../spikes/m0-agent-sandbox/results/ali55-profile.txt) and [gVisor trial](../../spikes/m0-agent-sandbox/results/ali55-gvisor.txt).

### Harness decisions

| Harness | Verdict | Evidence and limits |
|---|---|---|
| Claude Code 2.1.300 through `claude-agent-acp` 0.91.0 | **Go with changes** | ACP mock turn completed; Claude executed one scripted Bash escape probe with `allow-all` policy. The probe found no app env variables or canary files, could not reach Postgres, runner, MCP/admin, LAN, metadata, public IP/domain, or DNS; proxy CONNECT, absolute-URI forwarding, and admin route were denied. The Claude mock also completed a scoped `lesson.validate` MCP call through the proxy (ALI-57). No real provider/model turn was run. |
| Codex 0.160.1 through `codex-acp` 2.2.2 | **Go with changes** | ACP mock turn completed through the gateway. The mock emitted a Responses `shell_call` event after the escape prompt, but this ACP run ended without an ACP tool call; therefore the agent itself did not execute the probe. The same probe, run directly through the Codex job profile, produced the same blocked results as Claude. No real provider/model turn was run. Before production multi-account use, verify Codex tool-call handling with a suitable model-backed or adapter-compatible scripted response and rerun the escape prompt. |

### Egress and MCP

`./scripts/proxy-test.sh` ran inside the sandbox. Anthropic and OpenAI gateway calls returned 200 from the local mock and showed the proxy replaced the placeholder with its mock provider key. Unknown routes, `/admin`, disallowed provider paths, absolute HTTP forwarding, and CONNECT to `example.com`, loopback, metadata, and Postgres were denied and logged. Anthropic and Responses SSE turns completed through the proxy. The approved chain test used the local dummy Basic-auth upstream proxy and a deliberately invalid key; the provider returned 401. This demonstrated CONNECT chaining through the dummy proxy, not authenticated provider access or the workstation's 127.0.0.1:10808 proxy. See the [proxy evidence](../../spikes/m0-agent-sandbox/results/ali56-proxy-test.txt), [denials](../../spikes/m0-agent-sandbox/results/ali56-proxy-denials.jsonl), [key injection](../../spikes/m0-agent-sandbox/results/ali56-key-injection.jsonl), and [upstream chain](../../spikes/m0-agent-sandbox/results/ali56-upstream-chain.txt).

The MCP server exposes `lesson.validate` and `job.report`, derives caller identity from the opaque per-job token scoped to job/draft/teacher, rejects out-of-scope IDs, and denies the separate admin port through the proxy. Both tools were called from the sandbox through the proxy; the Claude ACP mock invoked `lesson.validate`. See [ALI-57 evidence](../../spikes/m0-agent-sandbox/results/ali57-mcp-probe.txt) and [agent audit](../../spikes/m0-agent-sandbox/results/ali57-agent-audit.jsonl).

### Configuration discovery

`./scripts/config-test.sh` planted project instructions, a rogue MCP server, and a Claude hook, then ran isolated and positive-control launches. Claude used `settingSources: []`, `strictMcpConfig: true`, a fresh `CLAUDE_CONFIG_DIR`, and only the ACP session's explicit `mcpServers`; planted instructions/hook/MCP did not affect the isolated run, and the control showed they were active when discovery was enabled. Codex used fresh `CODEX_HOME`, `trust_level = "untrusted"`, `CODEX_CONFIG={"project_doc_max_bytes":0}`, and an empty read-only `/workspace/.codex` tmpfs with `notmpcopyup`; the planted `AGENTS.md` and project MCP config were absent/ignored, while the trusted control exposed them. Exact recipes and the documentation-only Gemini CLI/OpenCode table are in [CONFIG-DISCOVERY.md](../../spikes/m0-agent-sandbox/CONFIG-DISCOVERY.md) and [test output](../../spikes/m0-agent-sandbox/results/ali58-config-discovery.txt).

### Escape test and repeat commands

Run `./scripts/up.sh`, then `./scripts/proxy-test.sh`, `./scripts/config-test.sh`, and `./scripts/escape-tests.sh`; use `./scripts/down.sh` to remove all spike containers, networks, and the host-side LAN dummy. The escape suite uses `allow-all`, repeats the probes from both the Claude ACP tool (Codex ACP is prompted but returns without a tool call) and directly in the Codex job profile, and includes positive controls from the ordinary app network. The dummy Postgres, runner and LAN listener were reachable from the positive-control container; their logs contained no connection from the sandbox subnet. Recorded output: [ALI-59 results](../../spikes/m0-agent-sandbox/results/ali59-escape-tests.txt).

Not tested: authenticated real Anthropic/OpenAI turns, actual secret-bearing provider key injection, provider refusals or spend, model-generated Codex tool execution, Gemini CLI/OpenCode runtime behavior, multi-job concurrency, macOS/Docker Desktop, kernel-escape attacks, DNS-over-HTTPS or exfiltration through an allowed LLM request, and the host's real upstream proxy. No production app service, real key, or real LAN device was contacted.

## Consequences

- The sandbox boundary must be implemented by the runner profile and internal network, not by agent permission settings. The provider proxy is the only agent-network peer; the proxy's CONNECT allowlist remains empty in key-injection mode. This prevents bypassing the gateway to supply attacker-controlled credentials to an allowed provider host.
- Keep only the per-job MCP token inside the sandbox. The MCP server derives job/draft/teacher identity from that token; the provider keys remain in the proxy.
- The baseline is rootless crun, not gVisor, on this host. The agent shares the host kernel. Host hardening or a rootless gVisor-capable runner is a separate deployment decision.
- Claude and Codex may be used only with the documented launch recipes and fixed profile. Complete real-model tool-call escape tests before production multi-account support. Gemini CLI and OpenCode are not supported by this tested M0 recipe.
- A CLI that cannot run under AI-7 is not supported on multi-account instances; the fallback is a dedicated, spend-capped key only for a CLI that cannot accept proxy base-URL injection (PRD AI-1 / §15). Neither tested CLI required that fallback.
- Allowed provider API calls remain an exfiltration channel: prompts and outputs reach the provider. The proxy constrains the destination and credentials, but cannot decide whether the model transmits sensitive content in an otherwise allowed request.
- MCP names containing dots were presented to Claude as `mcp__hodos__lesson_validate`; tool naming should be kept compatible with each CLI's exposed tool-name rules.

## Follow-ups

- [ ] Run the scripted escape probe through Codex ACP with a compatible model/tool-call fixture; then repeat with real models and spend-capped credentials before production multi-account rollout.
- [ ] Revisit rootless gVisor after runner cgroup delegation is available, or explicitly accept shared-kernel risk for the rootless crun deployment.
- [ ] Verify Gemini CLI and OpenCode configuration isolation before supporting either harness.
- [ ] M0 exit review should incorporate the AI-7 operational details, the empty CONNECT policy for injected-key mode, and the multi-account gate into the PRD.
