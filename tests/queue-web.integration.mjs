import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web"), output = path.resolve("dist-check/queue-ui");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream"); res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  for (const width of [320, 390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(), errors = [], sent = [], turns = [];
    let socket, hold = false, held = [], accepted;
    const bridge = new CodexBridge({ defaultCwd: "/fixture", approvalPolicy: "on-request", sandbox: "read-only" }, message => {
      if (hold && ["promptQueue", "promptAccepted"].includes(message.type)) { held.push(message); if (message.type === "promptAccepted") accepted?.(); }
      else socket?.send(JSON.stringify(message));
    });
    Object.assign(bridge.state, { codexConnected: true, threadId: "one", status: "running", turnId: "existing" });
    bridge.history = { paged: true, nextCursor: null };
    bridge.models.resolve = async () => "fixture-model"; bridge.models.resolveEffort = async () => null;
    bridge.models.list = async () => ({ type: "models", models: [] });
    bridge.codex.request = async (method, params) => {
      if (method === "turn/start") {
        const turn = { id: "turn-" + (turns.length + 1), status: "inProgress" }; turns.push({ turn, text: params.input[0].text, threadId: params.threadId });
        bridge._onNotification({ method: "turn/started", params: { threadId: "one", turn } }); return { turn };
      }
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      if (method === "turn/interrupt") return {};
      throw new Error("Unexpected fixture request: " + method);
    };
    page.on("pageerror", error => errors.push(error.message));
    const url = "http://127.0.0.1:" + server.address().port;
    await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "queue-fixture" })), { url });
    await page.routeWebSocket("**/ws?*", route => {
      socket = route; route.send(JSON.stringify(bridge.snapshot()));
      route.onMessage(async raw => {
        const message = JSON.parse(raw); sent.push(message);
        if (message.type === "listThreads") { route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [{ id: "one", name: "queue fixture" }] })); return; }
        try { await bridge.dispatch(message); } catch (error) { route.send(JSON.stringify({ type: "error", message: error.message, requestId: message.requestId })); }
      });
    });
    await page.goto(url);
    await page.waitForFunction(() => sessionReady && appState.status === "running");
    hold = true; const acknowledgement = new Promise(resolve => { accepted = resolve; });
    await page.locator("#input").fill("first queued message");
    assert.equal(await page.locator("#sendBtn").isDisabled(), false, "running tasks must allow queued sends");
    await page.locator("#sendBtn").click(); await acknowledgement;
    assert.equal(await page.locator("#input").inputValue(), "first queued message", "draft stays until acceptance arrives");
    assert(await page.locator("#sendBtn").isDisabled());
    hold = false; for (const message of held) socket.send(JSON.stringify(message)); held = [];
    await page.waitForFunction(() => $("input").value === "");
    await page.locator("#queueList li").first().waitFor();
    assert.equal(turns.length, 0);
    await page.locator("#input").fill("second queued message"); await page.locator("#sendBtn").click();
    await page.waitForFunction(() => promptQueueState.items.length === 2);
    await page.screenshot({ path: path.join(output, width + "-pending.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const firstRequest = sent.find(message => message.type === "enqueuePrompt");
    await bridge.dispatch(firstRequest); assert.equal(bridge.snapshot().promptQueue.items.length, 2);
    await page.reload();
    await page.waitForFunction(() => sessionReady && promptQueueState?.items.length === 2);
    assert.equal(turns.length, 0, "refreshing the page must preserve pending backend messages");
    bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "existing", status: "completed" } } });
    await bridge.commandQueue; await page.waitForFunction(() => promptQueueState.items.length === 1);
    assert.deepEqual(turns.map(item => item.text), ["first queued message"]);
    assert.equal(await page.locator("#feed > .user .body").evaluateAll(bodies => bodies.filter(body => body.textContent === "first queued message").length), 1);
    await page.locator("#input").fill("cancel this message"); await page.locator("#sendBtn").click();
    await page.waitForFunction(() => promptQueueState.items.length === 2);
    await page.locator("#queueList li").last().getByRole("button", { name: "取消排队消息" }).click();
    await page.waitForFunction(() => promptQueueState.items.length === 1);
    await page.locator("#interruptBtn").click();
    await page.waitForFunction(() => promptQueueState.paused);
    await page.screenshot({ path: path.join(output, width + "-paused.png") });
    bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "turn-1", status: "interrupted" } } });
    await bridge.commandQueue; assert.equal(turns.length, 1);
    await page.getByRole("button", { name: "继续队列", exact: true }).click();
    await page.waitForFunction(() => appState.status === "running" && promptQueueState.items.length === 0);
    assert.deepEqual(turns.map(item => item.text), ["first queued message", "second queued message"]);
    assert(turns.every(item => item.threadId === "one"));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, width + "-queue.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log(JSON.stringify({ width, passed: "acceptance, FIFO, duplicate requests, refresh, cancel, stop and resume", modelPromptsSent: 0 }));
    await context.close();
  }
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
