# Spike (d): runner sandbox for learner code

**Question.** Can the runner execute a learner's code in a sandbox while the hidden tests run in a separate process and uid, so that the learner's code can't read or tamper with them?

**Why it matters.** EX-5b: the reference solution never enters the learner's sandbox, hidden tests run in a separate process under a different uid, and results come back through a channel learner code can't write. TM-007 is the threat if this fails: students read hidden tests or tamper with the autograder, and mastery gates can be gamed. See [PRD](../../docs/PRD.md) EX-5b, §9.4 (the **learner-code** isolation zone) and the [threat model](../../docs/hodos-threat-model.md).

**Exit.** A written go/no-go on the runner isolation design, recording the sandbox profile that was tested (gVisor or rootless, resource limits, no network by default) against the §9.4 learner-code zone.

**Safety.** This spike runs deliberately hostile code. Use a disposable VM or container host.

**Status.** Not started.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).
