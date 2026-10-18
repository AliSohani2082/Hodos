# CLI configuration discovery (ALI-58)

The job profile starts with a fresh temporary home for every run. For Claude,
the ACP session receives only the server's explicit MCP list. For Codex, the
profile masks the checkout's `.codex/` directory with an empty read-only tmpfs;
the mask uses Podman's `notmpcopyup` option so an existing project config is not
copied into it. The launcher also sets a fresh Codex home that marks
`/workspace` untrusted and supplies `project_doc_max_bytes = 0` to disable
`AGENTS.md` prompt discovery.

`./scripts/config-test.sh` plants an instruction canary, a rogue MCP endpoint,
and a Claude pre-tool hook in a throwaway checkout. It runs isolated launches
and positive controls that enable project discovery. Its output is recorded in
`results/ali58-config-discovery.txt`. The positive controls showed the planted
Claude instruction and hook were honored when enabled, and the Codex
instruction and rogue MCP endpoint were honored when the `.codex/` mask and
untrusted-project settings were removed. Under the isolated launch, both
instruction canaries were absent from mock-provider requests, the Claude hook
did not run, and Codex did not contact the planted route.

| CLI | Skip project and user discovery | Explicit MCP config | Custom provider base URL | Verification |
|---|---|---|---|---|
| Claude Code 2.1.300 via `claude-agent-acp` 0.91.0 | Fresh `CLAUDE_CONFIG_DIR`; ACP SDK option `settingSources: []` (adapter emits `--setting-sources=`) skips user/project/local settings, `CLAUDE.md`, and `.claude/` settings. `strictMcpConfig: true` corresponds to `--strict-mcp-config`. | ACP `session/new` `mcpServers` array; only the explicitly passed server is used. Standalone CLI supports `--mcp-config <file>` with `--strict-mcp-config`. | `ANTHROPIC_BASE_URL=http://ali39-proxy:8080/anthropic`; proxy replaces the placeholder `ANTHROPIC_API_KEY`. | ACP path and project hook/instruction planted in checkout; control confirmed they were active only when discovery was enabled. |
| Codex 0.160.1 via `codex-acp` 2.2.2 | No single CLI flag disables every source. Fresh `CODEX_HOME=/home/agent/.codex` isolates user settings. `/workspace/.codex` is hidden with an empty read-only tmpfs (`notmpcopyup`); a fresh config marks `/workspace` untrusted. `CODEX_CONFIG={"project_doc_max_bytes":0}` skips `AGENTS.md`. | ACP `session/new` `mcpServers` list with URL and bearer header; Codex ACP reports HTTP MCP support. A direct Codex CLI can configure only explicit servers in the isolated `CODEX_HOME/config.toml` via `[mcp_servers.<name>]`. | ACP `authenticate` method `gateway`, with `baseUrl=http://ali39-proxy:8080/openai/v1`; the proxy injects Authorization. | ACP prompt succeeded. Isolated launch hid planted `.codex` route and `AGENTS.md`; the trusted positive control exposed both. |
| Gemini CLI 0.64.0 | Not installed; no verified switch to disable project/user config discovery. The documented layers include user `~/.gemini/settings.json` and project `.gemini/settings.json`; use a fresh home and mask the project directory pending verification. | MCP uses `mcpServers` in settings. `--settings <file>` was not verified to replace all configuration layers. | Custom provider endpoint not verified. | Documentation only; unsupported for M0 pending a separately verified isolation recipe. |
| OpenCode 1.19.2 | Not installed; no verified switch to disable project/user config discovery. `OPENCODE_CONFIG` selects a custom config, but docs also list global and project configs as separate layers. Mask `opencode.json` and `.opencode/`, and set isolated XDG config/data dirs pending verification. | MCP is configured in the `mcp` object of `opencode.json`; no explicit runtime MCP-only flag was verified. | `provider.*.options.baseURL` is documented for custom endpoints, but not verified in this spike. | Documentation only; unsupported for M0 pending a separately verified isolation recipe. |

Documentation reviewed (not installed or runtime-verified here): [Gemini CLI configuration layers](https://geminicli.com/docs/reference/configuration/), [Gemini CLI MCP configuration](https://geminicli.com/docs/tools/mcp-server/), [OpenCode configuration precedence](https://docs.opencode.ai/docs/config/), [OpenCode MCP configuration](https://docs.opencode.ai/docs/mcp-servers/), and [OpenCode provider base URLs](https://docs.opencode.ai/docs/providers/).

For Claude and Codex, the exact ACP options are in `src/client/harnesses.ts` and `src/client/acp-client.ts`; tests and the mock request capture are reproducible with `./scripts/config-test.sh`. Codex reference documentation: [Codex config reference](https://developers.openai.com/codex/config-reference/), including trusted-project handling and `project_doc_max_bytes`.

The Claude adapter has its own settings manager; the tested `settingSources: []`
and strict MCP settings prevented the planted project hook and instruction
from affecting the ACP session. For Codex, the empty `.codex` mount is part of
the agent-job profile, not a Codex flag. A checkout still contains arbitrary
text files; the tested `project_doc_max_bytes=0` stops Codex from ingesting
`AGENTS.md`, while the default trust config blocks project-local settings,
hooks, and MCP configuration.
