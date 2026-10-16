# Spike (c): agent CLI inside the job sandbox

**Question.** Does the round trip work end to end: ACP client → Claude Code / Codex **inside an agent-job sandbox** → egress proxy → our MCP server?

**Why it matters.** AI-7 and TM-001 (critical): every lane-1 job runs in its own container, with default-deny egress and no app secrets. See [PRD](../../docs/PRD.md) AI-7, §9.4 and the [threat model](../../docs/hodos-threat-model.md).

**Exit criteria** (from the PRD's M0 row). From inside the sandbox the agent:

- cannot read app secrets,
- cannot reach Postgres, the runner API or the LAN,
- cannot reach any host except the LLM API and MCP.

And:

- the provider key is injected at the proxy, or the fallback (a dedicated, spend-capped key in the sandbox) is documented,
- each CLI's flags for disabling project and user config discovery are recorded.

A CLI that can't run under AI-7 is not supported on multi-account instances (PRD §15).

**Safety.** This spike runs agents against a sandbox you are trying to escape from. Run it in a disposable VM or container host, and use a spend-capped API key.

**Status.** Spike complete. Both ACP harnesses completed mock-backed turns inside the rootless agent-job container. Claude completed an MCP tool call through the proxy and ran the scripted escape probe; Codex completed a turn but the mock did not result in an ACP tool call, so its escape probe was run directly in the same job profile. Egress denials, config-discovery controls, positive controls, and the gVisor limitation are recorded in `results/`. No real provider keys were available; real provider turns remain untested. See [ADR-0003](../../docs/adr/0003-agent-sandbox-egress.md) for separate per-harness verdicts and limits.

**Layout.**

| Path | What |
|---|---|
| `sandbox/Containerfile` | agent-job image: node:24-slim + claude-agent-acp 0.91.0, codex-acp 2.2.2, claude-code 2.1.301, codex 0.160.1 |
| `scripts/lib.sh` | networks (`ali39-agent` internal, `ali39-app`), app-side containers, the agent-job profile (`sandbox_args`) |
| `scripts/sandbox-exec.sh` | exec any command inside the profile; stdio passes through (ACP crosses the boundary) |
| `scripts/up.sh`, `scripts/down.sh` | start / remove everything prefixed `ali39-` |
| `src/mcp/server.ts`, `selftest.ts` | ALI-57: MCP server, admin token API, acceptance self-test |
| `src/proxy/egress-proxy.ts` | ALI-56: default-deny proxy, key-injecting gateway routes, optional CONNECT allowlist, upstream chaining |
| `src/client/` | ALI-54: `acp-client.ts`, `harnesses.ts`, `policy.ts`, `handshake.ts` |
| `policies/` | permission policies (`readonly-plus-mcp`, `allow-all`, `deny-all`) |
| `CONFIG-DISCOVERY.md`, `fixtures/config-plant/`, `scripts/config-test.sh` | ALI-58: tested Claude/Codex config isolation and positive controls; Gemini/OpenCode docs-only table |
| `fixtures/escape-probe.sh`, `scripts/escape-tests.sh` | ALI-59: repeatable canary, network, proxy and positive-control probes |
| `results/` | Recorded test outputs, proxy/MCP audit evidence, and runtime facts |

**Run.** From this directory, install pinned npm dependencies and build the image if it is not already present. Then run `./scripts/up.sh`, `./scripts/proxy-test.sh`, `./scripts/config-test.sh`, and `./scripts/escape-tests.sh`; finish with `./scripts/down.sh`. The tests use local mock upstreams and generated canaries only. To test with providers later, put dedicated spend-capped keys in an untracked `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`); only the proxy container receives them.

**Decision.** Go with changes for Claude Code and Codex, subject to the limits and follow-ups in [ADR-0003](../../docs/adr/0003-agent-sandbox-egress.md). The baseline uses rootless Podman with crun; the host's rootless gVisor trial could not configure cgroups.
