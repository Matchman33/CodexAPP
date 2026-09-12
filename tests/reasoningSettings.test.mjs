import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelSettings, normalizeReasoningEffort, persistModel } from "../core/modelSettings.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";

const entry = { model: "reasoner", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "max" }] };
function fixture(config = {}) {
  const calls = [], messages = [], saved = [];
  const bridge = new CodexBridge({ defaultCwd: "project", model: "reasoner", reasoningEffort: null, ...config }, (m) => messages.push(structuredClone(m)), (model, settings) => saved.push({ model, settings }));
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "config/read") return { config: { model: "reasoner", model_reasoning_effort: "low" } };
    if (method === "model/list") return { data: [entry, { model: "other", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
    if (method === "thread/start") return { thread: { id: "new" }, model: params.model };
    if (method === "thread/resume") return { thread: { id: params.threadId, cwd: "project", turns: [] }, model: "reasoner", reasoningEffort: "max" };
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: "project", turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn" } };
    throw new Error(method);
  };
  return { bridge, calls, messages, saved };
}

test("思考等级支持动态扩展值，拒绝错误类型和非法字符", () => {
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max", "ultra", "future-mode"]) assert.equal(normalizeReasoningEffort(effort), effort);
  assert.equal(normalizeReasoningEffort(null), null);
  assert.equal(normalizeReasoningEffort(""), null);
  for (const value of [undefined, 1, {}, "HIGH", " high ", "two levels", "x".repeat(65)]) assert.throws(() => normalizeReasoningEffort(value));
});

test("目录保留支持等级和默认等级，区分未知能力与不支持思考", async () => {
  const settings = new ModelSettings({ request: async () => ({ data: [entry, { model: "legacy" }, { model: "plain", supportedReasoningEfforts: [] }] }) }, {});
  const models = await settings.catalog();
  assert.equal(models[0].defaultReasoningEffort, "medium");
  assert.deepEqual(models[0].supportedReasoningEfforts.map((o) => o.reasoningEffort), ["low", "medium", "high", "max"]);
  assert.equal(models[1].supportedReasoningEfforts, null);
  assert.deepEqual(models[2].supportedReasoningEfforts, []);
});

test("模型和等级同时校验，失败时不产生部分保存", async () => {
  const { bridge, saved, messages } = fixture();
  await bridge.dispatch({ type: "listModels" });
  await assert.rejects(bridge.dispatch({ type: "setConfig", model: "other", reasoningEffort: "low", cwd: "wrong" }), /不支持/);
  assert.equal(bridge.state.model, "reasoner");
  assert.equal(bridge.state.reasoningEffort, null);
  assert.equal(bridge.state.cwd, "project");
  assert.equal(saved.length, 0);
  assert(!messages.some((m) => m.type === "configSaved"));
});

test("下一轮传入所选等级，运行中切换不更改有效等级", async () => {
  const { bridge, calls } = fixture();
  await bridge.dispatch({ type: "setConfig", reasoningEffort: "high" });
  await bridge.dispatch({ type: "prompt", text: "one" });
  assert.equal(calls.at(-1).params.effort, "high");
  await bridge.dispatch({ type: "setConfig", reasoningEffort: "max" });
  assert.equal(bridge.state.effectiveReasoningEffort, "high");
  bridge.state.status = "idle";
  await bridge.dispatch({ type: "prompt", text: "two" });
  assert.equal(calls.at(-1).params.effort, "max");
  assert.equal(bridge.snapshot().config.reasoningEffort, "max");
});

test("恢复默认显式覆盖已有会话的等级", async () => {
  const { bridge, calls } = fixture({ reasoningEffort: "max" });
  await bridge.dispatch({ type: "prompt", text: "one" });
  await bridge.dispatch({ type: "setConfig", reasoningEffort: null });
  bridge.state.status = "idle";
  await bridge.dispatch({ type: "prompt", text: "two" });
  assert.equal(calls.at(-1).params.effort, "low");
});

test("选择不同模型时使用该模型默认值，不错误套用原模型的默认", async () => {
  const { bridge, calls } = fixture({ model: "other" });
  await bridge.dispatch({ type: "prompt", text: "one" });
  assert.equal(calls.at(-1).params.effort, "high");
});

test("从历史接续后也显式覆盖原会话思考等级", async () => {
  const { bridge, calls } = fixture();
  await bridge.dispatch({ type: "readThread", threadId: "existing" });
  await bridge.dispatch({ type: "prompt", text: "continue" });
  assert.equal(calls.at(-1).params.effort, "low");
  assert.equal(bridge.state.effectiveReasoningEffort, "low");
});

test("默认无法解析时不会悄悄沿用旧等级", async () => {
  const settings = new ModelSettings({ request: async (method) => method === "config/read" ? { config: {} } : { data: [] } }, {});
  await assert.rejects(settings.resolveEffort("project", "private", "max"), /无法确定/);
  assert.equal(await settings.resolveEffort("project", "private"), null);
});

test("目录不可用时私有模型仍可使用明确等级", async () => {
  const settings = new ModelSettings({ request: async () => { throw new Error("offline"); } }, { reasoningEffort: "ultra" });
  assert.equal(await settings.resolveEffort("project", "private"), "ultra");
});

test("旧客户端不传思考等级时保留原选择", async () => {
  const { bridge } = fixture({ reasoningEffort: "high" });
  await bridge.dispatch({ type: "setConfig", approvalPolicy: "on-request" });
  assert.equal(bridge.state.reasoningEffort, "high");
});

test("持久化只改选择字段并保留磁盘中的凭据与其他配置", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-reasoning-")), file = path.join(dir, "config.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ token: "disk-only", other: 42, model: null }));
    const settings = new ModelSettings({}, { token: "runtime-only", model: null }, (model, patch) => persistModel(file, model, patch));
    settings.update({ model: "reasoner", reasoningEffort: "high", token: "attacker" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { token: "disk-only", other: 42, model: "reasoner", reasoningEffort: "high" });
    settings.update({ reasoningEffort: null });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).reasoningEffort, null);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  } finally { fs.unlinkSync(file); fs.rmdirSync(dir); }
});

test("保存失败不确认成功，思考等级状态保持原值", async () => {
  const { bridge, messages } = fixture();
  bridge.models.save = () => { throw new Error("disk full"); };
  await assert.rejects(bridge.dispatch({ type: "setConfig", reasoningEffort: "high" }), /disk full/);
  assert.equal(bridge.state.reasoningEffort, null);
  assert(!messages.some((m) => m.type === "configSaved"));
});

test("服务端等级通知只更新有效值，不覆盖用户选择", () => {
  const { bridge } = fixture({ reasoningEffort: "high" });
  bridge.state.threadId = "active";
  bridge._onNotification({ method: "thread/settings/updated", params: { threadId: "active", threadSettings: { model: "reasoner", effort: "max" } } });
  assert.equal(bridge.state.effectiveReasoningEffort, "max");
  assert.equal(bridge.state.reasoningEffort, "high");
});
