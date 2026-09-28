import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { newKeyPair, seal, open } from "../cloud/e2e.mjs";

const origin = "http://multi-agent.test", root = path.resolve("web");
const a = { id: "a".repeat(64), name: "办公电脑", keys: newKeyPair() }, b = { id: "b".repeat(64), name: "家里电脑", keys: newKeyPair() };
let online = [a, b], logins = 0;
const descriptor = agent => ({ id: agent.id, name: agent.name, pubkey: agent.keys.publicKey });
const browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.addInitScript(() => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "cloud", email: "fixture@example.com", password: "fixture-password" })));
  await context.addInitScript(() => {
    // 模拟手机页面刷新后无法恢复所选电脑的会话存储。
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (this === sessionStorage && key.startsWith("codexapp.agent.")) return null;
      return get.call(this, key);
    };
    window.documentMarker = Math.random();
  });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/api/login") { logins++; return route.fulfill({ json: { token: "fixture" } }); }
    if (url.pathname === "/health") return route.fulfill({ json: { ok: true, rooms: 1 } });
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) return route.abort();
    try { await route.fulfill({ contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream", body: await fs.readFile(file) }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  });
  const sockets = [], errors = [], commands = [];
  await context.routeWebSocket("**/link", socket => {
    const record = { socket }; sockets.push(record);
    socket.onMessage(raw => {
      const m = JSON.parse(raw);
      if (m.type === "auth") {
        record.id = m.agentId; record.pubkey = m.pubkey;
        const agent = online.find(agent => agent.id === m.agentId);
        socket.send(JSON.stringify({ type: "authed", multiAgent: true, agents: online.map(descriptor), agentId: m.agentId, peerOnline: !!agent, peerPubkey: agent?.keys.publicKey }));
        if (agent) socket.send(JSON.stringify({ type: "e2e", agentId: agent.id, ...seal({ type: "hello", multiSession: { supported: true }, state: { threadId: "same", cwd: "/" + agent.name, status: "idle", codexConnected: true }, recentEvents: [{ id: "same-event", kind: "item:agentMessage", threadId: "same", text: agent.name + "的历史" }], sessions: [] }, m.pubkey, agent.keys.secretKey) }));
      } else if (m.type === "e2e") {
        const agent = [a,b].find(agent => agent.id === record.id);
        commands.push({ id: record.id, message: open(m, record.pubkey, agent.keys.secretKey) });
      }
    });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator("#cloudAgentSelect option").filter({ hasText: a.name }).waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => sessionReady), false);
  const documentMarker = await page.evaluate(() => window.documentMarker);
  await page.locator("#cloudAgentSelect").selectOption(a.id);
  await page.waitForFunction(() => typeof sessionReady !== "undefined" && sessionReady && historyFeed.events[0]?.text === "办公电脑的历史", null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.documentMarker), documentMarker, "选择电脑不能刷新页面");
  assert.equal(logins, 1, "选择电脑复用有效登录令牌");
  await page.locator("#input").fill("draft");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#cloudAgentSelect").selectOption(b.id);
  assert.equal(await page.locator("#cloudAgentSelect").inputValue(), a.id);
  await page.locator("#input").fill("");
  await page.evaluate(() => {
    window.staleCloudMessage = ws.onmessage;
    deletedThreads.add("same");
    sessionViews.set("other", { text: "", images: [] });
    fileDownloads.cached = { file: { id: "old-file" }, url: URL.createObjectURL(new Blob(["old data"])) };
    fileDownloads.messages.set("old-file", "old feedback");
    webTerminal.mount(); webTerminal.id = "old-terminal"; webTerminal.lease = "old-lease";
    webTerminal.term.write("old terminal output");
    document.getElementById("terminalPanel").classList.remove("hidden");
  });
  await page.locator("#cloudAgentSelect").selectOption(b.id);
  await page.waitForFunction(() => sessionReady && historyFeed.events[0]?.text === "家里电脑的历史");
  assert.equal(await page.evaluate(() => window.documentMarker), documentMarker);
  assert.deepEqual(await page.evaluate(() => ({ terminal: webTerminal.id, mounted: !!webTerminal.term, file: fileDownloads.cached, messages: fileDownloads.messages.size, views: sessionViews.size, deleted: deletedThreads.size })),
    { terminal: null, mounted: false, file: null, messages: 0, views: 0, deleted: 0 });
  assert.equal(await page.locator("#terminalPanel").isVisible(), false);
  await page.evaluate(() => window.staleCloudMessage({ data: JSON.stringify({ type: "agents", agents: [], agentId: null }) }));
  assert.equal(await page.locator("#cloudAgentSelect").inputValue(), b.id, "旧连接通知不能清空目标电脑");
  assert.equal(await page.locator("#feed").getByText("办公电脑的历史").count(), 0);
  assert.equal(logins, 1);
  const keyB = await page.evaluate(() => viewKey());
  assert(keyB.includes(b.id));
  await page.evaluate(() => sendWs({ type: "getState", requestId: "only-b" }));
  assert(commands.some(c => c.id === b.id && c.message?.requestId === "only-b"));
  assert(!commands.some(c => c.message?.type === "terminalAttach"), "切换时不自动连接另一台电脑的终端");
  const active = sockets.at(-1); online = [a];
  active.socket.send(JSON.stringify({ type: "peer", online: false, agentId: b.id }));
  active.socket.send(JSON.stringify({ type: "agents", agents: online.map(descriptor), agentId: b.id }));
  await page.waitForFunction(() => !sessionReady);
  assert.equal(await page.locator("#cloudAgentSelect").inputValue(), b.id);
  assert.equal(await page.evaluate(() => sendWs({ type: "prompt", text: "must not send" })), false);
  await fs.mkdir("dist-check/multi-agent", { recursive: true });
  await page.screenshot({ path: "dist-check/multi-agent/mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  online = [a, b];
  const second = await context.newPage(); second.on("pageerror", error => errors.push(error.message));
  await second.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"]) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(...args) {
        if (this === sessionStorage) throw new DOMException("Session storage disabled", "SecurityError");
        return original.apply(this, args);
      };
    }
  });
  await second.goto(origin);
  await second.locator("#cloudAgentSelect option").filter({ hasText: a.name }).waitFor({ state: "attached" });
  await second.locator("#cloudAgentSelect").selectOption(a.id);
  await second.waitForFunction(() => sessionReady && historyFeed.events[0]?.text === "办公电脑的历史");
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await second.waitForFunction(() => sessionReady && historyFeed.events[0]?.text === "办公电脑的历史");
  assert.equal(await page.locator("#cloudAgentSelect").inputValue(), b.id, "第二个标签选择电脑不能改变第一个标签");
  assert.equal(await page.evaluate(() => sessionReady), false);
  assert.deepEqual(errors, []);
  console.log("PASS: mobile device switching without reload, lost/blocked session storage, target state cleanup, stale messages, reconnect, offline target and draft confirmation.");
} finally { await browser.close(); }
