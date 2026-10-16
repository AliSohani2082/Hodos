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

**Status.** In progress (handed off mid-spike, see below). Built and unit-checked: MCP server with per-job tokens (`src/mcp/`, self-test passes), egress proxy (`src/proxy/`), canary/mock listeners (`src/canary/`), sandbox image (`sandbox/Containerfile`, built), sandbox profile (`scripts/lib.sh`), ACP client (`src/client/`). Not yet run end to end: the sandbox profile, the proxy, the escape tests, any real LLM turn. No provider keys were available (coordinator: "mock only"), so injection can only be shown against the mock upstream until a spend-capped key is supplied.

**Layout (WIP).**

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

**Run (once the remaining work is done).** `npm install`; `podman build -t localhost/ali39-agent:dev -f sandbox/Containerfile sandbox` (without proxy env); `./scripts/up.sh`; `node src/client/acp-client.ts --harness claude --job j1 --checkout $PWD/work/checkouts/j1 --prompt "..."`; `./scripts/down.sh`. Provider keys go in an untracked `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), read only by the proxy container. See the handoff notes in the Linear comments on ALI-39 for the open items.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).
