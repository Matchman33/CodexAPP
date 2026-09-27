import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { SessionHub } from "../core/sessionHub.mjs";
import { enableServiceRestart, hostRestart } from "../core/serviceRestart.mjs";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
export const relayDefaults = { codexBin: "", host: "0.0.0.0", port: 4123, token: "", defaultCwd: os.homedir(), approvalPolicy: "on-request", sandbox: "workspace-write", model: null, reasoningEffort: null, preventSleep: true, originator: "codex_vscode" };
export function existingRelay(config) {
  return new Promise(resolve => {
    const host = config.host === "::" ? "[::1]" : config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const url = new URL("ws://" + host + ":" + config.port + "/ws");
    url.searchParams.set("token", config.token); url.searchParams.set("clientId", "startup-" + crypto.randomUUID());
    const ws = new WebSocket(url);
    const finish = ok => { clearTimeout(timer); ws.close(); resolve(ok); };
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 3000);
    ws.on("error", () => { clearTimeout(timer); resolve(false); });
    ws.on("close", () => { clearTimeout(timer); resolve(false); });
    ws.on("message", raw => {
      let m; try { m = JSON.parse(raw); } catch { finish(false); return; }
      finish(m.type === "hello" && m.sharedRuntime?.version === 1);
    });
  });
}
export function createLocalRelay({ config, dataDir, webDir, saveModel, sleepStatus = () => ({}) }) {
  const clients = new Map(), runtimeId = crypto.randomUUID();
  const decorate = message => message.type === "hello" ? { ...message, sharedRuntime: { version: 1, runtimeId } } : message;
  const send = (ws, message) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(decorate(message))); };
  const hub = new SessionHub(config, message => {
    for (const [ws, id] of clients) if (!message.clientId || message.clientId === id) send(ws, message);
  }, saveModel, { dataDir });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, codexConnected: hub.state.codexConnected, sharedRuntime: { version: 1, runtimeId }, sleepPrevention: sleepStatus() }));
    }
    let name;
    try { name = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    if (!webDir) { res.writeHead(404).end(); return; }
    const file = path.resolve(webDir, "." + (name === "/" ? "/index.html" : name));
    if (!file.startsWith(path.resolve(webDir) + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" }); res.end(data);
    });
  });
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8 * 1048576 });
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
  async function close() {
    await hub.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  enableServiceRestart(hub, hostRestart(close));
  return { hub, server, close, async start() {
    // 先占用监听端口，再启动 Codex，避免两个入口并发启动两个控制进程。
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
    });
    try { await hub.start(); hub.restoreQueues(); }
    catch (error) { await close(); throw error; }
    return server.address().port;
  } };
}
