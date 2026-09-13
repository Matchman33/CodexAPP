import test from "node:test";
import assert from "node:assert/strict";
import { PromptQueue } from "../core/promptQueue.mjs";

function fixture(execute) {
  const state = { threadId: "one", status: "idle", turnId: null, codexConnected: true };
  const scheduled = [], started = [];
  const queue = new PromptQueue({ getState: () => state, schedule: task => scheduled.push(task), onSettled: turn => { if (state.turnId === turn.turnId) state.status = "idle"; }, execute: execute || (async item => { started.push(item.id); state.status = "running"; state.turnId = item.id; return { turnId: item.id }; }) });
  return { queue, state, scheduled, started };
}

test("FIFO waits for the previous successful turn rather than its start response", async () => {
  const state = { threadId: "one", status: "running", turnId: "old", codexConnected: true };
  const scheduled = [], started = [];
  const queue = new PromptQueue({ getState: () => state, schedule: task => scheduled.push(task), execute: async item => { started.push(item.text); state.status = "running"; state.turnId = item.id; return { threadId: "one", turnId: item.id }; } });
  queue.enqueue({ requestId: "first", threadId: "one", text: "first" });
  queue.enqueue({ requestId: "second", threadId: "one", text: "second" });
  assert.equal(scheduled.length, 0);
  state.status = "idle"; queue.complete({ threadId: "one", turnId: "old", status: "completed" });
  await scheduled.shift()();
  assert.deepEqual(started, ["first"]);
  assert.equal(queue.snapshot().items.length, 1);
  state.status = "idle"; queue.complete({ threadId: "one", turnId: "first", status: "completed" });
  await scheduled.shift()();
  assert.deepEqual(started, ["first", "second"]);
});

test("duplicate acceptance is idempotent but reuse with changed content is rejected", async () => {
  const { queue, state, scheduled } = fixture(); state.status = "running";
  const message = { requestId: "same", threadId: "one", text: "hello" };
  assert.deepEqual(queue.enqueue(message), queue.enqueue(message));
  assert.equal(queue.snapshot().items.length, 1);
  assert.throws(() => queue.enqueue({ ...message, text: "different" }));
  state.status = "idle"; queue.complete({ threadId: "one", turnId: null, status: "completed" });
  await scheduled.shift()();
  queue.complete({ threadId: "one", turnId: "same", status: "completed" });
  queue.enqueue(message);
  assert.equal(queue.snapshot().items.length, 0, "reconnecting/retrying a completed request must not send it again");
});

test("pause, cancellation and failure prevent automatic continuation until resumed", async () => {
  const { queue, state, scheduled, started } = fixture();
  queue.enqueue({ requestId: "first", threadId: "one", text: "one" });
  queue.enqueue({ requestId: "cancel", threadId: "one", text: "cancel" });
  queue.enqueue({ requestId: "next", threadId: "one", text: "next" });
  queue.cancel("one", "cancel"); queue.pause("one", "manual stop");
  await scheduled.shift()(); assert.deepEqual(started, []);
  queue.resume("one"); await scheduled.shift()();
  state.status = "idle"; queue.complete({ threadId: "one", turnId: "first", status: "failed" });
  assert(queue.snapshot().paused); assert.equal(scheduled.length, 0);
  queue.resume("one"); await scheduled.shift()();
  assert.deepEqual(started, ["first", "next"]);
});

test("queued messages cannot target another local conversation and limits bound memory", () => {
  const { queue, state } = fixture(); state.status = "running";
  assert.throws(() => queue.enqueue({ requestId: "wrong", threadId: "other", text: "no" }));
  assert.throws(() => queue.enqueue({ requestId: "huge", threadId: "one", text: "x".repeat(65537) }));
  for (let i = 0; i < 20; i++) queue.enqueue({ requestId: "m" + i, threadId: "one", text: "text" });
  assert.throws(() => queue.enqueue({ requestId: "overflow", threadId: "one", text: "no" }));
});

