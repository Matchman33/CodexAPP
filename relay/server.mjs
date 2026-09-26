// Local HTTP/WebSocket transport. Conversation behavior is shared with the cloud Agent.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SessionHub } from "../core/sessionHub.mjs";
import { persistModel } from "../core/modelSettings.mjs";
import { createSleepPrevention } from "../core/sleepPrevention.mjs";
import { enableServiceRestart, hostRestart } from "../core/serviceRestart.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEBAPP_DIR = path.join(ROOT, "web");
const CONFIG_PATH = path.join(ROOT, "codexapp.config.json");
const defaults = { codexBin: "", host: "0.0.0.0", port: 4123, token: "", defaultCwd: os.homedir(), approvalPolicy: "on-request", sandbox: "workspace-write", model: null, reasoningEffort: null, preventSleep: true, originator: "codex_vscode" };
const config = { ...defaults, ...(fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {}) };
if (!config.token) {
  config.token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.HOST) config.host = process.env.HOST;
config.defaultCwd ||= os.homedir();
const clients = new Map();
const dataDir = process.env.CODEXAPP_DATA_DIR || path.join(os.homedir(), ".codexapp", "relay-" + crypto.createHash("sha256").update(ROOT).digest("hex").slice(0, 12));
const hub = new SessionHub(config, message => {
  const raw = JSON.stringify(message);
  for (const [ws, id] of clients) if ((!message.clientId || message.clientId === id) && ws.readyState === ws.OPEN) ws.send(raw);
}, (model, settings) => persistModel(CONFIG_PATH, model, settings), { dataDir });
const sleepPrevention = createSleepPrevention(config);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, codexConnected: hub.state.codexConnected, sleepPrevention: sleepPrevention.status() }));
  }
  let name;
  try { name = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(WEBAPP_DIR, "." + (name === "/" ? "/index.html" : name));
  if (!file.startsWith(WEBAPP_DIR + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(data);
  });
});
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1048576 });
process.on("message", async m => {
  if (m?.type !== "codexapp-stop" || process.env.CODEXAPP_MANAGED !== "1") return;
  await hub.stop(); process.exit(0);
});
function send(ws, m) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); }
enableServiceRestart(hub, hostRestart(async () => {
  await hub.stop();
  for (const ws of clients.keys()) ws.close(1012, "service restart");
  await new Promise(resolve => server.close(resolve));
}));
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("token") !== config.token) { send(ws, { type: "error", message: "无效 token" }); ws.close(4001, "unauthorized"); return; }
  const id = url.searchParams.get("clientId") || "legacy";
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) { ws.close(4000, "invalid client"); return; }
  clients.set(ws, id); ws.on("error", () => {});
  if (url.searchParams.get("history") === "paged") hub.pagedClients.add(id);
  send(ws, hub.snapshot(id));
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== "string") return;
    hub.dispatch(m, id).catch(error => send(ws, { type: "error", message: error.message, requestId: m.requestId, threadId: m.threadId, terminalId: m.terminalId }));
  });
  ws.on("close", () => { clients.delete(ws); if (id !== "legacy" && ![...clients.values()].includes(id)) hub.disconnect(id); });
});
async function main() {
  await hub.start(); hub.restoreQueues(); await sleepPrevention.start();
  console.log("[codex] binary:", hub.control.codex.bin);
  server.listen(config.port, config.host, () => {
    console.log("CodexApp relay: http://127.0.0.1:" + config.port);
    console.log("Token: " + config.token);
  });
}
main().catch(error => { console.error("[fatal]", error.message); process.exit(1); });
