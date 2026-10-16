// Per-harness launch recipe: what to exec in the sandbox, which env/config makes it
//   (1) skip project + user config discovery,  (2) use ONLY our explicit MCP config,
//   (3) send LLM traffic to the egress proxy with a placeholder key (the proxy injects the real one).
// These are the settings ALI-58 verifies; the table in the ADR is generated from what works here.
export type Harness = "claude" | "codex";

export interface Net {
  proxy: string; // e.g. http://ali39-proxy:8080
  mcpUrl: string; // e.g. http://ali39-proxy:8080/mcp
  mcpToken: string; // per-job token (the only secret the sandbox holds)
}
export interface Plan {
  command: string;
  args: string[];
  env: Record<string, string>;
  clientCapabilities: Record<string, unknown>;
  /** called after initialize; may authenticate / route providers */
  setup?: (ctx: any, init: any) => Promise<void>;
  sessionMeta: Record<string, unknown>;
}

// env common to both harnesses inside the sandbox
const common = (n: Net): Record<string, string> => ({
  HOME: "/home/agent",
  NO_BROWSER: "1",
});

export function plan(h: Harness, n: Net, opts: { model?: string; maxTurns?: number; allowProjectConfig?: boolean } = {}): Plan {
  if (h === "claude") {
    return {
      command: "claude-agent-acp",
      args: [],
      env: {
        ...common(n),
        // LLM traffic -> gateway route on the proxy; the key here is a PLACEHOLDER the proxy discards.
        ANTHROPIC_BASE_URL: `${n.proxy}/anthropic`,
        ANTHROPIC_API_KEY: "sk-ant-api03-PLACEHOLDER-the-proxy-injects-the-real-key",
        CLAUDE_CONFIG_DIR: "/home/agent/.claude",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
      clientCapabilities: {},
      sessionMeta: {
        claudeCode: {
          options: {
            settingSources: opts.allowProjectConfig ? ["project", "local"] : [],
            strictMcpConfig: !opts.allowProjectConfig,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
            persistSession: false,
          },
        },
      },
    };
  }
  // codex
  const projectTrust = opts.allowProjectConfig ? "trusted" : "untrusted";
  return {
    command: "sh",
    args: ["-c", `mkdir -p /home/agent/.codex && printf '[projects.\"/workspace\"]\\ntrust_level = \"${projectTrust}\"\\n' > /home/agent/.codex/config.toml && exec codex-acp`],
    env: {
      ...common(n),
      CODEX_HOME: "/home/agent/.codex",
      ...(opts.allowProjectConfig ? {} : { CODEX_CONFIG: JSON.stringify({ project_doc_max_bytes: 0 }) }),
      INITIAL_AGENT_MODE: "agent-full-access", // codex's own sandbox needs userns/landlock; the container is the boundary
    },
    // advertise gateway auth so the adapter offers the "gateway" method; the OpenAI key is never in the sandbox
    clientCapabilities: { auth: { _meta: { gateway: true } } },
    setup: async (ctx, init) => {
      const methods: string[] = (init.authMethods ?? []).map((m: any) => m.id);
      if (!methods.includes("gateway")) throw new Error(`codex-acp offered no gateway auth method: ${methods.join(",")}`);
      await ctx.request("authenticate", {
        methodId: "gateway",
        _meta: { gateway: { baseUrl: `${n.proxy}/openai/v1`, headers: {}, providerName: "hodos-egress-proxy" } },
      });
    },
    sessionMeta: {},
  };
}