test("a turn that finishes before its start response can advance exactly once", async () => {
  let fixtureState;
  const result = fixture(async item => {
    fixtureState.state.turnId = item.id;
    fixtureState.queue.started({ threadId: "one", turnId: item.id });
    fixtureState.queue.complete({ threadId: "one", turnId: item.id, status: "completed" });
    fixtureState.state.status = "running";
    return { turnId: item.id };
  }); fixtureState = result;
  result.queue.enqueue({ requestId: "first", threadId: "one", text: "one" });
  result.queue.enqueue({ requestId: "next", threadId: "one", text: "next" });
  await result.scheduled.shift()();
  assert.equal(result.state.status, "idle");
  assert.equal(result.scheduled.length, 1);
  result.queue.complete({ threadId: "one", turnId: "first", status: "completed" });
  assert.equal(result.scheduled.length, 1);
});

test("failed starts keep the head message and require manual retry", async () => {
  let attempts = 0;
  const { queue, scheduled } = fixture(async () => { if (++attempts === 1) throw new Error("writer occupied"); return { turnId: "accepted" }; });
  queue.enqueue({ requestId: "first", threadId: "one", text: "keep" });
  await scheduled.shift()();
  assert.equal(queue.snapshot().items[0].text, "keep");
  assert.equal(queue.snapshot().reason, "writer occupied");
  assert.equal(scheduled.length, 0);
  queue.resume("one"); await scheduled.shift()();
  assert.equal(attempts, 2); assert.equal(queue.snapshot().items.length, 0);
});

test("disconnect during startup ignores the late response and keeps messages paused", async () => {
  let resolveStart;
  const { queue, state, scheduled } = fixture(() => new Promise(resolve => { resolveStart = resolve; }));
  queue.enqueue({ requestId: "first", threadId: "one", text: "keep" });
  const startup = scheduled.shift()();
  state.codexConnected = false; queue.disconnect();
  resolveStart({ turnId: "late" }); await startup;
  assert.equal(queue.snapshot().items.length, 1);
  assert.equal(queue.snapshot().paused, true);
  assert.equal(queue.active, null);
  assert.throws(() => queue.resume("one"));
});

test("switching conversations cannot automatically execute the previous queue", async () => {
  const { queue, state, scheduled, started } = fixture();
  state.status = "running";
  const message = { requestId: "first", threadId: "one", text: "keep" };
  const receipt = queue.enqueue(message);
  queue.select("two"); state.threadId = "two"; state.status = "idle";
  queue.kick(); assert.equal(scheduled.length, 0);
  assert.deepEqual(queue.enqueue(message), receipt, "replays retain their original conversation");
  assert.throws(() => queue.resume("one"));
  state.threadId = "one"; queue.kick(); assert.equal(scheduled.length, 0);
  queue.resume("one"); await scheduled.shift()();
  assert.deepEqual(started, ["first"]);
});

test("total text and acknowledgement receipts remain bounded", () => {
  const { queue, state } = fixture(); state.status = "running";
  for (let i = 0; i < 4; i++) queue.enqueue({ requestId: "large" + i, threadId: "one", text: "x".repeat(65536) });
  assert.throws(() => queue.enqueue({ requestId: "overflow", threadId: "one", text: "x" }));
  for (let i = 0; i < 4; i++) queue.cancel("one", "large" + i);
  for (let i = 0; i < 250; i++) { queue.enqueue({ requestId: "short" + i, threadId: "one", text: "x" }); queue.cancel("one", "short" + i); }
  assert.equal(queue.receipts.size, 200);
  queue.enqueue({ requestId: "short249", threadId: "one", text: "x" });
  assert.equal(queue.snapshot().items.length, 0, "a canceled message is not restored by a replay");
});

test("an old completion during startup cannot settle the new unbound turn", async () => {
  let resolveStart;
  const { queue, state, scheduled } = fixture(() => new Promise(resolve => { resolveStart = resolve; }));
  state.turnId = "old";
  queue.enqueue({ requestId: "first", threadId: "one", text: "keep" });
  const startup = scheduled.shift()();
  queue.complete({ threadId: "one", turnId: "old", status: "failed" });
  assert.equal(queue.active.completion, null);
  state.turnId = "new"; queue.started({ threadId: "one", turnId: "new" });
  resolveStart({ turnId: "new" }); await startup;
  queue.complete({ threadId: "one", turnId: "new", status: "unknown" });
  assert.equal(queue.snapshot().paused, true, "only explicit success permits automatic continuation");
});
