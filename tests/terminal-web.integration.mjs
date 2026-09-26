import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "@playwright/test";
import { SessionHub } from "../core/sessionHub.mjs";
import { enableServiceRestart } from "../core/serviceRestart.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-terminal-web-"));
const web = path.resolve("web"), clients = new Map();
const win = process.platform === "win32";
const server = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(web, "." + (name === "/" ? "/index.html" : name));
    if (!file.startsWith(web + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
const hub = new SessionHub({ defaultCwd: dir, sandbox: "read-only", approvalPolicy: "on-request" }, m => {
  for (const [ws, id] of clients) if ((!m.clientId || m.clientId === id) && ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}, undefined, { dataDir: dir, terminal: { shell: win ? { file: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo", "-NoProfile"], name: "PowerShell" } : { file: "/bin/sh", args: [], name: "sh" } } });
hub.control.state.codexConnected = true;
enableServiceRestart(hub, async () => { throw new Error("must not restart with an active terminal"); });
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost"), id = url.searchParams.get("clientId");
  if (url.searchParams.get("token") !== "fixture") { ws.close(4001); return; }
  clients.set(ws, id); ws.send(JSON.stringify(hub.snapshot(id)));
  ws.on("close", () => { clients.delete(ws); hub.disconnect(id); });
  ws.on("message", async raw => {
    const m = JSON.parse(raw);
    if (m.type === "listThreads") { ws.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] })); return; }
    if (m.type === "listModels") { ws.send(JSON.stringify({ type: "models", models: [] })); return; }
    try { await hub.dispatch(m, id); } catch (e) { ws.send(JSON.stringify({ type: "error", message: e.message, requestId: m.requestId, terminalId: m.terminalId })); }
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const url = "http://127.0.0.1:" + server.address().port;
  const unauthorized = new WebSocket(url.replace("http:", "ws:") + "/ws?token=wrong&clientId=bad");
  await new Promise(resolve => unauthorized.once("close", code => { assert.equal(code, 4001); resolve(); }));
  assert.equal(hub.terminals.activeCount, 0);
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(url => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "fixture" })), url);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(url); await page.locator("#terminalBtn:not([disabled])").waitFor();
  await page.locator("#terminalBtn").click(); await page.waitForFunction(() => webTerminal.ready && webTerminal.canInput);
  const command = win ? "Write-Output ('WEB'+'-TERMINAL-OK')" : "printf 'WEB%s\\n' '-TERMINAL-OK'";
  await page.locator(".xterm-helper-textarea").focus(); await page.keyboard.type(command); await page.keyboard.press("Enter");
  await page.waitForFunction(() => [...Array(webTerminal.term.buffer.active.length).keys()].some(i => webTerminal.term.buffer.active.getLine(i)?.translateToString(true).trim() === "WEB-TERMINAL-OK"));
  const terminalId = await page.evaluate(() => webTerminal.id);
  await page.evaluate(() => sendWs({ type: "restartService", confirmed: true, requestId: "restart-with-terminal" }));
  await page.waitForFunction(() => serviceRestart.error?.includes("活动终端"));
  await page.locator("#terminalHide").click(); assert.equal(hub.terminals.activeCount, 1);
  await page.locator("#terminalBtn").click(); await page.waitForFunction(() => webTerminal.ready);
  assert.equal(await page.evaluate(() => webTerminal.id), terminalId);
  await page.evaluate(() => ws.close());
  await page.waitForFunction(() => !webTerminal.connected);
  await page.waitForFunction(() => webTerminal.connected && webTerminal.ready);
  assert.equal(await page.evaluate(() => webTerminal.id), terminalId);
  assert.equal(hub.terminals.activeCount, 1);
  await fs.mkdir("dist-check/terminal-ui", { recursive: true });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const bounds = await page.locator(".xterm-screen").boundingBox();
    assert(bounds.width > 200 && bounds.height > 150);
    const pane = await page.locator("#terminalViewport").boundingBox();
    assert(bounds.x >= pane.x && bounds.x + bounds.width <= pane.x + pane.width + 2);
    await page.screenshot({ path: `dist-check/terminal-ui/${width}-terminal.png` });
  }
  await page.locator("#terminalEnd").click(); await page.locator("#terminalCloseConfirm").click();
  await page.waitForFunction(() => webTerminal.id === null);
  assert.equal(hub.terminals.activeCount, 0); assert.deepEqual(errors, []);
  console.log("PASS: authenticated real PTY in browser, keyboard input, hide/reopen, reconnect, restart guard, confirmed exit, 390/1280 layouts");
} finally {
  await browser?.close(); hub.terminals.dispose();
  for (const ws of clients.keys()) ws.terminate();
  await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
