import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBridge } from "../core/codexBridge.mjs";
import { persistModel } from "../core/modelSettings.mjs";

function fixture(config = {}, save) {
  const messages = [], calls = [];
  const bridge = new CodexBridge({ defaultCwd: "/fixture", model: "fixture-model", approvalPolicy: "on-request", sandbox: "workspace-write", ...config }, m => messages.push(structuredClone(m)), save);
  bridge.state.codexConnected = true;
  bridge.models.resolveEffort = async () => null;
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: params.threadId || "one", cwd: "/fixture", turns: [] } };
    if (method === "turn/start") return { turn: { id: "turn-" + calls.length } };
    if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
    throw new Error("Unexpected request: " + method);
  };
  return { bridge, messages, calls };
}

test("approval-only saves persist never and sandbox without overwriting credentials or model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-approval-"));
  const file = path.join(dir, "config.json");
  const initial = { approvalPolicy: "on-request", sandbox: "workspace-write", model: "fixture-model", token: "fixture-secret", unrelated: true };
  fs.writeFileSync(file, JSON.stringify(initial));
  try {
    const { bridge } = fixture(initial, (model, settings) => persistModel(file, model, settings));
    await bridge.dispatch({ type: "setConfig", approvalPolicy: "never", sandbox: "read-only", requestId: "save" });
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.approvalPolicy, "never");
    assert.equal(saved.sandbox, "read-only");
    assert.equal(saved.token, initial.token);
    assert.equal(saved.model, initial.model);
    assert.equal(saved.unrelated, true);
    const restarted = fixture(saved);
    await restarted.bridge.dispatch({ type: "prompt", text: "fixture prompt" });
    assert.equal(restarted.calls.find(c => c.method === "thread/start").params.approvalPolicy, "never");
    assert.equal(restarted.calls.find(c => c.method === "turn/start").params.approvalPolicy, "never");
  } finally {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
});

test("failed approval persistence cannot report success or change any session selection", async () => {
  const { bridge, messages } = fixture({}, () => { throw new Error("disk full"); });
  await assert.rejects(bridge.dispatch({ type: "setConfig", approvalPolicy: "never", sandbox: "read-only", cwd: "/different", requestId: "save" }), /disk full/);
  assert.equal(bridge.state.approvalPolicy, "on-request");
  assert.equal(bridge.config.approvalPolicy, "on-request");
  assert.equal(bridge.state.sandbox, "workspace-write");
  assert.equal(bridge.state.cwd, "/fixture");
  assert(!messages.some(m => m.type === "configSaved"));
});

test("invalid approval and sandbox values are rejected before persisting partial settings", async () => {
  const saved = [], { bridge } = fixture({}, (...args) => saved.push(args));
  await assert.rejects(bridge.dispatch({ type: "setConfig", model: "different", approvalPolicy: "invalid" }));
  await assert.rejects(bridge.dispatch({ type: "setConfig", approvalPolicy: "never", sandbox: "invalid" }));
  assert.equal(bridge.state.model, "fixture-model");
  assert.equal(bridge.state.approvalPolicy, "on-request");
  assert.equal(saved.length, 0);
});

test("existing read-only conversations resume and start with never without expanding the sandbox", async () => {
  const { bridge, calls } = fixture();
  Object.assign(bridge.state, { threadId: "one", readOnly: true });
  await bridge.dispatch({ type: "setConfig", approvalPolicy: "never" });
  await bridge.dispatch({ type: "prompt", text: "fixture prompt" });
  assert.equal(calls.find(c => c.method === "thread/resume").params.approvalPolicy, "never");
  assert.equal(calls.find(c => c.method === "thread/resume").params.sandbox, "workspace-write");
  assert.equal(calls.find(c => c.method === "turn/start").params.approvalPolicy, "never");
});

test("queued messages use the approval selection at execution time", async () => {
  const { bridge, calls } = fixture();
  Object.assign(bridge.state, { threadId: "one", status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "queued", text: "fixture prompt" });
  await bridge.dispatch({ type: "setConfig", approvalPolicy: "never" });
  assert.equal(calls.length, 0, "changing settings must not restart the active task");
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "existing", status: "completed" } } });
  await bridge.commandQueue;
  assert.equal(calls.find(c => c.method === "turn/start").params.approvalPolicy, "never");
});
