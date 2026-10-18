// Stand-in for "the host's own upstream proxy" (the real host here uses http://127.0.0.1:10808).
// Requires Basic auth, so the test can show the egress proxy chains through it WITH credentials the
// sandbox never sees. Tunnels CONNECT to wherever asked and logs every request.
import { createServer } from "node:http";
import { connect } from "node:net";
import { makeLogger } from "../lib/log.ts";

const log = makeLogger("upstream-proxy", process.env.LOG_FILE);
const want = "Basic " + Buffer.from(`${process.env.PROXY_USER}:${process.env.PROXY_PASS}`).toString("base64");
const s = createServer((_req, res) => res.writeHead(405).end());
s.on("connect", (req, client, head) => {
  if (req.headers["proxy-authorization"] !== want) {
    log("connect", { target: req.url, decision: "407 no/invalid proxy credentials", src: req.socket.remoteAddress });
    return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  }
  const [h, p] = (req.url ?? "").split(":");
  const up = connect(Number(p), h, () => {
    log("connect", { target: req.url, decision: "tunnel", src: req.socket.remoteAddress });
    client.write("HTTP/1.1 200 OK\r\n\r\n");
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  client.on("error", () => up.destroy());
});
s.listen(Number(process.env.PORT ?? 3128), "0.0.0.0", () => log("listening", { port: process.env.PORT ?? 3128 }));
