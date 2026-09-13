import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelSettings, normalizeModel, persistModel } from "../core/modelSettings.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";

test("model IDs support provider aliases and an explicit default", () => {
  assert.equal(normalizeModel(" provider/custom-model "), "provider/custom-model");
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel("  "), null);
  for (const value of [undefined, 1, {}, [], "two models", "model\nname", "a".repeat(201)]) {
    assert.throws(() => normalizeModel(value));
  }
});

test("catalog follows pagination, deduplicates IDs and filters hidden models", async () => {
  const calls = [];
  const models = new ModelSettings({ request: async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ model: "b", displayName: "B" }, { model: "a" }] } : {
      data: [{ model: "a", isDefault: true }, { model: "hidden", hidden: true }, { id: "invalid" }], nextCursor: "next",
    };
  } }, {});
  assert.deepEqual((await models.catalog()).map((m) => m.model), ["a", "b"]);
  assert.equal(calls[1].params.cursor, "next");
  assert.equal(calls[0].params.includeHidden, false);
});

test("repeated pagination cursors fail instead of looping forever", async () => {
  const models = new ModelSettings({ request: async () => ({ data: [], nextCursor: "same" }) }, {});
  await assert.rejects(models.catalog(), /cursor/);
});

test("a provider-specific configured default need not exist in the catalog", async () => {
  const models = new ModelSettings({ request: async (method, params) => {
    assert.equal(method, "config/read");
    assert.equal(params.cwd, "project");
    return { config: { model: "private-provider/alias" } };
  } }, { model: null });
  assert.equal(await models.resolve("project"), "private-provider/alias");
});

test("built-in catalog default is used when config has no explicit model", async () => {
  const models = new ModelSettings({ request: async (method) => method === "config/read" ? { config: {} } : { data: [{ model: "builtin", isDefault: true }] } }, {});
  assert.equal(await models.resolve("project"), "builtin");
});

test("explicit custom models remain usable when discovery is unsupported", async () => {
  const models = new ModelSettings({ request: async () => { throw new Error("unsupported"); } }, { model: "custom" });
  assert.equal(await models.resolve("project"), "custom");
  const list = await models.list("project");
  assert.deepEqual(list.models, []);
  assert.match(list.error, /unsupported/);
});

test("discovery failures preserve a successfully read configured default", async () => {
  const models = new ModelSettings({ request: async (method) => {
    if (method === "model/list") throw new Error("catalog unavailable");
    return { config: { model: "configured" } };
  } }, {});
  const result = await models.list("project");
  assert.equal(result.defaultModel, "configured");
  assert.match(result.error, /catalog unavailable/);
});

test("unresolved default does not silently reuse a previous override", async () => {
  const models = new ModelSettings({ request: async (method) => method === "config/read" ? { config: {} } : { data: [] } }, {});
  await assert.rejects(models.resolve("project"), /Cannot resolve/);
});

test("discovery requests time out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const models = new ModelSettings({ request: () => new Promise(() => {}) }, {});
  const result = assert.rejects(models.request("model/list", {}), /timed out/);
  t.mock.timers.tick(8000);
  await result;
});

test("persistence preserves unrelated fields and survives reload, including null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-model-test-"));
  const file = path.join(dir, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ token: "test-secret", other: { value: true }, model: null }));
    const settings = new ModelSettings({}, {}, (model) => persistModel(file, model));
    settings.select("custom");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(stored, { token: "test-secret", other: { value: true }, model: "custom" });
    assert.equal(new ModelSettings({}, stored).config.model, "custom");
    settings.select(null);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, null);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

function bridgeFixture(save) {
  const messages = [], calls = [];
  const bridge = new CodexBridge({ defaultCwd: "project", approvalPolicy: "on-request", sandbox: "workspace-write", model: null }, (m) => messages.push(structuredClone(m)), save);
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "config/read": return { config: { model: "configured-default" } };
      case "model/list": return { data: [{ model: "catalog-model", displayName: "Catalog Model" }] };
      case "thread/start": return { thread: { id: "thread" }, model: params.model };
      case "thread/resume": return { thread: { id: params.threadId, cwd: "old-project", turns: [] }, model: "old-model" };
      case "turn/start": return { turn: { id: "turn" } };
      default: throw new Error("Unexpected method: " + method);
    }
  };
  return { bridge, messages, calls };
}

