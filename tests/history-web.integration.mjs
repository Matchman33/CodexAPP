import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { HistoryPager } from "../core/historyPaging.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web"), output = path.resolve("dist-check/history-ui");
const text = ["## History", "", ...Array(120).fill("Paragraph **bold** with code."), ""].join(String.fromCharCode(10, 10));
const items = Array.from({ length: 2000 }, (_, i) => ({ id: "m" + i, type: "agentMessage", text: i === 1999 ? "long content ".repeat(10000) : text + i }));
const client = { request: async (method, p) => {
  if (method === "thread/read") return { thread: { id: p.threadId, name: p.threadId, cwd: "/fixture" } };
  if (method === "thread/turns/list") return { data: [{ id: "turn", items: [], startedAt: 1 }], nextCursor: null };
  if (method === "thread/items/list") {
    const start = Number(p.cursor || 0);
    return { data: items.slice().reverse().slice(start, start + p.limit).map(item => ({ item, turnId: "turn" })), nextCursor: start + p.limit < items.length ? String(start + p.limit) : null };
  }
  throw new Error("unexpected method " + method);
} };
const pager = new HistoryPager(client);
const hello = (p, requestId) => ({ type: "hello", requestId, state: { codexConnected: true, threadId: p.threadId, threadName: p.threadId, status: "idle", readOnly: true }, history: { paged: true, nextCursor: p.nextCursor }, recentEvents: p.events });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream"); res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
await fs.mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true, args: ["--host-resolver-rules=MAP history.codexapp.test 127.0.0.1", "--no-proxy-server"] });
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 1024, serviceWorkers: "block" });
    const page = await context.newPage(), errors = [], sent = [];
    let socket;
    page.on("pageerror", e => errors.push(e.message));
    // A non-loopback HTTP origin reproduces public-IP/NPS browser restrictions.
    const url = "http://history.codexapp.test:" + server.address().port;
    await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "isolated-history" })), { url });
    const initial = await pager.open("initial");
    await page.routeWebSocket("**/ws?*", route => {
      socket = route;
      route.onMessage(async raw => {
        const m = JSON.parse(raw); sent.push(m);
        if (m.type === "prompt") {
          const bridge = new CodexBridge({ defaultCwd: "/fixture", approvalPolicy: "on-request", sandbox: "read-only" }, message => route.send(JSON.stringify(message)));
          bridge.state.threadId = "second";
          bridge.history = { paged: true, nextCursor: null };
          bridge.models.resolve = async () => "fixture-model";
          bridge.models.resolveEffort = async () => null;
          bridge.codex.request = async (method, params) => {
            assert.equal(method, "turn/start");
            items.push({ id: "sent-user-" + width, type: "userMessage", content: [{ type: "text", text: params.input[0].text }] });
            return { turn: { id: "turn" } };
          };
          await bridge.dispatch(m);
          bridge._onNotification({ method: "turn/completed", params: { threadId: "second", turn: { id: "turn" } } });
        }
        if (m.type === "historyPage") route.send(JSON.stringify({ type: "historyPage", ...(await pager.page(m.threadId, m.cursor)), requestId: m.requestId }));
        if (m.type === "readHistoryItem") route.send(JSON.stringify({ type: "historyItem", ...(await pager.item(m.threadId, m.detailCursor, m.offset)), requestId: m.requestId }));
        if (m.type === "listThreads") route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: ["first", "second"].map(id => ({ id, name: id })) }));
        if (m.type === "readThread") {
          const response = hello(await pager.open(m.threadId), m.requestId);
          if (m.threadId === "first") setTimeout(() => { try { route.send(JSON.stringify(response)); } catch {} }, 150);
          else route.send(JSON.stringify(response));
        }
      });
      route.send(JSON.stringify(hello(initial)));
    });
    const start = performance.now();
    await page.goto(url);
    await page.locator('[data-item-id="m1999"]').waitFor();
    assert.equal(await page.evaluate(() => isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
    assert.deepEqual(errors, [], "HTTP history initialization must not require secure-context UUIDs");
    await page.waitForFunction(() => !pageRequest);
    const initialMs = Math.round(performance.now() - start);
    assert(await page.locator("#feed > .entry").count() <= 60);
    assert(await page.evaluate(() => historyFeed.events.length <= 150));
    const payloadBytes = Buffer.byteLength(JSON.stringify(hello(initial)));
    assert(payloadBytes < 400000);
    await page.locator('[data-item-id="m1999"]').getByRole("button", { name: "下一段内容", exact: true }).click();
    await page.waitForFunction(() => historyFeed.events.find(e => e.itemId === "m1999")?.textOffset === 8192);
    for (let index = 1; index <= 6; index++) {
      await page.locator("#historyOlder").click();
      await page.waitForFunction(index => oldestPage === index && !pageRequest, index);
      assert(await page.evaluate(() => pageCache.size <= 3 && historyFeed.events.length <= 250));
      assert(await page.locator("#feed > .entry").count() <= 60);
    }
    const beforeNewer = await page.evaluate(() => newestPage);
    await page.locator("#historyNewer").click();
    await page.waitForFunction(index => newestPage === index && !pageRequest, beforeNewer - 1);
    await page.evaluate(() => requestHistoryPage(0, true));
    await page.waitForFunction(() => newestPage === 0 && oldestPage === 0 && !pageRequest);
    await page.locator('[data-item-id="m1999"]').waitFor();
    if (width < 1024) {
      const touch = await context.newCDPSession(page);
      const box = await page.locator("#feed").boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.waitForTimeout(100);
      await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      for (const distance of [10, 20, 30, 40]) {
        await page.waitForTimeout(25);
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + distance }] });
      }
      await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(150);
      const state = await page.evaluate(() => ({ distance: $("feed").scrollHeight - $("feed").scrollTop - $("feed").clientHeight, follow: historyFeed.follow }));
      assert(state.distance >= 15 && !state.follow, "small touch drag must not snap back to the bottom: " + JSON.stringify(state));
      await touch.detach();
      await page.evaluate(() => requestHistoryPage(0, true));
      await page.waitForFunction(() => newestPage === 0 && oldestPage === 0 && !pageRequest);
    }
    await page.screenshot({ path: path.join(output, width + "-history.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width < 1024) await page.locator("#sessionsBtn").click();
    await page.locator('.session-item[data-thread-id="first"]').click();
    if (width < 1024) await page.locator("#sessionsBtn").click();
    await page.locator('.session-item[data-thread-id="second"]').click();
    await page.waitForFunction(() => appState.threadId === "second" && !pendingSelection);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(await page.locator("#threadTitle").textContent(), "second");
    assert(await page.evaluate(() => historyFeed.events.every(e => e.threadId === "second")));
    const feedBox = await page.locator("#feed").boundingBox();
    await page.mouse.move(feedBox.x + feedBox.width / 2, feedBox.y + feedBox.height / 2);
    await page.mouse.wheel(0, -40);
    await page.waitForTimeout(150);
    const scrolledUp = await page.evaluate(() => ({ distance: $("feed").scrollHeight - $("feed").scrollTop - $("feed").clientHeight, follow: historyFeed.follow }));
    assert(scrolledUp.distance >= 30 && !scrolledUp.follow, "small upward scroll after selecting a session must not snap back to the bottom: " + JSON.stringify(scrolledUp));
    for (const target of [1, 2]) {
      for (let step = 0; step < 100 && await page.evaluate(() => oldestPage) < target; step++) {
        await page.mouse.wheel(0, -2400);
        await page.waitForTimeout(25);
      }
      await page.waitForFunction(target => oldestPage === target && !pageRequest, target, { timeout: 3000 });
      assert(await page.evaluate(() => pageCache.size <= 3 && historyFeed.events.length <= 250));
    }
    await page.evaluate(() => requestHistoryPage(0, true));
    await page.waitForFunction(() => newestPage === 0 && oldestPage === 0 && !pageRequest);
    await page.locator('[data-item-id="m1999"]').waitFor();
    socket.send(JSON.stringify({ type: "assistantDelta", threadId: "initial", itemId: "wrong", text: "wrong conversation" }));
    socket.send(JSON.stringify({ type: "assistantDelta", threadId: "second", itemId: "stream", text: "streamed reply" }));
    await page.locator('[data-item-id="stream"]').waitFor();
    socket.send(JSON.stringify({ type: "event", event: { id: "second:turn:stream", threadId: "second", itemId: "stream", kind: "item:agentMessage", text: "streamed reply complete" } }));
    await page.waitForFunction(() => document.querySelector('[data-item-id="stream"] .body')?.textContent.trim() === "streamed reply complete");
    assert.equal(await page.locator('[data-item-id="stream"]').count(), 1);
    assert.equal(await page.locator('[data-item-id="wrong"]').count(), 0);
    socket.send(JSON.stringify({ type: "event", event: { threadId: "second", kind: "user", text: "HTTP event without a server ID" } }));
    await page.waitForFunction(() => historyFeed.events.some(e => e.text === "HTTP event without a server ID" && e.id));
    socket.send(JSON.stringify({ type: "assistantDelta", threadId: "second", text: "HTTP stream without an item ID" }));
    await page.waitForFunction(() => historyFeed.events.some(e => e.live && e.text === "HTTP stream without an item ID" && e.id));
    socket.send(JSON.stringify({ type: "event", event: { threadId: "second", kind: "item:agentMessage", text: "HTTP stream complete" } }));
    await page.waitForFunction(() => historyFeed.events.some(e => !e.live && e.text === "HTTP stream complete" && e.id));
    assert(await page.evaluate(() => new Set(historyFeed.events.map(e => e.id)).size === historyFeed.events.length));
    const promptText = "one submission must have one user bubble";
    await page.locator("#input").fill(promptText);
    await page.locator("#sendBtn").click();
    await page.waitForFunction(text => historyFeed.events.some(e => e.kind === "user" && e.text === text), promptText);
    await page.waitForFunction(() => appState.status === "idle");
    await page.evaluate(() => requestHistoryPage(0, true));
    await page.waitForFunction(() => !pageRequest);
    assert.equal(sent.filter(m => m.type === "prompt").length, 1, "the browser must only submit once");
    assert.equal(items.filter(item => item.id === "sent-user-" + width).length, 1, "the model backend must only receive one turn/start");
    assert.equal(await page.evaluate(text => historyFeed.events.filter(e => e.kind === "user" && e.text === text).length, promptText), 1, "live user echo and persisted history must not create two bubbles");
    assert.equal(await page.locator("#feed > .user .body").evaluateAll((bodies, text) => bodies.filter(body => body.textContent.trim() === text).length, promptText), 1);
    items.splice(items.findIndex(item => item.id === "sent-user-" + width), 1);
    const reconciliation = await page.evaluate(() => {
      const savedPages = new Map(pageCache), savedOverlay = new Map(recentOverlay);
      try {
        const user = { kind: "user", text: "same text", threadId: "second" };
        pageCache.clear(); recentOverlay.clear();
        pageCache.set(0, [{ ...user, id: "saved-one", itemId: "one", turnId: "one" }, { ...user, id: "saved-two", itemId: "two", turnId: "two" }]);
        recentOverlay.set("echo-one", { ...user, id: "echo-one", inputEcho: true, turnId: "one" });
        recentOverlay.set("echo-three", { ...user, id: "echo-three", inputEcho: true, turnId: "three" });
        showCachedHistory(true);
        const ids = historyFeed.events.map(e => e.id);
        pageCache.get(0)[0] = { ...pageCache.get(0)[0], text: "later content chunk", textOffset: 8192 };
        showCachedHistory(true);
        return { ids, retired: !recentOverlay.has("echo-one") && !historyFeed.events.some(e => e.id === "echo-one") };
      } finally {
        pageCache.clear(); recentOverlay.clear();
        for (const [key, value] of savedPages) pageCache.set(key, value);
        for (const [key, value] of savedOverlay) recentOverlay.set(key, value);
        showCachedHistory(true);
      }
    });
    assert.deepEqual(reconciliation.ids, ["saved-one", "saved-two", "echo-three"], "identical texts in different turns must remain distinct");
    assert(reconciliation.retired, "reconciled echoes must not reappear when opening another text chunk");
    assert.equal(sent.filter(m => m.type === "resumeThread").length, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, fixtureEvents: 2000, initialMs, payloadBytes, renderedRows: await page.locator("#feed > .entry").count(), cachedEvents: await page.evaluate(() => historyFeed.events.length), passed: "paging, eviction, detail chunks, stale selections, streaming" }));
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}
