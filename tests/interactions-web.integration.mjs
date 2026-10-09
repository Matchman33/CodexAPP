import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web"), errors = [], replies = [];
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(root, "." + (new URL(req.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser, socket;
const bridge = new CodexBridge({ defaultCwd: os.tmpdir() }, message => socket?.send(JSON.stringify(message)));
Object.assign(bridge.state, { threadId: "one", turnId: "turn", status: "running", codexConnected: true });
bridge.codex.respond = (id, result) => replies.push({ id, result: JSON.parse(JSON.stringify(result)) });
bridge.codex.respondError = (id, code, message) => replies.push({ id, code, message });
bridge.models.list = async () => ({ type: "models", models: [], defaultModel: null });
function ask(id, method, params) { bridge._onServerRequest({ id, method, params: { threadId: "one", turnId: "turn", ...params } }); }
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
    route.send(JSON.stringify(bridge.snapshot()));
  });
  await page.goto(url); await page.waitForFunction(() => sessionReady);
  ask(1, "item/tool/requestUserInput", { itemId: "ask", questions: [{ id: "q", header: "方案", question: "选择方案", isOther: true, options: [{ label: "方案 A", description: "默认方式" }] }, { id: "s", header: "密钥", question: "输入密钥", isSecret: true, options: null }] });
  await page.waitForFunction(() => document.querySelector(".interaction-form"));
  assert.equal(replies.length, 0, "展示问题不能自动选择答案");
  await page.reload(); await page.waitForFunction(() => sessionReady && document.querySelector(".interaction-form"));
  await page.getByLabel("方案 A", { exact: false }).check();
  await page.getByLabel("输入密钥", { exact: true }).fill(" secret-fixture ");
  assert.equal(await page.getByLabel("输入密钥", { exact: true }).getAttribute("type"), "password");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".interaction-form"));
  assert.deepEqual(replies[0], { id: 1, result: { answers: { q: { answers: ["方案 A"] }, s: { answers: [" secret-fixture "] } } } });
  assert(!(await page.locator("#feed").textContent()).includes("secret-fixture"));
  ask(2, "mcpServer/elicitation/request", { mode: "form", serverName: "fixture", message: "表单", requestedSchema: { type: "object", properties: { count: { type: "integer", title: "数量", minimum: 1, maximum: 3 }, mode: { type: "string", title: "模式", enum: ["fast", "safe"] }, enabled: { type: "boolean", title: "启用" } }, required: ["count", "mode", "enabled"] } });
  await page.getByLabel("数量", { exact: true }).fill("2");
  await page.getByLabel("模式", { exact: true }).selectOption("safe");
  await page.getByLabel("启用", { exact: true }).selectOption("true");
  await page.getByLabel("模式", { exact: true }).evaluate(select => { select.append(new Option("无效", "invalid")); select.value = "invalid"; });
  await page.getByRole("button", { name: "提交表单", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".interaction-status")?.textContent.includes("mode"));
  assert.equal(replies.length, 1, "无效答案不能消耗待回答请求");
  await page.getByLabel("模式", { exact: true }).selectOption("safe");
  await page.getByRole("button", { name: "提交表单", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".interaction-form"));
  assert.deepEqual(replies[1].result, { action: "accept", content: { count: 2, mode: "safe", enabled: true }, _meta: null });
  ask(3, "mcpServer/elicitation/request", { mode: "url", serverName: "fixture", message: "授权", url: "https://example.com/auth", elicitationId: "auth" });
  const link = page.getByRole("link", { name: "打开授权页面" });
  assert.equal(await link.getAttribute("href"), "https://example.com/auth");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".interaction-form"));
  assert.equal(replies[2].result.action, "cancel");
  ask(5, "item/tool/requestUserInput", { questions: [{ id: "late", question: "过期问题", options: null }] });
  await page.waitForFunction(() => document.querySelector(".interaction-form"));
  bridge._onNotification({ method: "serverRequest/resolved", params: { requestId: 5 } });
  await page.waitForFunction(() => !document.querySelector(".interaction-form"));
  assert.equal(replies.length, 3, "服务器自行解决的问题不自动回复");
  ask(4, "item/commandExecution/requestApproval", { command: "echo fixture", cwd: os.tmpdir() });
  await page.locator(".approval-card button").filter({ hasText: "拒绝" }).click();
  assert.deepEqual(replies[3], { id: 4, result: { decision: "decline" } });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log("passed: 提问重连、选择题、私密输入、MCP 表单、授权链接、既有审批；未调用模型");
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
