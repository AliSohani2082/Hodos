# Spikes

Throwaway code for the five M0 spikes in [PRD §14](../docs/PRD.md#14-roadmap) (milestone table, row **M0: spikes**). Each spike answers one go/no-go question. The code here is disposable. The written verdict is the deliverable, and it goes into an [ADR](../docs/adr/).

| | Directory | Question | Exit |
|---|---|---|---|
| (a) | [`m0-lesson-format/`](m0-lesson-format/) | Is Markdoc at least as reliable for LLM-written lessons as remark-directive? | Verdict on the provisional Markdoc lock |
| (b) | [`m0-cordis-plugin-worker/`](m0-cordis-plugin-worker/) | Does cordis run on Bun, and where should non-first-party plugin hooks run? | Verdict on cordis and on the plugin-worker design |
| (c) | [`m0-agent-sandbox/`](m0-agent-sandbox/) | Can an agent CLI run inside the job sandbox and still reach our MCP server? | Verdict per CLI, with its isolation flags recorded |
| (d) | [`m0-runner-sandbox/`](m0-runner-sandbox/) | Can the runner execute learner code with hidden tests out of its reach? | Verdict on the runner isolation design |
| (e) | [`m0-mastery-sim/`](m0-mastery-sim/) | Do BKT-lite and FSRS behave as the PRD assumes in simulation? | Verdict on both models and their default parameters |

## Conventions

- **One directory per spike**, named `m0-<topic>`. Each has a `README.md` with the question, the exit criteria, how to run it and a link to its ADR once written.
- **Self-contained.** There is no shared root workspace or toolchain. A spike brings its own `package.json`, `pyproject.toml` or `compose.yaml`, so that they can use different languages and don't collide with the app scaffold that arrives in M1.
- **Reproducible.** Commit fixtures, prompts, configs and scripts. Don't commit secrets, API keys or large generated output. Put credentials in an untracked `.env` and document the variables in the spike's README.
- **Safe to run.** Spikes that execute untrusted code (c, d) must document how to run them without exposing the host. Spike (a) spends real API money and needs an explicit budget approval before the full run.
- **Not production code.** Nothing in `spikes/` is imported by the app. If a spike produces something worth keeping, move it deliberately in a later milestone.
- **Record the verdict.** When a spike is done, copy [`docs/adr/0000-template.md`](../docs/adr/0000-template.md), write the verdict and link the evidence here.
