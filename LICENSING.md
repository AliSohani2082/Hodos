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
- **Each package carries its own license.** Every package directory has a `LICENSE` file, listed in its `package.json` `files`: a copy of [`LICENSE-MIT`](LICENSE-MIT) for the MIT packages (with `"license": "MIT"`), a copy of [`LICENSE`](LICENSE) for the AGPL ones (`@hodos/core`, `@hodos/dsh`, `@hodos/ui`). That keeps the license visible in every tarball, including the copies bundled inside the `pnpm pack:dsh` tarballs.
- **MIT code must not depend on AGPL code.** The AGPL core may depend on the MIT packages. The reverse would make the SDK effectively AGPL.
- **SPDX identifiers.** Use `AGPL-3.0-only` for core packages and `MIT` for the MIT ones. The PRD says "AGPL-3.0" without "or later", so `-only` is the literal reading. Switching to `AGPL-3.0-or-later` is a one-line change per package while the project has a single copyright holder, and much harder later.
- **Spikes are throwaway.** Code under [`spikes/`](spikes/) is AGPL like the rest of the repo by default and is not published. Findings go into an [ADR](docs/adr/).

## Third-party code shipped in the builds

| Code | Where | License | Notice |
|---|---|---|---|
| [Pyodide](https://github.com/pyodide/pyodide) 0.29.4, with CPython | The `@hodos/code` sandbox renderer (`renderer/dist/pyodide/`), copied unmodified from the `pyodide` npm package at build time | MPL-2.0; CPython under the PSF License | `renderer/dist/THIRD-PARTY-NOTICES.txt` |
| [KaTeX](https://katex.org) 0.16.47 | The workspace app (`@hodos/ui` `dist/`, and its copy in the `@hodos/dsh` tarball): bundled script, stylesheet and fonts | MIT | `dist/katex.LICENSE.txt` |
| [chess.js](https://github.com/jhlywa/chess.js) 1.4.0 | `@hodos/chess`, as an npm dependency | BSD-2-Clause | its package |

Pyodide's files are unmodified, so the MPL-2.0 obligation is to keep them available under the MPL with their source location, which the notice gives. The workspace bundle also lists the licence comments of everything it inlines in `app.js.LEGAL.txt`.

## Copyright

Copyright (c) 2026 Hodos contributors. The MIT text uses that holder name. Replace it with a named holder or entity if you want one before the first release.
