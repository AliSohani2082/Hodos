# Architecture decision records

An ADR is a short, dated record of one decision and the evidence behind it. The [PRD](../PRD.md) says what Hodos should do. ADRs record the choices made while building it, starting with the go/no-go verdicts from the [M0 spikes](../../spikes/).

## Writing one

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-kebab-title.md`, using the next unused four-digit number.
2. Fill it in. Keep it to what a future reader needs: the question, the verdict, the evidence and the consequences.
3. Add a row to the index below.
4. If the decision changes the PRD, edit the PRD in the same change and name the sections in the ADR's **Amends** row.

ADRs are not edited after they are accepted, except to fix typos or to set the status to *Superseded by ADR-NNNN*. To change a decision, write a new ADR.

## Index

| ADR | Title | Status | Spike |
|---|---|---|---|
| [0001](0001-markdoc-lesson-ir.md) | Markdoc as the lesson IR | Proposed — inconclusive | M0 (a), [ALI-37](https://linear.app/ali-inc/issue/ALI-37) |
| [0002](0002-cordis-on-bun-and-plugin-worker-isolation.md) | cordis on Bun and non-first-party plugin workers | Accepted | M0 (b), [ALI-38](https://linear.app/ali-inc/issue/ALI-38) |
| [0003](0003-agent-sandbox-egress.md) | Agent-job sandbox and egress boundary | Accepted | M0 (c), [ALI-39](https://linear.app/ali-inc/issue/ALI-39) |
| [0004](0004-runner-sandbox-and-grader-isolation.md) | Runner sandbox and isolated hidden-test grader | Accepted | M0 (d), [ALI-40](https://linear.app/ali-inc/issue/ALI-40) |
| [0005](0005-bkt-lite-and-fsrs-defaults.md) | BKT-lite mastery gate and FSRS defaults | Accepted | M0 (e), [ALI-41](https://linear.app/ali-inc/issue/ALI-41) |
| [0006](0006-hodos-as-dsh-plugin-ecosystem.md) | Hodos as a DeepSeek Harness plugin ecosystem | Accepted | Host-integration spike (DSH 0.2.1-rc.3) |
| [0007](0007-learning-harness-on-dsh.md) | Hodos as a learning harness for any topic, on DeepSeek Harness | Accepted; partly settled by 0008 | — |
| [0008](0008-learning-session-mechanics.md) | How learning sessions run on DeepSeek Harness | Accepted | — |
