# Spike (b): cordis on Bun, and the plugin worker

**Questions.**

1. Does cordis run cleanly on Bun? Its README says the API is unstable and it is built for Node (PRD §15). The fallback is Node for the plugin host.
2. Where should the server-side hooks of non-first-party plugins run (`apply()`, `validate`, `validateItem`, non-code `grade`, `fallback.text`, `migrate`)? Compare a JS isolate (workerd, isolated-vm or QuickJS-wasm) against a plain worker process, by running a plugin's `validate` and `grade` in each.

**Why it matters.** TM-003 requires that these hooks run with no database, no secrets and no network, over JSON-in/JSON-out RPC with CPU and time limits (see the "Plugin worker" paragraph in [PRD §8](../../docs/PRD.md) and the [threat model](../../docs/hodos-threat-model.md)). cordis stays behind a thin adapter either way.

**Exit.** A written go/no-go on cordis-on-Bun and on the plugin-worker design.

**Status.** Not started.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).
