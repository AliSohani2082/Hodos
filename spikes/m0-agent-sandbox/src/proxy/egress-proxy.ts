// ALI-56 / 04.3: egress proxy for the agent-job sandbox. Default-deny.
//
// The sandbox sits on an --internal network whose only neighbour is this proxy, so there is no
// other route out (network boundary). On top of that the proxy itself enforces:
//
//  1. GATEWAY routes (credential injection, no TLS interception needed because the sandbox ->
//     proxy hop is plain HTTP on the private network):
//        /anthropic/*  -> https://api.anthropic.com/*   adds x-api-key       (Claude Code: ANTHROPIC_BASE_URL)
//        /openai/*     -> https://api.openai.com/*      adds Authorization   (Codex: model_providers.*.base_url)
//        /mcp          -> $MCP_UPSTREAM                 passes the per-job Bearer token through
//     Whatever credential the sandbox sends is DISCARDED and replaced, so the sandbox can neither
//     use its own key against the provider nor learn the real one.
//  2. FORWARD mode (HTTP_PROXY / HTTPS_PROXY style CONNECT): denied for everything unless the
//     exact host:port is in ALLOW_CONNECT (empty by default). Used only as the documented
//     fallback for a CLI that cannot take a custom base URL. After DNS resolution private,
//     loopback, link-local, CGNAT, metadata and ULA addresses are refused, so an allowlisted
//     name that resolves inward is still blocked.
//  3. Every decision is logged as one JSON line (deny AND allow).
//
// If the host reaches the internet through an upstream proxy, set UPSTREAM_PROXY
// (http://user:pass@host:port): outbound HTTPS from this process chains through it. The sandbox
// never sees that address or its credentials.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import { makeLogger } from "../lib/log.ts";

const PORT = Number(process.env.LISTEN_PORT ?? 8080);
const log = makeLogger("proxy", process.env.LOG_FILE);
const MAX_LLM_REQUESTS = Number(process.env.MAX_LLM_REQUESTS ?? 300); // blunt spend guard per proxy lifetime
const ALLOW_CONNECT = new Set((process.env.ALLOW_CONNECT ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const UPSTREAM_PROXY = process.env.UPSTREAM_PROXY ? new URL(process.env.UPSTREAM_PROXY) : null;

interface Route {
  prefix: string;
  upstream: string;
  inject?: (h: Headers) => void;
  allow: (method: string, path: string) => boolean;
  countsAsLlm: boolean;
}
const env = (k: string) => process.env[k] ?? "";
const routes: Route[] = [
  {
    prefix: "/anthropic",
    upstream: process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com",
    inject: (h) => {
      h.delete("authorization");
      h.set("x-api-key", env("ANTHROPIC_API_KEY"));
    },
    allow: (m, p) => (m === "POST" && /^\/v1\/messages(\/count_tokens)?$/.test(p)) || (m === "GET" && /^\/v1\/models(\/[\w.:-]+)?$/.test(p)),
    countsAsLlm: true,
  },
  {
    prefix: "/openai",
    upstream: process.env.OPENAI_UPSTREAM ?? "https://api.openai.com",
    inject: (h) => {
      h.delete("x-api-key");
      h.set("authorization", `Bearer ${env("OPENAI_API_KEY")}`);
    },
    allow: (m, p) => (m === "POST" && /^\/v1\/(responses|chat\/completions)$/.test(p)) || (m === "GET" && /^\/v1\/models(\/[\w.:-]+)?$/.test(p)),
    countsAsLlm: true,
  },
  {
    prefix: "/mcp",
    upstream: process.env.MCP_UPSTREAM ?? "http://ali39-mcp:7000",
    allow: (_m, p) => p === "" || p === "/",
    countsAsLlm: false,
  },
];

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "cookie"]);
let llmRequests = 0;
const src = (req: IncomingMessage) => req.socket.remoteAddress ?? "?";

function deny(res: ServerResponse, status: number, reason: string, fields: Record<string, unknown>) {
  log("egress", { decision: "deny", reason, status, ...fields });
  res.writeHead(status, { "content-type": "text/plain", "x-egress-policy": "deny" }).end(`denied by ali39 egress policy: ${reason}\n`);
}

