# ACP client findings (ALI-54)

The client in `src/client/acp-client.ts` opens an ACP stdio stream to an adapter
inside the agent-job container. It sends `initialize`, starts `session/new`,
submits `session/prompt`, consumes streamed `session/update` messages, and maps
`session/request_permission` through `src/client/policy.ts`. The mock provider
in `src/canary/mock-llm.ts` prevents API spend. Transcript and summary files
are written under ignored `work/runs/`.

Verified on 2026-10-16 with `@agentclientprotocol/sdk` 1.9.0,
`claude-agent-acp` 0.91.0 (bundled Claude Code 2.1.300), and `codex-acp` 2.2.2
(Codex 0.160.1):

```sh
./scripts/up.sh
mkdir -p work/checkouts/job-acpclaude work/checkouts/job-acpcodex
node src/client/acp-client.ts --harness claude --job acpclaude4 --checkout "$PWD/work/checkouts/job-acpclaude" --prompt 'Say ALI39_MOCK_OK and stop.' --no-mcp --policy policies/allow-all.json
node src/client/acp-client.ts --harness codex --job acpcodex3 --checkout "$PWD/work/checkouts/job-acpcodex" --prompt 'Say ALI39_MOCK_OK and stop.' --no-mcp --policy policies/allow-all.json
node src/client/acp-client.ts --harness claude --job tooldeny2 --checkout "$PWD/work/checkouts/job-acpclaude" --prompt 'ALI39_RUN_SHELL' --no-mcp --policy policies/deny-all.json
```

Both harnesses returned `ALI39_MOCK_OK` and `end_turn` from inside the
container. The denial run caused the mock to propose a `Bash` command that
would write `/workspace/ali39-permission-marker`; the client received one
permission request, chose `reject`, and the marker did not appear. A harmless
`echo` was executed without a permission request, so the ACP policy is a
secondary control; the container remains the security boundary.

Claude accepts `ANTHROPIC_BASE_URL` and a placeholder API key; the adapter
creates a session without a separate ACP authentication step. Codex requires
the ACP `gateway` authentication method and an existing writable `CODEX_HOME`.
The `INITIAL_AGENT_MODE=agent-full-access` setting permits Codex to execute
inside the outer container boundary. Session resume was not exercised: the
Claude recipe explicitly sets `persistSession: false`, and a production resume
policy needs a separate decision. The client can send `session/cancel` via
`--cancel-after-ms`; cancellation timing was not measured with the instant mock.