test("bridge passes selected model to both new threads and turns", async () => {
  const saved = [];
  const { bridge, calls, messages } = bridgeFixture((m) => saved.push(m));
  await bridge.dispatch({ type: "setConfig", model: "chosen", requestId: "save-1" });
  await bridge.dispatch({ type: "prompt", text: "hello" });
  assert.deepEqual(saved, ["chosen"]);
  assert.equal(calls.find((c) => c.method === "thread/start").params.model, "chosen");
  assert.equal(calls.find((c) => c.method === "turn/start").params.model, "chosen");
  assert.equal(bridge.snapshot().config.model, "chosen");
  assert(messages.some((m) => m.type === "configSaved" && m.requestId === "save-1"));
});

test("switching during a turn leaves the active model unchanged until next prompt", async () => {
  const { bridge, calls } = bridgeFixture();
  await bridge.dispatch({ type: "setConfig", model: "a" });
  await bridge.dispatch({ type: "prompt", text: "one" });
  const count = calls.length;
  await bridge.dispatch({ type: "setConfig", model: "b" });
  assert.equal(calls.length, count);
  assert.equal(bridge.state.status, "running");
  assert.equal(bridge.state.effectiveModel, "a");
  bridge.state.status = "idle";
  await bridge.dispatch({ type: "prompt", text: "two" });
  assert.equal(calls.filter((c) => c.method === "thread/start").length, 1);
  assert.equal(calls.filter((c) => c.method === "turn/start").at(-1).params.model, "b");
});

test("restoring default explicitly overrides the previous model on an existing thread", async () => {
  const { bridge, calls } = bridgeFixture();
  await bridge.dispatch({ type: "setConfig", model: "custom" });
  await bridge.dispatch({ type: "prompt", text: "one" });
  await bridge.dispatch({ type: "setConfig", model: null });
  bridge._onNotification({ method: "turn/completed", params: { threadId: bridge.state.threadId, turn: { id: bridge.state.turnId, status: "completed" } } });
  await bridge.dispatch({ type: "prompt", text: "two" });
  assert.equal(calls.filter((c) => c.method === "turn/start").at(-1).params.model, "configured-default");
  assert.equal(bridge.state.model, null);
  assert.equal(bridge.state.effectiveModel, "configured-default");
});

test("resumed conversations expose their active model and use the selection next turn", async () => {
  const { bridge, calls } = bridgeFixture();
  await bridge.dispatch({ type: "setConfig", model: "chosen" });
  await bridge.dispatch({ type: "resumeThread", threadId: "existing" });
  assert.equal(bridge.state.effectiveModel, "old-model");
  assert.equal(bridge.state.model, "chosen");
  await bridge.dispatch({ type: "prompt", text: "continue" });
  assert.equal(calls.filter((c) => c.method === "turn/start").at(-1).params.model, "chosen");
});

test("old clients omitting model leave the selection intact", async () => {
  const { bridge } = bridgeFixture();
  await bridge.dispatch({ type: "setConfig", model: "chosen" });
  await bridge.dispatch({ type: "setConfig", approvalPolicy: "untrusted" });
  assert.equal(bridge.state.model, "chosen");
});

test("failed persistence rejects configuration without changing state or acknowledging it", async () => {
  const { bridge, messages } = bridgeFixture(() => { throw new Error("disk full"); });
  await assert.rejects(bridge.dispatch({ type: "setConfig", model: "chosen", cwd: "different", requestId: "failed" }), /disk full/);
  assert.equal(bridge.state.model, null);
  assert.equal(bridge.state.cwd, "project");
  assert(!messages.some((m) => m.type === "configSaved"));
});

test("model list responses never include config credentials", async () => {
  const { bridge, messages } = bridgeFixture();
  await bridge.dispatch({ type: "listModels" });
  const result = messages.find((m) => m.type === "models");
  assert.equal(result.models[0].model, "catalog-model");
  assert.equal(result.defaultModel, "configured-default");
  assert.equal(result.config, undefined);
});

test("server model changes update the active model without overwriting the selection", async () => {
  const { bridge } = bridgeFixture();
  await bridge.dispatch({ type: "setConfig", model: "chosen" });
  bridge.state.threadId = "active";
  bridge._onNotification({ method: "model/rerouted", params: { threadId: "active", toModel: "fallback" } });
  assert.equal(bridge.state.effectiveModel, "fallback");
  assert.equal(bridge.state.model, "chosen");
  bridge._onNotification({ method: "thread/settings/updated", params: { threadId: "other", threadSettings: { model: "unrelated" } } });
  assert.equal(bridge.state.effectiveModel, "fallback");
  bridge._onNotification({ method: "thread/settings/updated", params: { threadId: "active", threadSettings: { model: "updated" } } });
  assert.equal(bridge.state.effectiveModel, "updated");
});
