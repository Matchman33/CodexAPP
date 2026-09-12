import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve("web"), output = path.resolve("dist-check/web-ui");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
await fs.mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 680 }, { width: 1280, height: 900 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage(), errors = [], sent = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let socket;
    const state = { codexConnected: true, threadId: "one", cwd: "D:/project", threadName: "优化手机端对话体验", status: "idle", model: "reasoner", effectiveModel: "reasoner", reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write" };
    const sample = "## 今天的改动\n\n已经添加 **思考等级选择**，接下来验证界面。\n\n- 模型配置同步\n- 会话与项目列表\n- 手机键盘适配\n\n~~~js\nconst effort = 'high';\n~~~\n\n<script>window.__unsafe = true</script><img src=x onerror=alert(1)>";
    const hello = (events = []) => ({ type: "hello", state: { ...state }, config: { ...state }, recentEvents: events });
    const initial = [{ id: "u", kind: "user", text: "帮我优化这个项目的手机聊天体验" }, { id: "a", kind: "item:agentMessage", text: sample }];
    await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "isolated-test" })), { url });
    await page.routeWebSocket("**/ws?*", (route) => {
      socket = route;
      route.onMessage((raw) => {
        const m = JSON.parse(raw); sent.push(m);
        if (m.type === "listThreads") route.send(JSON.stringify({ type: "projectTree", projects: [{ label: "CodexAPP", root: "D:/project", threads: [{ id: "one", name: state.threadName, updatedAt: 1789190000 }] }], projectless: [{ id: "two", name: "另一段对话" }] }));
        if (m.type === "listModels") route.send(JSON.stringify({ type: "models", defaultModel: "reasoner", defaultReasoningEffort: "medium", models: [{ model: "reasoner", displayName: "推理模型", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "max" }], defaultReasoningEffort: "medium" }, { model: "lite", displayName: "轻量模型", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }] }));
        if (m.type === "setConfig") { Object.assign(state, m); route.send(JSON.stringify({ type: "state", state })); route.send(JSON.stringify({ type: "configSaved", requestId: m.requestId })); }
        if (m.type === "readThread") { state.threadId = m.threadId; state.readOnly = true; route.send(JSON.stringify(hello([{ id: "other", kind: "item:agentMessage", text: "这是另一段对话" }]))); }
        if (m.type === "newThread") { state.threadId = "new"; state.readOnly = false; state.threadName = null; route.send(JSON.stringify(hello())); }
      });
      route.send(JSON.stringify(hello(initial)));
    });
    await page.goto(url);
    await page.locator(".entry.assistant h2").waitFor();
    assert.equal(await page.locator(".entry.assistant img, .entry.assistant script").count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    assert(await page.locator("#sendBtn").isDisabled());
    await page.locator("#input").fill("测试草稿");
    assert(!(await page.locator("#sendBtn").isDisabled()));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, viewport.width + "-chat.png") });
    await page.locator("#effortBtn").click();
    await page.locator('#cfgEffort option[value="max"]').waitFor({ state: "attached" });
    await page.locator("#cfgEffort").selectOption("max");
    await page.screenshot({ path: path.join(output, viewport.width + "-settings.png") });
    await page.locator("#cfgApply").click();
    await page.locator("#sheet").waitFor({ state: "hidden" });
    assert.equal(sent.findLast((m) => m.type === "setConfig").reasoningEffort, "max");
    assert.equal(await page.locator("#effortLabel").textContent(), "最高");
    await page.locator("#modelBtn").click();
    await page.locator("#cfgModel").selectOption("model:lite");
    assert.deepEqual(await page.locator("#cfgEffort option").evaluateAll((opts) => opts.map((o) => o.value)), ["", "low"]);
    assert.equal(await page.locator("#cfgEffort").inputValue(), "");
    await page.locator("#cfgTheme").selectOption("dark");
    await page.locator("#sheetClose").click();
    await page.screenshot({ path: path.join(output, viewport.width + "-dark.png") });
    if (viewport.width < 1024) await page.locator("#sessionsBtn").click();
    await page.locator("#sessionSearch").fill("另一段");
    await page.locator(".session-item").first().waitFor();
    assert.equal(await page.locator(".session-item").count(), 1);
    await page.screenshot({ path: path.join(output, viewport.width + "-sidebar.png") });
    await page.locator(".session-item").click();
    await page.locator(".entry.assistant .body").filter({ hasText: "这是另一段对话" }).waitFor();
    assert.equal(await page.locator(".entry").count(), 1);
    await page.locator("#quickNewThread").click();
    await page.locator("#emptyState").waitFor({ state: "visible" });
    assert.equal(await page.locator(".entry").count(), 0);
    const many = Array.from({ length: 100 }, (_, i) => ({ id: "long-" + i, kind: "item:agentMessage", text: "第 " + i + " 段长历史。\n\n" + "内容 ".repeat(30) }));
    socket.send(JSON.stringify(hello(many)));
    await page.locator(".entry").nth(99).waitFor();
    await page.locator("#feed").evaluate((f) => { f.scrollTop = 0; f.dispatchEvent(new Event("scroll")); });
    socket.send(JSON.stringify({ type: "assistantDelta", itemId: "live", text: "新消息" }));
    await page.locator('[data-item-id="live"]').waitFor();
    assert.equal(await page.locator("#feed").evaluate((f) => f.scrollTop), 0);
    await page.locator("#scrollBottom").click();
    assert(await page.locator("#feed").evaluate((f) => f.scrollTop > 0));
    socket.send(JSON.stringify({ type: "assistantDelta", itemId: "live", text: "，继续回复" }));
    await page.waitForFunction(() => document.querySelector('[data-item-id="live"] .body').textContent.includes("继续回复"));
    socket.send(JSON.stringify({ type: "event", event: { id: "complete", kind: "item:agentMessage", itemId: "live", text: "新消息，继续回复，完成。" } }));
    await page.waitForFunction(() => document.querySelector('[data-item-id="live"] .body').textContent.includes("完成"));
    assert.equal(await page.locator('[data-item-id="live"]').count(), 1);
    socket.send(JSON.stringify({ type: "approval", approval: { key: "approval-test", title: "运行命令 <img>", command: "npm test", options: [{ id: "allow", label: "批准", style: "primary" }, { id: "deny", label: "拒绝", style: "danger" }] } }));
    await page.locator(".approval-card").waitFor();
    assert.equal(await page.locator(".approval-card img").count(), 0);
    await page.locator(".approval-card button").filter({ hasText: "拒绝" }).click();
    assert.equal(sent.at(-1).optionId, "deny");
    socket.send(JSON.stringify({ type: "writerConflict", threadId: "external", message: "会话被占用", owners: [{ name: "Codex", pid: 999, canTerminate: false, affectedThreads: ["external"] }] }));
    await page.locator("#writerSheet").waitFor({ state: "visible" });
    await page.locator("#writerClose").click();
    socket.send(JSON.stringify({ type: "state", state: { ...state, status: "running" } }));
    await page.locator("#runningBar").waitFor({ state: "visible" });
    assert(await page.locator("#sendBtn").isDisabled());
    await page.locator("#interruptBtn").click();
    assert.equal(sent.at(-1).type, "interrupt");
    await page.locator("#steerMode").check();
    await page.locator("#input").fill("补充任务");
    await page.locator("#sendBtn").click();
    assert.equal(sent.at(-1).type, "steer");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(viewport.width + "px：配置、模型联动、会话搜索、历史切换、流式归并和安全渲染通过");
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
