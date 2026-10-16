// Stand-in LLM provider used to test key injection WITHOUT spending money.
// Records which credential header arrived so the test can assert the proxy replaced the sandbox's
// placeholder with the "real" key. Speaks just enough of both APIs to answer.
import { createServer } from "node:http";
import { makeLogger } from "../lib/log.ts";

const log = makeLogger("mock-llm", process.env.LOG_FILE);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const auth = String(req.headers["authorization"] ?? "");
  const key = String(req.headers["x-api-key"] ?? "");
  log("request", {
    method: req.method,
    url: req.url,
    "x-api-key": key ? key.slice(0, 4) + "…" + key.slice(-4) : null,
    authorization: auth ? auth.slice(0, 11) + "…" + auth.slice(-4) : null,
    bytes: Buffer.concat(chunks).length,
  });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ seenXApiKey: key, seenAuthorization: auth, url: req.url }));
}).listen(Number(process.env.PORT ?? 9000), "0.0.0.0", () => log("listening", { port: process.env.PORT ?? 9000 }));
