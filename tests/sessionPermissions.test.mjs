import test from "node:test";
import assert from "node:assert/strict";
import { CodexBridge } from "../core/codexBridge.mjs";

async function fixture() {
  const calls = [], messages = [];
  let subscribed = false, policy = { type: "workspaceWrite", networkAccess: false }, approvalPolicy = "on-request";
  const bridge = new CodexBridge({ defaultCwd: "/fixture", model: "fixture-model", approvalPolicy, sandbox: "workspace-write" }, message => messages.push(structuredClone(message)));
  bridge.state.codexConnected = true;
  bridge.models.resolveEffort = async () => null;
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "thread/unsubscribe") { subscribed = false; return { status: "unsubscribed" }; }
    if (method === "thread/resume") {
      if (!subscribed) {
        policy = { type: ({ "workspace-write": "workspaceWrite", "read-only": "readOnly", "danger-full-access": "dangerFullAccess" })[params.sandbox] };
        approvalPolicy = params.approvalPolicy;
      }
      subscribed = true;
      return { thread: { id: params.threadId, cwd: "/fixture", turns: [] }, sandbox: policy, approvalPolicy };
    }
    if (method === "turn/start") return { turn: { id: "next" } };
    throw new Error("Unexpected request: " + method);
  };
  await bridge.dispatch({ type: "resumeThread", threadId: "one" });
  calls.length = 0; messages.length = 0;
  const finish = (status = "completed") => bridge.codex.onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: bridge.state.turnId, status } } });
  return { bridge, calls, messages, finish };
}

