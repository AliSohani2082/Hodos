# Spike (a): lesson format reliability

**Question.** Does a current model write valid, schema-conformant, high-quality lessons in Markdoc at least as reliably as in remark-directive syntax, once a validate-and-repair loop is in place?

**Why it matters.** Markdoc is the *provisional* lesson IR (PRD LS-2, decision 8). Swapping it later costs only the parser and printer (PRD §15), but switching to directives would also change the exercise authoring shape (`lesson-ir.md` §9.10), so the lock should be tested before M1.

**Spec.** [`lesson-ir.md` §8](../../docs/research/lesson-ir.md): two arms that differ only in syntax, 36 tasks, the metrics M1–M7 and the pass/fail rules in §8.5. Fixtures and gold checklists live in this directory, so the run is reproducible.

**Budget.** About $7 for a pilot, then at most $150 for the full run ([§8.6](../../docs/research/lesson-ir.md)). **The full run needs explicit approval of the budget first.**

**Exit.** A written go/no-go on the Markdoc lock.

**Status.** Not started.

**Verdict.** ADR pending, see [`docs/adr/`](../../docs/adr/).