async function gateway(req: IncomingMessage, res: ServerResponse, route: Route, rest: string, url: URL) {
  const method = req.method ?? "GET";
  const base = { kind: "gateway", route: route.prefix, method, path: rest, src: src(req) };
  if (!route.allow(method, rest)) return deny(res, 403, "path_not_allowed", base);
  if (route.countsAsLlm && ++llmRequests > MAX_LLM_REQUESTS) return deny(res, 429, "request_budget_exhausted", base);
  if (route.inject && route.prefix !== "/mcp" && !env(route.prefix === "/anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"))
    return deny(res, 503, "no_provider_key_configured", base);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const hadCredential = headers.has("x-api-key") || headers.has("authorization");
  route.inject?.(headers);
  const target = route.upstream.replace(/\/$/, "") + rest + url.search;
  const started = Date.now();
  try {
    const hasBody = method !== "GET" && method !== "HEAD";
    const up = await fetch(target, {
      method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
      // @ts-expect-error node-specific
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
    });
    res.writeHead(up.status, out);
    log("egress", { decision: "allow", ...base, upstreamHost: new URL(target).host, status: up.status, sandboxSentCredential: hadCredential, injected: Boolean(route.inject), ms: Date.now() - started });
    if (up.body) Readable.fromWeb(up.body as any).pipe(res);
    else res.end();
  } catch (e) {
    log("egress", { decision: "error", ...base, error: String(e).slice(0, 200) });
    if (!res.headersSent) res.writeHead(502).end("bad gateway\n");
    else res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    const raw = req.url ?? "/";
    if (/^[a-z]+:\/\//i.test(raw)) {
      // absolute-URI request == someone is using us as a plain-HTTP forward proxy
      return deny(res, 403, "plain_http_forwarding_disabled", { kind: "forward", method: req.method, target: raw.slice(0, 200), src: src(req) });
    }
    const url = new URL(raw, "http://proxy.local");
    if (url.pathname === "/healthz") return void res.writeHead(200).end("ok\n");
    for (const r of routes) {
      if (url.pathname === r.prefix || url.pathname.startsWith(r.prefix + "/")) {
        return await gateway(req, res, r, url.pathname.slice(r.prefix.length), url);
      }
    }
    return deny(res, 403, "no_such_route", { kind: "gateway", method: req.method, path: url.pathname, src: src(req) });
  } catch (e) {
    log("error", { message: String(e) });
    if (!res.headersSent) res.writeHead(500).end();
  }
});

// ---- forward mode: CONNECT ---------------------------------------------------
function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); // v4-mapped
    return m ? isPrivate(m[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 metadata
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224
  );
}

function viaUpstream(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect(Number(UPSTREAM_PROXY!.port || 80), UPSTREAM_PROXY!.hostname);
    s.once("error", reject);
    s.once("connect", () => {
      const auth = UPSTREAM_PROXY!.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(UPSTREAM_PROXY!.username)}:${decodeURIComponent(UPSTREAM_PROXY!.password)}`).toString("base64")}\r\n`
        : "";
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let buf = "";
      s.on("data", function onData(d) {
        buf += d.toString("latin1");
        if (buf.includes("\r\n\r\n")) {
          s.off("data", onData);
          if (/^HTTP\/1\.[01] 200/.test(buf)) resolve(s);
          else (s.destroy(), reject(new Error("upstream proxy refused: " + buf.split("\r\n")[0])));
        }
      });
    });
  });
}

server.on("connect", async (req, client, head) => {
  const target = (req.url ?? "").toLowerCase();
  const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
  const base = { kind: "connect", target, src: req.socket.remoteAddress ?? "?" };
  const refuse = (reason: string) => {
    log("egress", { decision: "deny", reason, ...base });
    client.end("HTTP/1.1 403 Forbidden\r\nx-egress-policy: deny\r\n\r\n");
  };
  if (!m) return refuse("bad_target");
  if (!ALLOW_CONNECT.has(target)) return refuse("not_in_allowlist");
  const host = m[1].replace(/^\[|\]$/g, "");
  const port = Number(m[2]);
  try {
    const ip = isIP(host) ? host : (await lookup(host)).address;
    if (isPrivate(ip)) return refuse(`resolves_to_private_address:${ip}`);
    const upstream = UPSTREAM_PROXY ? await viaUpstream(host, port) : netConnect(port, ip);
    const ready = () => {
      log("egress", { decision: "allow", ...base, resolved: UPSTREAM_PROXY ? "(via upstream proxy)" : ip, viaUpstreamProxy: Boolean(UPSTREAM_PROXY) });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    if (UPSTREAM_PROXY) ready();
    else upstream.once("connect", ready);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.setTimeout(10 * 60_000, () => (client.destroy(), upstream.destroy()));
  } catch (e) {
    log("egress", { decision: "error", ...base, error: String(e).slice(0, 200) });
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  }
});

server.listen(PORT, "0.0.0.0", () =>
  log("listening", { port: PORT, routes: routes.map((r) => r.prefix), allowConnect: [...ALLOW_CONNECT], upstreamProxy: UPSTREAM_PROXY ? `${UPSTREAM_PROXY.hostname}:${UPSTREAM_PROXY.port}` : null }),
);
