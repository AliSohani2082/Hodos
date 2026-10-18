// Dummy "app-side" services that stand in for what the sandbox must NOT reach:
//   PG_PORT      a Postgres-looking listener (answers the SSLRequest/startup packet with a canary banner)
//   RUNNER_PORT  the runner API (HTTP, returns a canary JSON)
//   LAN_PORT     a "LAN device" (HTTP)
// Every connection is logged with its source address. The escape tests assert that NO connection
// from the sandbox ever shows up here, and a positive control from a normal container proves the
// listeners are reachable at all (so a "can't connect" result means something).
import { createServer as tcp } from "node:net";
import { createServer as http } from "node:http";
import { makeLogger } from "../lib/log.ts";

const log = makeLogger("dummies", process.env.LOG_FILE);
const canary = process.env.CANARY ?? "CANARY-UNSET";

const PG_PORT = Number(process.env.PG_PORT ?? 5432);
tcp((sock) => {
  log("connection", { service: "postgres", src: `${sock.remoteAddress}:${sock.remotePort}` });
  sock.on("data", () => sock.write(Buffer.from(`N`)));
  sock.write(Buffer.from(`E fake-postgres ${canary}\0`));
  sock.on("error", () => {});
}).listen(PG_PORT, "0.0.0.0", () => log("listening", { service: "postgres", port: PG_PORT }));

for (const [service, port] of [["runner-api", Number(process.env.RUNNER_PORT ?? 7070)], ["lan-device", Number(process.env.LAN_PORT ?? 9999)]] as const) {
  http((req, res) => {
    log("connection", { service, src: `${req.socket.remoteAddress}:${req.socket.remotePort}`, method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ service, secret: canary }));
  }).listen(port, "0.0.0.0", () => log("listening", { service, port }));
}
