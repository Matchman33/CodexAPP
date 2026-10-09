import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web"), errors = [];
const server = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, "." + (name === "/" ? "/index.html" : name));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, socket;
let status = { enabled: true, supported: true, active: false, error: "helper startup timed out", phase: "retrying", nextRetryAt: Date.now() + 1000, retryCount: 1 };
const runtimeMessage = message => message.type === "hello" ? { ...message, sleepPrevention: status, multiSession: { supported: true }, serviceRestart: { supported: true, phase: "idle" } } : message;
const bridge = new CodexBridge({ defaultCwd: os.tmpdir() }, message => socket?.send(JSON.stringify(runtimeMessage(message))));
Object.assign(bridge.state, { threadId: "one", codexConnected: true });
bridge.models.list = async () => ({ type: "models", models: [], defaultModel: null });
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage(), url = "http://127.0.0.1:" + server.address().port;
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(url => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "fixture" })), url);
  await page.routeWebSocket("**/ws?*", route => {
    socket = route;
    route.onMessage(async raw => {
      const m = JSON.parse(raw);
      if (m.type === "listThreads") return route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] }));
      try { await bridge.dispatch(m); } catch (error) { route.send(JSON.stringify({ type: "error", requestId: m.requestId, message: error.message })); }
    });
    route.send(JSON.stringify(runtimeMessage(bridge.snapshot())));
  });
  await page.goto(url); await page.waitForFunction(() => sessionReady);
  await page.locator("#sleepWarning").waitFor({ state: "visible" });
  assert.match(await page.locator("#sleepWarning").textContent(), /超时.*自动重试/);
  await page.reload(); await page.waitForFunction(() => sessionReady);
  assert.match(await page.locator("#sleepWarning").textContent(), /电脑可能自动休眠/);
  await page.locator("#menuBtn").click();
  assert.equal(await page.locator("#restartServiceBtn").isEnabled(), true, "防休眠失败不会阻止项目重启");
  socket.send(JSON.stringify({ type: "serviceRestart", supported: true, phase: "restarting" }));
  await page.waitForFunction(() => serviceRestart.phase === "restarting");
  assert.match(await page.locator("#serviceStatus").textContent(), /正在重启/);
  assert.match(await page.locator("#sleepStatus").textContent(), /未生效/);
  status = { ...status, active: true, error: null, phase: "active", nextRetryAt: null, retryCount: 0 };
  socket.send(JSON.stringify({ type: "sleepPrevention", status }));
  await page.locator("#sleepWarning").waitFor({ state: "hidden" });
  assert.match(await page.locator("#sleepStatus").textContent(), /已生效/);
  socket.send(JSON.stringify({ type: "sleepPrevention", status: { ...status, active: false, phase: "retrying", error: "helper exited unexpectedly" } }));
  await page.waitForFunction(() => document.querySelector("#sleepStatus").textContent.includes("未生效"));
  await page.locator("#sheetClose").click();
  await page.locator("#sleepWarning").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("passed: 防休眠超时持续提示、刷新恢复、项目继续重启、自动恢复和意外退出通知；模型调用 0");
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
