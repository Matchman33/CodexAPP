import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web"), output = path.resolve("dist-check/stream-ui");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const width = Number(process.env.CODEXAPP_TEST_WIDTH || 390);
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [];
  const url = "http://127.0.0.1:" + server.address().port;
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "stream-fixture" })), { url });
  let socket, backend;
  const persisted = [];
  await page.routeWebSocket("**/ws?*", route => {
    socket = route;
    route.onMessage(async raw => {
      const message = JSON.parse(raw);
      if (message.type === "listThreads") route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] }));
      if (message.type === "historyPage") route.send(JSON.stringify({ type: "historyPage", threadId: "one", events: [{ id: "one:active:previous", kind: "item:agentMessage", itemId: "previous", threadId: "one", turnId: "active", text: "unchanged reply" }], nextCursor: null, requestId: message.requestId }));
      if (message.type === "readHistoryItem" && backend) route.send(JSON.stringify({ type: "historyItem", ...(await backend.historyPager.item(message.threadId, message.detailCursor, message.offset)), requestId: message.requestId }));
    });
    route.send(JSON.stringify({ type: "hello", state: { threadId: "one", turnId: "active", status: "running", codexConnected: true }, history: { paged: true, nextCursor: null }, recentEvents: [{ id: "one:active:previous", kind: "item:agentMessage", itemId: "previous", threadId: "one", turnId: "active", text: "unchanged reply" }] }));
  });
  await page.goto(url);
  await page.waitForFunction(() => sessionReady && historyFeed.events.length > 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const rendering = await page.evaluate(async () => {
    let renders = 0, removals = 0;
    const original = historyFeed.render.bind(historyFeed);
    historyFeed.render = () => { renders++; original(); };
    const row = document.querySelector('[data-item-id="previous"]');
    const observer = new MutationObserver(records => { for (const record of records) for (const node of record.removedNodes) if (node === row) removals++; });
    observer.observe($("feed"), { childList: true });
    for (let i = 0; i < 100; i++) handle({ type: "assistantDelta", threadId: "one", turnId: "active", itemId: "stream", text: "part " });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    observer.disconnect(); historyFeed.render = original;
    return { renders, removals, text: document.querySelector('[data-item-id="stream"] .body')?.textContent };
  });
  assert(rendering.renders <= 3, "stream bursts should be batched into frames: " + JSON.stringify(rendering));
  assert.equal(rendering.removals, 0, "unchanged visible rows should not be detached");
  assert.equal(rendering.text, "part ".repeat(100));
  const bridge = new CodexBridge({}, message => socket.send(JSON.stringify(message)));
  backend = bridge;
  bridge.codex.request = async method => {
    assert.equal(method, "thread/items/list"); return { data: persisted, nextCursor: null };
  };
  Object.assign(bridge.state, { threadId: "one", turnId: "active", status: "running" }); bridge.history = { paged: true, nextCursor: null };
  const notify = (method, params) => bridge._onNotification({ method, params: { threadId: "one", turnId: "active", ...params } });
  notify("item/started", { item: { id: "command", type: "commandExecution", command: "fixture --test", status: "inProgress" } });
  notify("item/commandExecution/outputDelta", { itemId: "command", delta: "live command output" });
  await page.locator('[data-item-id="command"] .item-status').waitFor();
  assert.equal(await page.locator('[data-item-id="command"] .item-status').textContent(), "执行中");
  await page.locator('[data-item-id="command"] summary').click();
  await page.waitForFunction(() => document.querySelector('[data-item-id="command"] .body')?.textContent === "live command output");
  notify("item/completed", { item: { id: "command", type: "commandExecution", command: "fixture --test", aggregatedOutput: "live command output", exitCode: 1, status: "failed" } });
  await page.waitForFunction(() => document.querySelector('[data-item-id="command"] .item-status')?.textContent.includes("失败"));
  assert.equal(await page.locator('[data-item-id="command"]').count(), 1);
  assert.equal(await page.locator('[data-item-id="command"] details').getAttribute("open"), "");
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, width + "-tools.png") });
  notify("item/started", { item: { id: "long", type: "agentMessage", text: "" } });
  notify("item/agentMessage/delta", { itemId: "long", delta: "HEAD-" + "x".repeat(12000) });
  notify("item/agentMessage/delta", { itemId: "long", delta: "-LATEST" });
  await page.waitForFunction(() => document.querySelector('[data-item-id="long"] .body')?.textContent.endsWith("-LATEST"));
  const preview = await page.locator('[data-item-id="long"] .body').textContent();
  assert.equal(preview.length, 8192);
  await page.locator('[data-item-id="long"]').getByRole("button", { name: "查看开头", exact: true }).click();
  assert((await page.locator('[data-item-id="long"] .body').textContent()).startsWith("HEAD-"));
  notify("item/agentMessage/delta", { itemId: "long", delta: "-NEW" });
  await page.waitForFunction(() => document.querySelector('[data-item-id="long"] .history-content-nav')?.textContent.includes("12016"));
  assert((await page.locator('[data-item-id="long"] .body').textContent()).startsWith("HEAD-"));
  await page.locator('[data-item-id="long"]').getByRole("button", { name: "查看最新", exact: true }).click();
  assert((await page.locator('[data-item-id="long"] .body').textContent()).endsWith("-NEW"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scroll = await page.evaluate(async () => {
    $("feed").scrollTop -= 40;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { y: $("feed").scrollTop, follow: followLatest };
  });
  assert.equal(scroll.follow, false);
  notify("item/agentMessage/delta", { itemId: "long", delta: "-READING" });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(Math.abs((await page.locator("#feed").evaluate(feed => feed.scrollTop)) - scroll.y) <= 3, "streaming must not pull readers back to the bottom");
  const full = "HEAD-" + "x".repeat(12000) + "-LATEST-NEW-READING";
  persisted.push({ id: "long", type: "agentMessage", text: full });
  notify("item/completed", { item: persisted[0] });
  await page.waitForFunction(() => !historyFeed.events.find(e => e.itemId === "long")?.live);
  await page.locator('[data-item-id="long"]').getByRole("button", { name: "查看开头", exact: true }).click();
  await page.waitForFunction(() => historyFeed.events.find(e => e.itemId === "long")?.textOffset === 0);
  assert((await page.locator('[data-item-id="long"] .body').textContent()).startsWith("HEAD-"));
  await page.locator('[data-item-id="long"]').getByRole("button", { name: "查看最新", exact: true }).click();
  await page.waitForFunction(() => historyFeed.events.find(e => e.itemId === "long")?.text.endsWith("-READING"));
  assert.deepEqual(errors, []);
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, width + "-stream.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log(JSON.stringify({ width, renders: rendering.renders, unchangedRowRemovals: rendering.removals, passed: "batching, tool lifecycle, long previews, history segments and reading position", modelPromptsSent: 0 }));
  await context.close();
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
