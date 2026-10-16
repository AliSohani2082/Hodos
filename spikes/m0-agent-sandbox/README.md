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

**Status.** Not started.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).
