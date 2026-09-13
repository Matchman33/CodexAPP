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
let browser, socket;
const bridge = new CodexBridge({}, message => socket.send(JSON.stringify(message)));
Object.assign(bridge.state, { threadId: "one", turnId: "active", status: "running", codexConnected: true });
bridge.history = { paged: true, nextCursor: null };
const previous = { id: "one:active:previous", kind: "item:agentMessage", itemId: "previous", threadId: "one", turnId: "active", text: "unchanged reply" };
bridge.eventLog.push(previous);
const notify = (method, params) => bridge._onNotification({ method, params: { threadId: "one", turnId: "active", ...params } });
const item = id => ({ id, type: "reasoning", summary: [], content: [] });
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], url = "http://127.0.0.1:" + server.address().port;
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "reasoning-fixture" })), { url });
  await page.routeWebSocket("**/ws?*", route => {
    socket = route;
    route.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === "listThreads") route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] }));
      if (message.type === "historyPage") route.send(JSON.stringify({ type: "historyPage", threadId: "one", events: [previous], nextCursor: null, requestId: message.requestId }));
    });
    route.send(JSON.stringify(bridge.snapshot()));
  });
  await page.goto(url);
  await page.waitForFunction(() => sessionReady && !pageRequest && historyFeed.events.length > 0);
  notify("item/started", { item: item("empty") });
  await page.locator('[data-item-id="empty"] summary').click();
  assert.equal(await page.locator('[data-item-id="empty"] .body').textContent(), "等待可展示的思考内容", "empty live reasoning needs an explicit waiting state rather than a blank panel");
  notify("item/completed", { item: item("empty") });
  await page.waitForFunction(() => historyFeed.events.find(e => e.itemId === "empty")?.live === false && !document.querySelector('[data-item-id="empty"]'));
  notify("item/started", { item: item("whitespace") });
  notify("item/completed", { item: { ...item("whitespace"), content: [" \n "] } });
  await page.waitForFunction(() => historyFeed.events.find(e => e.itemId === "whitespace")?.live === false);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('[data-item-id="whitespace"]').count(), 0, "whitespace-only completed reasoning is also empty");
  notify("item/started", { item: item("visible") });
  notify("item/reasoning/textDelta", { itemId: "visible", contentIndex: 0, delta: "provided content" });
  await page.locator('[data-item-id="visible"] summary').click();
  await page.waitForFunction(() => document.querySelector('[data-item-id="visible"] .body')?.textContent === "provided content");
  notify("item/reasoning/summaryTextDelta", { itemId: "visible", summaryIndex: 0, delta: "summary" });
  notify("item/reasoning/textDelta", { itemId: "visible", contentIndex: 0, delta: "must not mix" });
  notify("item/reasoning/summaryTextDelta", { itemId: "visible", summaryIndex: 0, delta: " continued" });
  await page.waitForFunction(() => document.querySelector('[data-item-id="visible"] .body')?.textContent === "summary continued");
  notify("item/completed", { item: item("visible") });
  await page.waitForFunction(() => document.querySelector('[data-item-id="visible"] .item-status')?.textContent === "已完成");
  assert.equal(await page.locator('[data-item-id="visible"] .body').textContent(), "summary continued");
  assert.equal(await page.locator('[data-item-id="visible"] details').getAttribute("open"), "");
  notify("item/started", { item: item("failed") });
  notify("item/completed", { item: { ...item("failed"), error: { message: "fixture error" } } });
  await page.locator('[data-item-id="failed"] summary').click();
  assert.equal(await page.locator('[data-item-id="failed"] .item-status').textContent(), "失败");
  assert.equal(await page.locator('[data-item-id="failed"] .tool-error').textContent(), "fixture error");
  await page.reload();
  await page.waitForFunction(() => sessionReady && !pageRequest && historyFeed.events.some(e => e.itemId === "visible"));
  assert.equal(await page.locator('[data-item-id="empty"]').count(), 0);
  await page.locator('[data-item-id="visible"] summary').click();
  assert.equal(await page.locator('[data-item-id="visible"] .body').textContent(), "summary continued");
  assert.deepEqual(errors, []);
  await fs.mkdir("dist-check/reasoning-ui", { recursive: true });
  await page.screenshot({ path: "dist-check/reasoning-ui/390-reasoning.png" });
  console.log("passed: reasoning waiting state, empty completion, content deltas, summary preference and reconnect; model prompts sent: 0");
  await context.close();
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
