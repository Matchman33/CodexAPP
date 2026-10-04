import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ModelSettings } from "../core/modelSettings.mjs";
import { pathToFileURL } from "node:url";

test("远程模型目录刷新读取新 URL 和数据，保留推理能力，失败保留上次列表", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-remote-models-"));
  const hits = []; let fail = false;
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (fail) { res.writeHead(503).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/first" ? { data: [{ id: "one" }, { id: "hidden", hidden: true }] } :
      { models: [{ slug: "two", display_name: "第二模型", supported_reasoning_levels: [{ effort: "high", description: "深度" }], default_reasoning_level: "high" }] }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, "config.toml"), base = "http://127.0.0.1:" + server.address().port;
  const write = url => fs.writeFileSync(file, 'model_provider = "test"\n[model_providers.test]\nmodel_catalog_url = "' + url + '"\n');
  write(base + "/first");
  const settings = new ModelSettings({ request: async method => method === "config/read" ? { config: { model_provider: "test", model: "one" } } : { data: [] } }, {}, undefined, { configFile: file });
  assert.deepEqual((await settings.list()).models.map(m => m.model), ["one"]);
  write(base + "/second");
  let result = await settings.list();
  assert.deepEqual(result.models.map(m => m.model), ["two"]);
  assert.equal(result.models[0].defaultReasoningEffort, "high");
  assert.equal(result.models[0].supportedReasoningEfforts[0].reasoningEffort, "high");
  fail = true; result = await settings.list();
  assert.equal(result.models[0].model, "two"); assert.match(result.error, /503/);
  assert.deepEqual(hits, ["/first", "/second", "/second"]);
});

test("远程目录凭据只发送给同源目录，不向异域和重定向泄露", async () => {
  let headers;
  const settings = new ModelSettings({ request: async method => method === "config/read" ? { config: {
    model_provider: "test", model: "custom", model_providers: { test: { base_url: "https://provider.example/v1", model_catalog_url: "https://catalog.example/models", experimental_bearer_token: "never-leak" } },
  } } : { data: [] } }, {}, undefined, { configFile: "missing-fixture.toml", fetch: async (_url, options) => {
    headers = options.headers; assert.equal(options.redirect, "error"); return new Response(JSON.stringify({ data: [{ id: "custom" }] }));
  } });
  const result = await settings.list(); assert.equal(result.models.length, 1);
  assert(!new Headers(headers).has("authorization"));
  assert(!JSON.stringify(result).includes("never-leak"));
});

test("requires_openai_auth 的同源目录沿用本机 API Key，结果不携带密钥", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-catalog-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ OPENAI_API_KEY: "fixture-private-key" }));
  const settings = new ModelSettings({ request: async method => method === "config/read" ? { config: {
    model_provider: "test", model: "custom", model_providers: { test: { base_url: "https://provider.example/v1", model_catalog_url: "https://provider.example/v1/models", requires_openai_auth: true } },
  } } : { data: [] } }, {}, undefined, { configFile: path.join(dir, "missing.toml"), authFile, fetch: async (_url, options) => {
    assert.equal(new Headers(options.headers).get("authorization"), "Bearer fixture-private-key");
    return new Response(JSON.stringify({ data: [{ id: "custom" }] }));
  } });
  const result = await settings.list(); assert.equal(result.models.length, 1); assert(!JSON.stringify(result).includes("fixture-private-key"));
});

test("本地 model_catalog_json 实时读取、切换路径、支持 file URL，失效保留上次目录", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-local-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "config.toml"), local = path.join(dir, "models.json");
  fs.writeFileSync(configFile, 'model_catalog_json = "models.json"\n');
  fs.writeFileSync(local, JSON.stringify({ models: [{ slug: "local-one", supported_reasoning_levels: [{ effort: "medium" }] }] }));
  const settings = new ModelSettings({ request: async method => method === "config/read" ? { config: { model: "local-one" } } : { data: [{ model: "stale" }] } }, {}, undefined, { configFile });
  assert.deepEqual((await settings.list()).models.map(m => m.model), ["local-one"]);
  fs.writeFileSync(local, JSON.stringify({ models: [{ slug: "local-two" }] }));
  assert.deepEqual((await settings.list()).models.map(m => m.model), ["local-two"]);
  fs.writeFileSync(configFile, 'model_catalog_json = "' + pathToFileURL(local).href + '"\n');
  assert.equal((await settings.list()).models[0].model, "local-two");
  fs.writeFileSync(configFile, 'model_catalog_json = "missing.json"\n');
  const missing = await settings.list(); assert.match(missing.error, /本地模型目录/); assert.equal(missing.models[0].model, "local-two");
});

test("未配置目录时每次刷新读取 Codex model/list，不复用旧缓存", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-native-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let version = 1;
  const settings = new ModelSettings({ request: async method => method === "config/read" ? { config: { model: "builtin" } } : { data: [{ model: "builtin-" + version }] } }, {}, undefined, { configFile: path.join(dir, "missing.toml") });
  assert.equal((await settings.list()).models[0].model, "builtin-1");
  version = 2; assert.equal((await settings.list()).models[0].model, "builtin-2");
});
