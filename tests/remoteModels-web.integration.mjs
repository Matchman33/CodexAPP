import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";
import { ModelSettings } from "../core/modelSettings.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-models-web-"));
const configFile = path.join(dir, "config.toml"), root = path.resolve("web");
let version = 1, fail = false, browser;
const server = http.createServer(async (req, res) => {
  if (req.url === "/catalog") {
    if (fail) { res.writeHead(503).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "remote-" + version }] })); return;
  }
  try {
    const file = path.resolve(root, "." + (req.url === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const data = await fs.readFile(file);
    res.setHeader("content-type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".mjs": "text/javascript" })[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
const wss = new WebSocketServer({ server, path: "/ws" });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + server.address().port;
await fs.writeFile(configFile, 'model_provider = "fixture"\n[model_providers.fixture]\nmodel_catalog_url = "' + url + '/catalog"\n');
const models = new ModelSettings({ request: async method => method === "config/read" ? { config: { model: "remote-1", model_provider: "fixture" } } : { data: [] } }, {}, undefined, { configFile });
wss.on("connection", ws => {
  const state = { codexConnected: true, cwd: dir, status: "idle", model: null, approvalPolicy: "on-request", sandbox: "workspace-write" };
  ws.send(JSON.stringify({ type: "hello", state, config: state, recentEvents: [] }));
  ws.on("message", async raw => {
    const m = JSON.parse(raw);
    if (m.type === "listModels") ws.send(JSON.stringify(await models.list(dir)));
    if (m.type === "listThreads") ws.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] }));
  });
});
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "fixture" })), { url });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(url); await page.locator("#modelBtn").click();
  await page.locator('#cfgModel option[value="model:remote-1"]').waitFor({ state: "attached" });
  version = 2; await page.locator("#modelsRefresh").click();
  await page.locator('#cfgModel option[value="model:remote-2"]').waitFor({ state: "attached" });
  await page.locator("#cfgModel").selectOption("model:remote-2");
  const local = path.join(dir, "models.json");
  await fs.writeFile(local, JSON.stringify({ models: [{ slug: "local-one" }] }));
  await fs.writeFile(configFile, 'model_catalog_json = "models.json"\n');
  await page.locator("#modelsRefresh").click();
  await page.locator('#cfgModel option[value="model:local-one"]').waitFor({ state: "attached" });
  await fs.writeFile(local, JSON.stringify({ data: [{ id: "local-two" }] }));
  await page.locator("#modelsRefresh").click();
  await page.locator('#cfgModel option[value="model:local-two"]').waitFor({ state: "attached" });
  await page.locator("#cfgModel").selectOption("model:local-two");
  await fs.writeFile(local, "invalid json");
  await page.locator("#modelsRefresh").click();
  await page.waitForFunction(() => document.getElementById("modelsStatus").textContent.includes("JSON"));
  assert.equal(await page.locator("#cfgModel").inputValue(), "model:local-two");
  await fs.writeFile(configFile, 'model_provider = "fixture"\n[model_providers.fixture]\nmodel_catalog_url = "' + url + '/catalog"\n');
  await page.locator("#modelsRefresh").click();
  await page.locator('#cfgModel option[value="model:remote-2"]').waitFor({ state: "attached" });
  await page.locator("#cfgModel").selectOption("model:remote-2");
  fail = true; await page.locator("#modelsRefresh").click();
  await page.waitForFunction(() => document.getElementById("modelsStatus").textContent.includes("503"));
  assert.equal(await page.locator("#cfgModel").inputValue(), "model:remote-2");
  assert.equal(await page.locator("#modelsRefresh").isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log("PASS: 网页实际读取远程/本地模型、切换来源和刷新获取新模型、失败保留模型与选择；仅验证模型设置工作流");
} finally {
  await browser?.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}
