import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocketServer } from "ws";
import { chromium } from "@playwright/test";
import { SessionHub } from "../core/sessionHub.mjs";
import { enableServiceRestart } from "../core/serviceRestart.mjs";

const root = path.resolve("web"), dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-sessions-web-"));
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, "." + (req.url === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
const peers = new Map(), calls = [];
const hub = new SessionHub({ defaultCwd: dir, model: "fixture", approvalPolicy: "on-request", sandbox: "read-only" }, m => {
  for (const [ws, id] of peers) if (!m.clientId || m.clientId === id) ws.send(JSON.stringify(m));
}, undefined, { dataDir: dir });
hub.control.state.codexConnected = true;
let sequence = 0, externalText = "外部历史", restarts = 0;
enableServiceRestart(hub, async () => { restarts++; });
hub.control.codex.request = async (method, params) => {
  calls.push({ method, params });
  if (method === "thread/resume" && params.threadId === "external") throw new Error("thread already has an active writer");
  if (method === "thread/read" || method === "thread/resume") return { thread: { id: params.threadId, name: params.threadId, cwd: dir, turns: [] } };
  if (method === "thread/start") return { thread: { id: "created-" + ++sequence, cwd: params.cwd, turns: [] } };
  if (method === "thread/turns/list") return { data: params.threadId === "external" ? [{ id: "external-turn", status: "inProgress", startedAt: 1 }] : [], nextCursor: null };
  if (method === "thread/items/list") return { data: [{ id: "external-item", type: "agentMessage", text: externalText }], nextCursor: null };
  if (method === "turn/start") return { turn: { id: "turn-" + ++sequence } };
  if (method === "model/list") return { data: [{ model: "fixture", isDefault: true, supportedReasoningEfforts: [] }] };
  if (method === "config/read") return { config: { model: "fixture" } };
  throw new Error("unexpected: " + method);
};
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const id = new URL(req.url, "http://localhost").searchParams.get("clientId"); peers.set(ws, id);
  ws.send(JSON.stringify(hub.snapshot(id)));
  ws.on("message", async raw => {
    const m = JSON.parse(raw);
    if (m.type === "listThreads") { ws.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] })); return; }
    try { await hub.dispatch(m, id); } catch (error) { ws.send(JSON.stringify({ type: "error", requestId: m.requestId, message: error.message })); }
  });
  ws.on("close", () => peers.delete(ws));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
  const url = "http://127.0.0.1:" + server.address().port;
  await context.addInitScript(url => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "fixture" })), url);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(url); await page.waitForFunction(() => sessionReady && multiSession);
  await page.evaluate(() => selectHistoryThread("one"));
  await page.waitForFunction(() => appState.threadId === "one" && !pendingSelection);
  await page.locator("#input").fill("项目一的草稿");
  await page.locator("#quickNewThread").click(); await page.locator("#newInProject").click();
  await page.waitForFunction(() => appState.threadId?.startsWith("created-"));
  const projectId = await page.evaluate(() => appState.threadId);
  assert.equal(await page.locator("#input").inputValue(), "");
  await page.locator("#input").fill("second task"); await page.locator("#sendBtn").click();
  await page.waitForFunction(() => appState.status === "running");
  await page.evaluate(() => selectHistoryThread("one"));
  await page.waitForFunction(() => appState.threadId === "one" && !pendingSelection);
  assert.equal(await page.locator("#input").inputValue(), "项目一的草稿");
  await page.locator("#sendBtn").click(); await page.waitForFunction(() => appState.status === "running");
  assert.equal(hub.sessions.get(projectId).state.status, "running");
  await page.locator("#quickNewThread").click(); await page.locator("#newTemporary").click();
  await page.waitForFunction(() => appState.projectless === true);
  assert.notEqual(await page.evaluate(() => appState.cwd), dir);
  await page.evaluate(() => selectHistoryThread("external"));
  await page.waitForFunction(() => appState.threadId === "external" && !pendingSelection);
  assert.equal(await page.locator("#writerSheet").isVisible(), false);
  hub.sessions.get("external").writers.inspect = async () => ({ type: "writerConflict", threadId: "external", owners: [], message: "外部占用" });
  externalText = "外部进程的新消息";
  await page.waitForFunction(() => document.querySelector("#feed").textContent.includes("外部进程的新消息"));
  await page.locator("#input").fill("request writer"); await page.locator("#sendBtn").click();
  await page.locator("#writerSheet").waitFor({ state: "visible" });
  assert.equal(hub.sessions.get("external").promptQueue.snapshot().items[0].text, "request writer");
  await page.locator("#writerClose").click();
  await page.locator("#menuBtn").click(); await page.locator("#restartServiceBtn").click(); await page.locator("#restartConfirm").click();
  await page.waitForFunction(() => serviceRestart.phase === "waiting"); assert.equal(restarts, 0);
  await page.locator("#menuBtn").click(); await page.locator("#cancelRestartBtn").click();
  await page.waitForFunction(() => serviceRestart.phase === "idle"); await page.locator("#sheetClose").click();
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await fs.mkdir("dist-check/sessions-ui", { recursive: true });
  await page.screenshot({ path: "dist-check/sessions-ui/390-sessions.png" });
  console.log("PASS: concurrent sessions, drafts, temporary scope, external updates, conflict on send, restart waiting/cancel; no model prompts");
} finally {
  await browser?.close(); for (const ws of peers.keys()) ws.terminate();
  await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}