test("running permission changes wait for completion then resubscribe the same thread", async () => {
  const { bridge, calls, messages, finish } = await fixture();
  Object.assign(bridge.state, { status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "setConfig", sandbox: "danger-full-access", approvalPolicy: "never", requestId: "save" });
  assert.equal(calls.length, 0, "saving must not interrupt or reconfigure the active turn");
  assert.equal(bridge.state.permissions.pending, true);
  assert.deepEqual(bridge.state.permissions.applied, { sandbox: "workspace-write", approvalPolicy: "on-request" });
  assert(messages.some(message => message.type === "configSaved" && message.requestId === "save"));
  finish();
  await bridge.commandQueue;
  assert.deepEqual(calls.map(call => call.method), ["thread/unsubscribe", "thread/resume"]);
  assert.equal(bridge.state.threadId, "one");
  assert.deepEqual(bridge.state.permissions.applied, { sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.equal(bridge.state.permissions.pending, false);
});

test("queued messages start only after permission sync and carry the new sandbox policy", async () => {
  const { bridge, calls, finish } = await fixture();
  Object.assign(bridge.state, { status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "queued", text: "fixture prompt" });
  await bridge.dispatch({ type: "setConfig", sandbox: "danger-full-access", approvalPolicy: "never" });
  finish(); await bridge.commandQueue;
  assert.deepEqual(calls.map(call => call.method), ["thread/unsubscribe", "thread/resume", "turn/start"]);
  assert.equal(calls[2].params.sandboxPolicy.type, "dangerFullAccess");
  assert.equal(calls[2].params.approvalPolicy, "never");
  assert.equal(bridge.state.permissions.pending, false);
});

test("failed sync pauses queued messages and saving again retries the detached session", async () => {
  const { bridge, calls, finish } = await fixture();
  const request = bridge.codex.request;
  let fail = true;
  bridge.codex.request = async (method, params) => {
    if (method === "thread/resume" && fail) throw new Error("fixture sync failure");
    return request(method, params);
  };
  Object.assign(bridge.state, { status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "queued", text: "fixture prompt" });
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only" });
  finish(); await bridge.commandQueue;
  assert.equal(bridge.state.permissions.pending, true);
  assert.equal(bridge.state.permissions.applied, null);
  assert.match(bridge.state.permissions.error, /fixture sync failure/);
  assert.equal(bridge.promptQueue.snapshot().paused, true);
  assert.equal(bridge.promptQueue.snapshot().items.length, 1);
  assert(!calls.some(call => call.method === "turn/start"));
  fail = false;
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only" });
  assert.equal(bridge.state.permissions.pending, false);
  assert.equal(bridge.state.readOnly, false);
  assert.equal(bridge.state.permissions.applied.sandbox, "read-only");
  assert.equal(bridge.promptQueue.snapshot().paused, true, "retry must not silently unpause a failed queue");
});

test("settings notifications expose actual permissions even without a model change", async () => {
  const { bridge } = await fixture();
  bridge.codex.onNotification({ method: "thread/settings/updated", params: { threadId: "one", threadSettings: { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } } });
  assert.deepEqual(bridge.state.permissions.applied, { sandbox: "read-only", approvalPolicy: "never" });
  assert.equal(bridge.state.permissions.pending, true);
});

test("selecting the original permissions cancels the pending update", async () => {
  const { bridge, calls, finish } = await fixture();
  Object.assign(bridge.state, { status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only" });
  await bridge.dispatch({ type: "setConfig", sandbox: "workspace-write" });
  assert.equal(bridge.state.permissions.pending, false);
  finish(); await bridge.commandQueue;
  assert.equal(calls.length, 0);
});

test("actual permission mismatches stay pending and pause the queue", async () => {
  const { bridge, calls, finish } = await fixture();
  const request = bridge.codex.request;
  bridge.codex.request = async (method, params) => {
    const response = await request(method, params);
    return method === "thread/resume" ? { ...response, sandbox: { type: "workspaceWrite" } } : response;
  };
  Object.assign(bridge.state, { status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "queued", text: "fixture prompt" });
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only" });
  finish(); await bridge.commandQueue;
  assert.equal(bridge.state.permissions.applied.sandbox, "workspace-write");
  assert.equal(bridge.state.permissions.pending, true);
  assert.match(bridge.state.permissions.error, /不一致/);
  assert.equal(bridge.promptQueue.snapshot().paused, true);
  assert(!calls.some(call => call.method === "turn/start"));
});

test("read-only history keeps selected permissions without acquiring a writer", async () => {
  const { bridge, calls } = await fixture();
  bridge.codex.request = async method => method === "thread/unsubscribe" ? { status: "unsubscribed" } : { thread: { id: "history", turns: [] } };
  await bridge.dispatch({ type: "readThread", threadId: "history" });
  assert.equal(bridge.state.permissions.applied, null);
  bridge.codex.request = async (method, params) => { calls.push({ method, params }); throw new Error("must not acquire a writer"); };
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only" });
  assert.equal(bridge.state.permissions.pending, true);
  assert.equal(bridge.state.readOnly, true);
  assert.equal(calls.length, 0);
});

test("fresh unmaterialized threads use new turn permissions without losing the thread", async () => {
  const { bridge, calls } = await fixture();
  const request = bridge.codex.request;
  bridge.codex.request = async (method, params) => {
    if (method === "thread/start") return { thread: { id: "fresh", turns: [] }, sandbox: { type: "workspaceWrite" }, approvalPolicy: "on-request" };
    return request(method, params);
  };
  await bridge.dispatch({ type: "newThread" });
  calls.length = 0; // 旧会话在新建时已取消订阅，后续只检查新会话的权限行为。
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only" });
  assert(!calls.some(call => call.method === "thread/unsubscribe"));
  await bridge.dispatch({ type: "prompt", text: "fixture prompt" });
  assert.equal(calls.find(call => call.method === "turn/start").params.sandboxPolicy.type, "readOnly");
  assert.equal(bridge.state.threadId, "fresh");
  assert.equal(bridge.state.permissions.pending, false);
});

test("turn acknowledgements do not overwrite actual permission notifications", async () => {
  const { bridge } = await fixture();
  bridge.codex.request = async method => {
    assert.equal(method, "turn/start");
    bridge.codex.onNotification({ method: "thread/settings/updated", params: { threadId: "one", threadSettings: { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } } } });
    return { turn: { id: "next" } };
  };
  await bridge.dispatch({ type: "prompt", text: "fixture prompt" });
  assert.equal(bridge.state.permissions.applied.sandbox, "read-only");
  assert.equal(bridge.state.permissions.pending, true);
});

test("idle attached threads synchronize immediately without starting a task", async () => {
  const { bridge, calls } = await fixture();
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only", approvalPolicy: "never" });
  assert.deepEqual(calls.map(call => call.method), ["thread/unsubscribe", "thread/resume"]);
  assert.equal(bridge.state.status, "idle");
  assert.deepEqual(bridge.state.permissions.applied, { sandbox: "read-only", approvalPolicy: "never" });
});

test("multiple running updates apply only the last saved selection", async () => {
  const { bridge, calls, finish } = await fixture();
  Object.assign(bridge.state, { status: "running", turnId: "existing" });
  await bridge.dispatch({ type: "setConfig", sandbox: "danger-full-access", approvalPolicy: "never" });
  await bridge.dispatch({ type: "setConfig", sandbox: "read-only", approvalPolicy: "untrusted" });
  assert.equal(calls.length, 0);
  finish(); await bridge.commandQueue;
  assert.deepEqual(bridge.state.permissions.applied, { sandbox: "read-only", approvalPolicy: "untrusted" });
  assert.equal(calls.filter(call => call.method === "thread/resume").length, 1);
});

test("unchanged sandbox modes retain confirmed writable roots and network policy", async () => {
  const { bridge, calls } = await fixture();
  const policy = { type: "workspaceWrite", writableRoots: ["/fixture", "/second-root"], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  bridge.permissions.confirm({ sandbox: policy, approvalPolicy: "on-request" });
  await bridge.dispatch({ type: "prompt", text: "fixture prompt" });
  const sent = calls.find(call => call.method === "turn/start").params.sandboxPolicy;
  assert.deepEqual(sent, policy);
  assert.notEqual(sent, policy, "turn payloads must not mutate the cached policy");
});
