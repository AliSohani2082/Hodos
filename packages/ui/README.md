# @hodos/ui

The Hodos learning workspace: a React single-page app with a tutor pane (lessons, the path, controls), an environment pane (the exercise) and a path footer, with the current mode always shown. It talks only to the Hodos API of its host. Environment renderers run inside it in sandboxed iframes and reach it only through a validated message channel.

`pnpm build` writes the app to `dist/`. [`@hodos/dsh`](../dsh-adapter/README.md) serves it at `/hodos/app/` under a strict Content Security Policy and shows it in DeepSeek Harness's sidebar; the DSH tarball carries a copy as `app/`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
