import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, socket, release, fail = false;
const calls = [];
const bridge = new CodexBridge({ defaultCwd: "/fixture", model: "fixture-model", approvalPolicy: "on-request", sandbox: "workspace-write" }, message => socket?.send(JSON.stringify(message)));
bridge.state.codexConnected = true;
bridge.history = { paged: true, nextCursor: null };
bridge.models.resolve = async () => "fixture-model"; bridge.models.resolveEffort = async () => null;
bridge.models.list = async () => ({ type: "models", defaultModel: "fixture-model", models: [{ model: "fixture-model", displayName: "fixture-model", supportedReasoningEfforts: [] }] });
bridge.codex.request = async (method, params) => {
  calls.push({ method, params });
  if (method === "thread/unsubscribe") { if (release) await new Promise(resolve => { release = resolve; }); return { status: "unsubscribed" }; }
  if (method === "thread/resume") {
    if (fail) throw new Error("fixture sync failure");
    return { thread: { id: "one", cwd: "/fixture", turns: [] }, approvalPolicy: params.approvalPolicy, sandbox: { type: ({ "workspace-write": "workspaceWrite", "read-only": "readOnly", "danger-full-access": "dangerFullAccess" })[params.sandbox] } };
  }
  if (method === "thread/turns/list") return { data: [], nextCursor: null };
  if (method === "turn/start") { const turn = { id: "next", status: "inProgress" }; bridge.codex.onNotification({ method: "turn/started", params: { threadId: "one", turn } }); return { turn }; }
  throw new Error("Unexpected fixture request: " + method);
};
await bridge.dispatch({ type: "resumeThread", threadId: "one" });
Object.assign(bridge.state, { status: "running", turnId: "existing" }); calls.length = 0;
const finish = () => bridge.codex.onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: bridge.state.turnId, status: "completed" } } });
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], url = "http://127.0.0.1:" + server.address().port;
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "permissions-fixture" })), { url });
  await page.routeWebSocket("**/ws?*", route => {
    socket = route;
    route.onMessage(async raw => {
      const message = JSON.parse(raw);
      if (message.type === "listThreads") { route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] })); return; }
      try { await bridge.dispatch(message); } catch (error) { route.send(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message })); }
    });
    route.send(JSON.stringify(bridge.snapshot()));
  });
  await page.goto(url);
  await page.waitForFunction(() => sessionReady && !pageRequest);
  assert.equal(await page.locator("#permissionStatus").count(), 1, "current and pending permissions need a visible status surface");
  await page.locator("#menuBtn").click();
  await page.locator("#cfgSandbox").selectOption("danger-full-access");
  await page.locator("#cfgApproval").selectOption("never");
  await page.locator("#cfgApply").click();
  await page.waitForFunction(() => appState.permissions?.pending && !pendingConfig);
  assert((await page.locator("#permissionStatus").textContent()).includes("本轮结束后"));
  assert((await page.locator("#permissionStatus").textContent()).includes("workspace-write"));
  assert(!calls.some(call => ["thread/unsubscribe", "thread/resume", "turn/start"].includes(call.method)));
  await page.reload(); await page.waitForFunction(() => sessionReady && !pageRequest);
  await page.locator("#menuBtn").click();
  assert((await page.locator("#cfgPermissionStatus").textContent()).includes("本轮结束后"));
  await page.locator("#sheetClose").click();
  await page.locator("#input").fill("queued fixture prompt"); await page.locator("#sendBtn").click();
  await page.waitForFunction(() => promptQueueState.items.length === 1);
  release = () => {}; finish();
  await page.waitForFunction(() => appState.permissions?.applying);
  assert((await page.locator("#permissionStatus").textContent()).includes("正在同步"));
  assert(!calls.some(call => call.method === "turn/start"));
  release(); release = null; await bridge.commandQueue;
  await page.waitForFunction(() => appState.status === "running" && !appState.permissions?.pending && promptQueueState.items.length === 0);
  assert((await page.locator("#permissionStatus").textContent()).includes("当前权限：danger-full-access"));
  assert.equal(calls.find(call => call.method === "turn/start").params.sandboxPolicy.type, "dangerFullAccess");
  await page.locator("#menuBtn").click(); await page.locator("#cfgSandbox").selectOption("read-only"); await page.locator("#cfgApply").click();
  await page.waitForFunction(() => appState.permissions?.pending && !pendingConfig);
  fail = true; finish(); await bridge.commandQueue;
  await page.waitForFunction(() => !!appState.permissions?.error);
  assert((await page.locator("#permissionStatus").textContent()).includes("fixture sync failure"));
  fail = false; await page.locator("#menuBtn").click(); await page.locator("#cfgApply").click();
  await page.waitForFunction(() => !pendingConfig && !appState.permissions?.pending && !appState.permissions?.error);
  assert((await page.locator("#permissionStatus").textContent()).includes("当前权限：read-only"));
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await fs.mkdir("dist-check/permissions-ui", { recursive: true });
  await page.screenshot({ path: "dist-check/permissions-ui/390-permissions.png" });
  console.log("passed: deferred permissions, reconnect, sync barrier, queue policy, failure and retry; model prompts sent: 0");
  await context.close();
} finally { release?.(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
