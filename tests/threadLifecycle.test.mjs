import test from "node:test";
import assert from "node:assert/strict";
import { CodexBridge } from "../core/codexBridge.mjs";

function fixture() {
  const calls = [], emitted = [], loaded = new Set(["one"]), threads = new Map(["one", "two", "child"].map(id => [id, { id, name: id, cwd: "/fixture", status: { type: "idle" }, turns: [] }]));
  let retained = false, recycled = 0;
  const bridge = new CodexBridge({ defaultCwd: "/fixture", model: "fixture-model", approvalPolicy: "on-request", sandbox: "read-only" }, m => emitted.push(structuredClone(m)));
  Object.assign(bridge.state, { threadId: "one", codexConnected: true, status: "idle" });
  bridge.models.resolveEffort = async () => null;
  bridge.eventLog = [{ id: "original", kind: "user", text: "保留聊天记录" }];
  bridge._listThreads = async () => bridge.emit({ type: "projectTree", projects: [], projectless: [...threads.values()] });
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "thread/unsubscribe") { if (!retained) loaded.delete(params.threadId); return { status: "unsubscribed" }; }
    if (method === "thread/loaded/list") return { data: [...loaded], nextCursor: null };
    if (method === "thread/read") { if (!threads.has(params.threadId)) throw new Error("not found"); return { thread: threads.get(params.threadId) }; }
    if (method === "thread/start") { loaded.add("new"); return { thread: { id: "new" } }; }
    if (method === "thread/resume") { loaded.add(params.threadId); return { thread: threads.get(params.threadId) }; }
    if (method === "turn/start") return { turn: { id: "turn" } };
    if (method === "thread/delete") { loaded.delete(params.threadId); threads.delete(params.threadId); return {}; }
    throw new Error("Unexpected request: " + method);
  };
  bridge.lifecycle.recycle = async () => { recycled++; loaded.clear(); };
  return { bridge, calls, emitted, loaded, threads, retain: () => { retained = true; }, recycled: () => recycled };
}

test("解除占用只取消本中继订阅，保留历史并暂停等待队列", async () => {
  const { bridge, calls, emitted, recycled } = fixture();
  bridge.promptQueue.pause("one");
  await bridge.dispatch({ type: "enqueuePrompt", requestId: "waiting", threadId: "one", text: "等待" });
  await bridge.dispatch({ type: "releaseThread", threadId: "one", requestId: "release" });
  assert.equal(bridge.state.readOnly, true); assert.equal(bridge.state.writerReleased, true);
  assert.equal(bridge.state.threadId, "one"); assert.equal(bridge.eventLog[0].text, "保留聊天记录");
  assert.equal(bridge.promptQueue.snapshot().paused, true); assert.equal(bridge.promptQueue.snapshot().items.length, 1);
  assert.equal(recycled(), 0); assert(!calls.some(c => c.method === "turn/interrupt" || c.method === "thread/resume"));
  assert(emitted.some(m => m.type === "threadReleased" && m.requestId === "release" && m.writerReleased));
  await bridge.dispatch({ type: "setConfig", sandbox: "workspace-write" });
  assert(!calls.some(c => c.method === "thread/resume"), "权限同步不能重新占用已释放会话");
});

test("新版卸载宽限期内验证所有会话空闲后重连，必须确认卸载才返回成功", async () => {
  const f = fixture(); f.retain();
  await f.bridge.dispatch({ type: "releaseThread", threadId: "one", requestId: "release" });
  assert.equal(f.recycled(), 1); assert.equal(f.bridge.state.writerReleased, true);
  assert(f.calls.some(c => c.method === "thread/read" && c.params.includeTurns === false));
  const failed = fixture(); failed.retain(); failed.bridge.lifecycle.recycle = async () => {};
  await assert.rejects(failed.bridge.dispatch({ type: "releaseThread", threadId: "one" }), /仍未卸载/);
  assert.equal(failed.bridge.state.writerReleased, false);
  assert(!failed.emitted.some(m => m.type === "threadReleased"));
});

test("其他加载会话或子任务仍活动时不重连，旧进程和所有历史保留", async () => {
  const f = fixture(); f.retain(); f.loaded.add("child"); f.threads.get("child").status = { type: "active", activeFlags: [] };
  await assert.rejects(f.bridge.dispatch({ type: "releaseThread", threadId: "one" }), /运行中或状态未知/);
  assert.equal(f.recycled(), 0); assert.equal(f.bridge.eventLog.length, 1);
  assert.equal(f.bridge.state.writerReleased, false); assert.equal(f.bridge.state.threadAction, null);
});

test("运行中、审批中和过期的释放请求不触碰控制进程", async () => {
  const f = fixture();
  f.bridge.state.status = "running";
  await assert.rejects(f.bridge.dispatch({ type: "releaseThread", threadId: "one" }), /先停止/);
  f.bridge.state.status = "idle"; f.bridge.pendingApprovals.set("approval", {});
  await assert.rejects(f.bridge.dispatch({ type: "releaseThread", threadId: "one" }), /先停止/);
  f.bridge.pendingApprovals.clear();
  await assert.rejects(f.bridge.dispatch({ type: "releaseThread", threadId: "two" }), /已变化/);
  assert.equal(f.calls.length, 0);
});

