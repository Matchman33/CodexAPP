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
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [];
  const url = "http://127.0.0.1:" + server.address().port;
  page.on("pageerror", error => errors.push(error.message));
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "order-fixture" })), { url });
  const canonical = [{ id: "one:old:previous", kind: "item:agentMessage", itemId: "previous", threadId: "one", turnId: "old", text: "previous reply" }];
  let socket;
  await page.routeWebSocket("**/ws?*", route => {
    socket = route;
    route.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === "listThreads") route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] }));
      if (message.type === "historyPage") route.send(JSON.stringify({ type: "historyPage", threadId: "one", events: canonical, nextCursor: null, requestId: message.requestId }));
    });
    route.send(JSON.stringify({ type: "hello", state: { threadId: "one", turnId: "active", status: "running", codexConnected: true }, history: { paged: true, nextCursor: null }, recentEvents: canonical }));
  });
  await page.goto(url);
  await page.waitForFunction(() => sessionReady && historyFeed.events.length > 0 && !pageRequest);
  const bridge = new CodexBridge({}, message => socket.send(JSON.stringify(message)));
  Object.assign(bridge.state, { threadId: "one", turnId: "active", status: "running" });
  bridge.history = { paged: true, nextCursor: null };
  const notify = (method, params) => bridge._onNotification({ method, params: { threadId: "one", turnId: "active", ...params } });
  bridge._pushEvent({ id: "echo", kind: "user", text: "new prompt", turnId: "active", inputEcho: true });
  notify("turn/started", { turn: { id: "active" } });
  notify("item/started", { item: { id: "reply", type: "agentMessage", text: "" } });
  await page.waitForFunction(() => historyFeed.events.some(e => e.itemId === "reply"));
  assert.equal(await page.locator('[data-item-id="reply"]').count(), 0, "empty starts reserve order without showing an empty reply bubble");
  notify("item/started", { item: { id: "command", type: "commandExecution", command: "fixture", status: "inProgress" } });
  notify("item/agentMessage/delta", { itemId: "reply", delta: "reply before tool" });
  await page.waitForFunction(() => historyFeed.events.find(e => e.itemId === "reply")?.text === "reply before tool");
  await page.evaluate(() => requestHistoryPage(0, true));
  await page.waitForFunction(() => !pageRequest);
  assert.deepEqual(await page.evaluate(() => historyFeed.events.filter(e => e.itemId && e.turnId === "active").map(e => e.itemId)), ["reply", "command"], "stale history received during streaming must preserve live order");
  notify("item/completed", { item: { id: "command", type: "commandExecution", command: "fixture", aggregatedOutput: "output", status: "completed", exitCode: 0 } });
  notify("item/completed", { item: { id: "reply", type: "agentMessage", text: "reply before tool" } });
  notify("item/completed", { item: { id: "final", type: "agentMessage", text: "final reply" } });
  notify("turn/completed", { turn: { id: "active", status: "completed" } });
  await page.waitForFunction(() => historyFeed.events.some(e => e.itemId === "final") && appState.status === "idle");
  const itemOrder = () => page.evaluate(() => historyFeed.events.filter(e => e.turnId === "active" && e.itemId && e.kind !== "user").map(e => e.itemId));
  assert.deepEqual(await itemOrder(), ["reply", "command", "final"], "live item order must match persisted item order even when the first reply delta arrives after a tool start");
  canonical.push(
    { id: "one:active:user", kind: "user", itemId: "user", threadId: "one", turnId: "active", text: "new prompt" },
    ...["reply", "command", "final"].map(itemId => bridge.eventLog.find(e => e.itemId === itemId))
  );
  const before = await page.evaluate(() => historyFeed.events.map(e => e.inputEcho ? "user" : e.itemId || e.text));
  await page.evaluate(() => requestHistoryPage(0, true));
  await page.waitForFunction(() => !pageRequest && historyFeed.events.some(e => e.itemId === "user"));
  const after = await page.evaluate(() => historyFeed.events.map(e => e.kind === "user" ? "user" : e.itemId || e.text));
  assert.deepEqual(after, before, "canonical history must replace the echo in place without moving task markers after replies");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.locator('#feed > .entry[data-item-id]:not([data-item-id=""])').evaluateAll(rows => rows.map(row => row.dataset.itemId)), ["previous", "user", "reply", "command", "final"], "DOM order must agree with the reconciled feed");
  canonical.shift();
  for (let index = 0; index < 2; index++) {
    await page.evaluate(() => requestHistoryPage(0, true));
    await page.waitForFunction(() => !pageRequest);
    assert.deepEqual(await page.evaluate(() => historyFeed.events.map(e => e.kind === "user" ? "user" : e.itemId || e.text)), before, "a page beginning in a newer turn must retain the old overlay before that turn, including repeated reads");
  }
  assert.deepEqual(errors, []);
  bridge._pushEvent({ id: "next-echo", kind: "user", text: "new prompt", turnId: "next", inputEcho: true });
  await page.waitForFunction(() => historyFeed.events.some(e => e.id === "next-echo"));
  assert.equal(await page.evaluate(() => historyFeed.events.filter(e => e.kind === "user" && e.text === "new prompt").length), 2, "identical prompts from different turns must remain separate");
  console.log("passed: live item creation order and stable history reconciliation; model prompts sent: 0");
  await context.close();
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
