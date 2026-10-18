# Spikes

Throwaway code for the five M0 spikes in [PRD §14](../docs/PRD.md#14-roadmap) (milestone table, row **M0: spikes**). Each spike answers one go/no-go question. The code here is disposable. The written verdict is the deliverable, and it goes into an [ADR](../docs/adr/).

| | Directory | Question | Exit |
|---|---|---|---|
| (a) | [`m0-lesson-format/`](m0-lesson-format/) | Is Markdoc at least as reliable for LLM-written lessons as remark-directive? | Verdict on the provisional Markdoc lock |
| (b) | [`m0-cordis-plugin-worker/`](m0-cordis-plugin-worker/) | Does cordis run on Bun, and where should non-first-party plugin hooks run? | Verdict on cordis and on the plugin-worker design |
| (c) | [`m0-agent-sandbox/`](m0-agent-sandbox/) | Can an agent CLI run inside the job sandbox and still reach our MCP server? | Verdict per CLI, with its isolation flags recorded |
| (d) | [`m0-runner-sandbox/`](m0-runner-sandbox/) | Can the runner execute learner code with hidden tests out of its reach? | Verdict on the runner isolation design |
| (e) | [`m0-mastery-sim/`](m0-mastery-sim/) | Do BKT-lite and FSRS behave as the PRD assumes in simulation? | Verdict on both models and their default parameters |

## Verdicts (M0 exit review, [ALI-42](https://linear.app/ali-inc/issue/ALI-42))

| | Verdict | ADR | Notes |
|---|---|---|---|
| (a) | **Inconclusive — deferred** | [ADR-0001](../docs/adr/0001-markdoc-lesson-ir.md) | Only a reduced funded run (117/120 cells, Opus + Sonnet, 1 sample); Q1/Q2 not judged. LS-2 stays provisional; the full go/no-go is [ALI-49](https://linear.app/ali-inc/issue/ALI-49). |
| (b) | **Go with changes** | [ADR-0002](../docs/adr/0002-cordis-on-bun-and-plugin-worker-isolation.md) | Bun + `cordis@4.0.0-rc.11` behind an internal adapter; non-first-party hooks in QuickJS-wasm inside an OS-confined Bun worker. |
| (c) | **Go with changes** (Claude Code, Codex; mock-backed) | [ADR-0003](../docs/adr/0003-agent-sandbox-egress.md) | Rootless crun, egress-proxy-only network, key injection at the proxy. Real-model escape tests required before multi-account production; Gemini CLI / OpenCode not yet supported. |
| (d) | **Go with changes** | [ADR-0004](../docs/adr/0004-runner-sandbox-and-grader-isolation.md) | Rootless podman + crun; tier-1 preferred; 32/32 adversarial submissions contained. Tier-2 grader moves to its own container in production. |
| (e) | **Go with changes** | [ADR-0005](../docs/adr/0005-bkt-lite-and-fsrs-defaults.md) | θ=0.95 with ≥3 unassisted distinct checkpoint successes and a first-miss rule; FSRS-6 at R=0.90 with a precise lapse definition. |

## Conventions

- **One directory per spike**, named `m0-<topic>`. Each has a `README.md` with the question, the exit criteria, how to run it and a link to its ADR once written.
- **Self-contained.** There is no shared root workspace or toolchain. A spike brings its own `package.json`, `pyproject.toml` or `compose.yaml`, so that they can use different languages and don't collide with the app scaffold that arrives in M1.
- **Reproducible.** Commit fixtures, prompts, configs and scripts. Don't commit secrets, API keys or large generated output. Put credentials in an untracked `.env` and document the variables in the spike's README.
- **Safe to run.** Spikes that execute untrusted code (c, d) must document how to run them without exposing the host. Spike (a) spends real API money and needs an explicit budget approval before the full run.
- **Not production code.** Nothing in `spikes/` is imported by the app. If a spike produces something worth keeping, move it deliberately in a later milestone.
- **Record the verdict.** When a spike is done, copy [`docs/adr/0000-template.md`](../docs/adr/0000-template.md), write the verdict and link the evidence here.