test("切换会话和新建会话前解除旧订阅，失败时不丢失当前页面", async () => {
  const f = fixture();
  await f.bridge.dispatch({ type: "readThread", threadId: "two" });
  assert.equal(f.calls.filter(c => c.method === "thread/unsubscribe").length, 1);
  assert.equal(f.bridge.state.threadId, "two"); assert.equal(f.bridge.state.readOnly, true);
  await f.bridge.dispatch({ type: "resumeThread", threadId: "two" });
  await f.bridge.dispatch({ type: "newThread" });
  assert(f.calls.some(c => c.method === "thread/unsubscribe" && c.params.threadId === "two"));
  const failure = fixture();
  const request = failure.bridge.codex.request;
  failure.bridge.codex.request = (method, params) => method === "thread/unsubscribe" ? Promise.reject(new Error("unsubscribe failed")) : request(method, params);
  await assert.rejects(failure.bridge.dispatch({ type: "readThread", threadId: "two" }), /unsubscribe failed/);
  assert.equal(failure.bridge.state.threadId, "one"); assert.equal(failure.bridge.eventLog[0].text, "保留聊天记录");
});

test("释放后发送能显式接续原会话，目标占用时不自动结束外部进程", async () => {
  const f = fixture();
  await f.bridge.dispatch({ type: "releaseThread", threadId: "one" });
  await f.bridge.dispatch({ type: "prompt", text: "接续" });
  assert(f.calls.some(c => c.method === "thread/resume" && c.params.threadId === "one"));
  assert.equal(f.bridge.state.writerReleased, false); assert.equal(f.bridge.state.readOnly, false);
  const occupied = fixture();
  await occupied.bridge.dispatch({ type: "releaseThread", threadId: "one" });
  const request = occupied.bridge.codex.request;
  occupied.bridge.codex.request = (method, params) => method === "thread/resume" ? Promise.reject(new Error("already has an active writer")) : request(method, params);
  occupied.bridge.writers.inspect = async threadId => ({ type: "writerConflict", threadId, owners: [] });
  occupied.bridge.writers.terminate = async () => { throw new Error("不能自动结束外部进程"); };
  await occupied.bridge.dispatch({ type: "prompt", text: "尝试接续" });
  assert(occupied.emitted.some(m => m.type === "writerConflict"));
  assert(!occupied.calls.some(c => c.method === "turn/start"));
  assert.equal(occupied.bridge.state.readOnly, true);
});

test("删除必须确认，运行中会话不能删除，目标状态再次校验", async () => {
  const f = fixture();
  await assert.rejects(f.bridge.dispatch({ type: "deleteThread", threadId: "one" }), /确认/);
  assert.equal(f.calls.length, 0);
  f.threads.get("two").status = { type: "active", activeFlags: [] };
  await assert.rejects(f.bridge.dispatch({ type: "deleteThread", threadId: "two", confirmed: true }), /目标会话正在运行/);
  assert(!f.calls.some(c => c.method === "thread/delete"));
});

test("删除当前会话清空页面和队列、不新建会话；迟到事件不能恢复删除的内容", async () => {
  const f = fixture(); f.bridge.promptQueue.pause("one");
  await f.bridge.dispatch({ type: "enqueuePrompt", requestId: "waiting", threadId: "one", text: "等待" });
  await f.bridge.dispatch({ type: "deleteThread", threadId: "one", confirmed: true, requestId: "delete" });
  assert.equal(f.bridge.state.threadId, null); assert.deepEqual(f.bridge.eventLog, []);
  assert(!f.bridge.promptQueue.threads.has("one"));
  assert.equal(f.bridge.promptQueue.receipts.has("waiting"), true);
  assert(!f.calls.some(c => c.method === "thread/start"));
  f.bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "old", status: "completed" } } });
  assert.deepEqual(f.bridge.eventLog, []);
  assert(f.emitted.some(m => m.type === "threadDeleted" && m.requestId === "delete"));
});

test("删除非当前会话及后代通知清理相应队列，不影响其他会话；失败不伪装成功", async () => {
  const f = fixture();
  await f.bridge.dispatch({ type: "deleteThread", threadId: "two", confirmed: true });
  assert.equal(f.bridge.state.threadId, "one"); assert.equal(f.bridge.eventLog.length, 1);
  f.bridge.promptQueue.threads.set("child", { items: [{ id: "waiting-child" }] });
  f.bridge._onNotification({ method: "thread/deleted", params: { threadId: "child" } });
  assert.equal(f.bridge.promptQueue.threads.has("child"), false);
  const failure = fixture(), request = failure.bridge.codex.request;
  failure.bridge.codex.request = (method, params) => method === "thread/delete" ? Promise.reject(new Error("method not found")) : request(method, params);
  await assert.rejects(failure.bridge.dispatch({ type: "deleteThread", threadId: "one", confirmed: true }), /升级 Codex/);
  assert.equal(failure.bridge.state.threadId, "one"); assert.equal(failure.bridge.eventLog.length, 1);
  assert(!failure.emitted.some(m => m.type === "threadDeleted"));
});
