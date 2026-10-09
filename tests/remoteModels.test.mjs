import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelSettings } from "../core/modelSettings.mjs";

test("配置本地或远程目录时仍只使用 Codex model/list，不读取目录文件或凭据", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-native-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "config.toml");
  fs.writeFileSync(configFile, 'model_catalog_json = "missing.json"\n');
  for (const catalog of [{ model_catalog_json: "missing.json" }, {
    model_provider: "custom", model_providers: { custom: {
      model_catalog_url: "https://catalog.invalid/models", experimental_bearer_token: "fixture-secret",
    } },
  }]) {
    const settings = new ModelSettings({ request: async method => method === "config/read"
      ? { config: { ...catalog, model: "desktop-model" } }
      : { data: [{ model: "desktop-model", displayName: "桌面端模型", supportedReasoningEfforts: [{ reasoningEffort: "high" }], defaultReasoningEffort: "high" }] },
    }, {}, undefined, { configFile, fetch: () => { throw new Error("不应由项目请求目录"); } });
    const result = await settings.list();
    assert.deepEqual(result.models.map(m => m.model), ["desktop-model"]);
    assert.equal(result.models[0].defaultReasoningEffort, "high");
    assert.equal(result.models[0].supportedReasoningEfforts[0].reasoningEffort, "high");
    assert.equal(result.defaultModel, "desktop-model");
    assert.equal(result.error, null);
    assert(!JSON.stringify(result).includes("fixture-secret"));
  }
});

test("刷新模型列表重新调用 Codex，失败保留上次成功列表并报告错误", async () => {
  let version = 1, fail = false;
  const settings = new ModelSettings({ request: async method => {
    if (method === "config/read") return { config: { model: "custom-default" } };
    if (fail) throw new Error("Codex 目录暂时不可用");
    return { data: [{ model: "desktop-" + version }] };
  } }, {});
  assert.equal((await settings.list()).models[0].model, "desktop-1");
  version = 2;
  assert.equal((await settings.list()).models[0].model, "desktop-2");
  fail = true;
  const result = await settings.list();
  assert.equal(result.models[0].model, "desktop-2");
  assert.match(result.error, /Codex 目录暂时不可用/);
  assert.equal(result.defaultModel, "custom-default");
});
