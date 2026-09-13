import test from "node:test";
import assert from "node:assert/strict";
import { CodexBridge } from "../core/codexBridge.mjs";

function fixture() {
  const emitted = [], calls = [];
  const bridge = new CodexBridge({ defaultCwd: "/repo", approvalPolicy: "on-request", sandbox: "read-only" }, message => emitted.push(structuredClone(message)));
  Object.assign(bridge.state, { threadId: "one", codexConnected: true, status: "running", turnId: "existing" });
  bridge.models.resolve = async () => "fixture-model"; bridge.models.resolveEffort = async () => null;
  bridge.codex.request = async (method, params) => { calls.push({ method, params }); return method === "turn/start" ? { turn: { id: "turn-" + calls.length } } : {}; };
  return { bridge, emitted, calls };
}

test("running conversation accepts FIFO messages and advances only once per successful completion", async () => {
  const { bridge, emitted, calls } = fixture();
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "first", text: "one" });
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "next", text: "two" });
  assert.equal(emitted.filter(m => m.type === "promptAccepted").length, 2);
  assert.equal(calls.length, 0);
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "existing", status: "completed" } } });
  await bridge.commandQueue;
  assert.equal(calls.length, 1); assert.equal(calls[0].params.threadId, "one");
  assert.equal(bridge.snapshot().promptQueue.items.length, 1);
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "existing", status: "completed" } } });
  await bridge.commandQueue; assert.equal(calls.length, 1); assert.equal(bridge.state.status, "running");
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "turn-1", status: "completed" } } });
  await bridge.commandQueue;
  assert.equal(calls.length, 2); assert.equal(calls[1].params.input[0].text, "two");
  assert.equal(bridge.eventLog.filter(e => e.kind === "user").length, 2);
});

test("stop pauses the queue before interrupt and keeps waiting text until manual continuation", async () => {
  const { bridge, calls } = fixture();
  await bridge.dispatch({ type: "enqueuePrompt", requestId: "waiting", threadId: "one", text: "keep me" });
  await bridge.dispatch({ type: "interrupt" });
  assert.equal(bridge.snapshot().promptQueue.paused, true);
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "existing", status: "interrupted" } } });
  await bridge.commandQueue; assert.equal(calls.filter(c => c.method === "turn/start").length, 0);
  await bridge.dispatch({ type: "resumeQueue", threadId: "one" });
  await bridge.commandQueue; assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
});

test("writer conflicts preserve queued text without generating an unsent chat echo", async () => {
  const { bridge, calls } = fixture();
  bridge.state.status = "idle"; bridge.state.readOnly = true;
  bridge._ensureThread = async () => null;
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "waiting", text: "keep" });
  await bridge.commandQueue;
  assert.equal(calls.length, 0);
  assert.equal(bridge.snapshot().promptQueue.paused, true);
  assert.equal(bridge.snapshot().promptQueue.items[0].text, "keep");
  assert.equal(bridge.eventLog.filter(e => e.kind === "user").length, 0);
});

test("missing start confirmation never consumes a message using the previous turn ID", async () => {
  const { bridge } = fixture(); bridge.state.status = "idle";
  bridge.codex.request = async () => ({});
  await bridge.dispatch({ type: "enqueuePrompt", threadId: "one", requestId: "waiting", text: "keep" });
  await bridge.commandQueue;
  assert.equal(bridge.snapshot().promptQueue.paused, true);
  assert.equal(bridge.snapshot().promptQueue.items.length, 1);
  assert.equal(bridge.promptQueue.active, null);
});

test("the first queued prompt creates exactly one conversation and confirms its binding", async () => {
  const { bridge, calls, emitted } = fixture();
  Object.assign(bridge.state, { threadId: null, turnId: null, status: "idle" });
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "created", cwd: "/repo" } };
    if (method === "turn/start") return { turn: { id: "first-turn" } };
    throw new Error("Unexpected request: " + method);
  };
  const message = { type: "enqueuePrompt", requestId: "first", text: "hello" };
  await bridge.dispatch(message); await bridge.commandQueue;
  assert.equal(calls.filter(c => c.method === "thread/start").length, 1);
  assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
  assert.equal(emitted.find(m => m.type === "promptAccepted").threadId, "created");
  await bridge.dispatch(message); await bridge.commandQueue;
  assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
  assert.equal(bridge.eventLog.filter(e => e.kind === "user").length, 1);
});
