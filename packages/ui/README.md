# @hodos/ui

The Hodos workspace: a React single-page app with two views.

- **The session panel** (the "Hodos learning" tab): the plan map with where the lesson stands, the open question with its answer form and an optional think-out-loud field, answered questions with their verdict and reveal, the mastery estimates, and practice problems. Outside a session it lists your sessions, nodes due for review, and draft courses waiting for approval.
- **The knowledge graph** (the "Knowledge graph" tab): propositions and chains as a force-directed graph grouped by source, a list view, notes import, deletion, and picking propositions to practise.

Math is typeset with [KaTeX](https://katex.org) (MIT), each formula rendered into its own element with `trust: false`. It talks only to the Hodos API of its host. Plugin renderers run inside it in sandboxed iframes and reach it only through a validated message channel.

`pnpm build` writes the app to `dist/`. [`@hodos/dsh`](../dsh-adapter/README.md) serves it at `/hodos/app/` under a strict Content Security Policy and shows it in DeepSeek Harness's sidebar; the DSH tarball carries a copy as `app/`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
