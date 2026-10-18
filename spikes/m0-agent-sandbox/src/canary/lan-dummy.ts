// Host-side "LAN device": one HTTP listener, bound to the host's LAN address only (LAN_BIND), logging every hit.
import { createServer } from "node:http";
import { makeLogger } from "../lib/log.ts";

const log = makeLogger("lan-dummy", process.env.LOG_FILE);
const port = Number(process.env.LAN_PORT ?? 19939);
const bind = process.env.LAN_BIND ?? "127.0.0.1";
createServer((req, res) => {
  log("connection", { service: "lan-device", src: `${req.socket.remoteAddress}:${req.socket.remotePort}`, url: req.url });
  res.end(JSON.stringify({ service: "lan-device", secret: process.env.CANARY ?? "x" }));
}).listen(port, bind, () => log("listening", { bind, port }));
