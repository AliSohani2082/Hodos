# Hodos

A self-hostable, open-source platform where a teacher steers any AI coding agent to build a course, approves it like a pull request, and students learn from it with a mastery model the platform guarantees.

**Status:** pre-code. M0 (the five spikes) has concluded and its ADRs are indexed. The Markdoc lesson-IR decision (ADR 0001) remains open, and M1 is next.

## Where things are

| Path | What it holds |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements, roadmap and decision log |
| [`docs/hodos-threat-model.md`](docs/hodos-threat-model.md) | Threat model of the PRD design (TM-001 to TM-017) |
| [`docs/research/`](docs/research/) | The three research reports behind the PRD, and the diagnostic simulation scripts |
| [`docs/adr/`](docs/adr/) | Architecture decision records, with a [template](docs/adr/0000-template.md) |
| [`spikes/`](spikes/) | Throwaway code for the five M0 spikes |

Start with the PRD summary (§1), then the roadmap (§14).

## Licensing

The core is AGPL-3.0 ([`LICENSE`](LICENSE)). The plugin SDK, contracts and reference plugins are MIT ([`LICENSE-MIT`](LICENSE-MIT)). See [`LICENSING.md`](LICENSING.md) for the rules.
