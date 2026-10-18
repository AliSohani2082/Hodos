# Licensing

Hodos is dual-licensed by component, as decided in the PRD (header, and decision 20 in [Appendix A](docs/PRD.md#appendix-a-decision-log)).

| Component | License | Text |
|---|---|---|
| Core: server, web app, runner, Course Studio, and everything not listed below | AGPL-3.0 | [`LICENSE`](LICENSE) |
| Plugin SDK (`@hodos/plugin-sdk`) | MIT | [`LICENSE-MIT`](LICENSE-MIT) |
| Contracts (plugin manifest, exercise contract and the JSON Schemas that go with them) | MIT | [`LICENSE-MIT`](LICENSE-MIT) |
| Reference plugins | MIT | [`LICENSE-MIT`](LICENSE-MIT) |

The MIT components exist so that third parties can write plugins without taking on AGPL obligations. The core stays AGPL so that anyone running a modified Hodos as a network service has to share their changes.

## Rules for contributors

- **Default is AGPL-3.0.** A file or package is AGPL unless it sits in one of the MIT components above.
- **Each MIT package carries its own license.** When the SDK, contracts and reference plugins are created (M1), each package directory gets a copy of [`LICENSE-MIT`](LICENSE-MIT) named `LICENSE`, and `"license": "MIT"` in its `package.json`. That keeps the license visible when the package is published to npm on its own.
- **MIT code must not depend on AGPL code.** The AGPL core may depend on the MIT packages. The reverse would make the SDK effectively AGPL.
- **SPDX identifiers.** Use `AGPL-3.0-only` for core packages and `MIT` for the MIT ones. The PRD says "AGPL-3.0" without "or later", so `-only` is the literal reading. Switching to `AGPL-3.0-or-later` is a one-line change per package while the project has a single copyright holder, and much harder later.
- **Spikes are throwaway.** Code under [`spikes/`](spikes/) is AGPL like the rest of the repo by default and is not published. Findings go into an [ADR](docs/adr/).

## Copyright

Copyright (c) 2026 Hodos contributors. The MIT text uses that holder name. Replace it with a named holder or entity if you want one before the first release.
