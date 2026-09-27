import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionHub } from "../core/sessionHub.mjs";
import { enableServiceRestart } from "../core/serviceRestart.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-hub-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [], messages = [];
  let sequence = 0;
  const hub = new SessionHub({ defaultCwd: dir, model: "fixture", approvalPolicy: "on-request", sandbox: "read-only" }, m => messages.push(structuredClone(m)), undefined, { dataDir: dir });
  hub.control.state.codexConnected = true;
  hub.control.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "new-" + ++sequence, cwd: params.cwd, turns: [] } };
    if (method === "thread/read" || method === "thread/resume") return { thread: { id: params.threadId, cwd: dir, turns: [] } };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "turn/start") return { turn: { id: "turn-" + ++sequence } };
    if (method === "model/list") return { data: [{ model: "fixture", isDefault: true, supportedReasoningEfforts: [] }] };
    if (method === "config/read") return { config: { model: "fixture" } };
    if (method === "turn/interrupt") return {};
    if (method === "thread/unsubscribe") return { status: "notLoaded" };
    throw new Error("unexpected: " + method);
  };
  return { hub, calls, messages, dir };
}

test("多个客户端同会话刷新合并 RPC，窗口内复用缓存并保持独立请求标识", async t => {
  const { hub, calls, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one" }, "a");
  await hub.dispatch({ type: "readThread", threadId: "one" }, "b");
  calls.length = 0; messages.length = 0;
  await Promise.all([
    hub.dispatch({ type: "watchThread", threadId: "one", requestId: "a-watch" }, "a"),
    hub.dispatch({ type: "watchThread", threadId: "one", requestId: "b-watch" }, "b"),
  ]);
  const count = calls.length;
  assert.equal(calls.filter(c => c.method === "thread/read").length, 1);
  assert.equal(messages.find(m => m.requestId === "a-watch").clientId, "a");
  assert.equal(messages.find(m => m.requestId === "b-watch").clientId, "b");
  await hub.dispatch({ type: "watchThread", threadId: "one", requestId: "cached" }, "b");
  assert.equal(calls.length, count);
  const later = Date.now() + 2100;
  t.mock.method(Date, "now", () => later);
  await hub.dispatch({ type: "watchThread", threadId: "one" }, "a");
  assert(calls.length > count);
});

test("历史合并请求失败可重试，发送接续后迟到的历史不能覆盖当前状态", async t => {
  const { hub, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one" }, "a");
  const bridge = hub.sessions.get("one"), open = bridge.historyPager.open.bind(bridge.historyPager);
  bridge.historyPager.open = async () => { throw new Error("fixture failure"); };
  await assert.rejects(hub.dispatch({ type: "watchThread", threadId: "one" }, "a"), /fixture failure/);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  bridge.historyPager.open = async id => { started(); await new Promise(resolve => { release = resolve; }); return open(id); };
  const watching = hub.dispatch({ type: "watchThread", threadId: "one", requestId: "late" }, "a");
  await entered;
  await hub.dispatch({ type: "prompt", text: "running", threadId: "one" }, "b");
  release(); await watching;
  assert(messages.some(m => m.requestId === "late" && m.skipped));
  assert.equal(bridge.state.status, "running");
});

test("切换只读历史不检查占用，两个会话可以同时执行且通知不串话", async t => {
  const { hub, calls, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one", historyMode: "paged", checkWriter: true }, "phone");
  await hub.dispatch({ type: "prompt", text: "first", threadId: "one" }, "phone");
  await hub.dispatch({ type: "readThread", threadId: "two", historyMode: "paged" }, "phone");
  assert.equal(hub.sessions.get("one").state.status, "running");
  await hub.dispatch({ type: "prompt", text: "second", threadId: "two" }, "phone");
  assert.equal(hub.sessions.get("two").state.status, "running");
  const first = hub.sessions.get("one");
  hub.control.codex.onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: first.state.turnId, status: "completed" } } });
  assert.equal(first.state.status, "idle");
  assert.equal(hub.sessions.get("two").state.status, "running");
  assert(!calls.some(c => c.method === "thread/unsubscribe"));
  assert(!messages.some(m => m.type === "writerConflict"));
});

test("两个浏览器的选择相互独立，命令不能落入另一个选中会话", async t => {
  const { hub, calls, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one", requestId: "a" }, "a");
  await hub.dispatch({ type: "readThread", threadId: "two", requestId: "b" }, "b");
  messages.length = 0;
  await hub.dispatch({ type: "getState" }, "a");
  assert.equal(messages.find(m => m.type === "hello").state.threadId, "one");
  await hub.dispatch({ type: "prompt", text: "hello" }, "a");
  assert.equal(calls.findLast(c => c.method === "turn/start").params.threadId, "one");
});

test("临时会话使用独立目录，归属元数据在实例重建后保留", async t => {
  const { hub, calls, dir } = fixture(t);
  await hub.dispatch({ type: "newThread", scope: "temporary" }, "a");
  const start = calls.find(c => c.method === "thread/start");
  assert.notEqual(start.params.cwd, dir);
  assert.equal(path.dirname(start.params.cwd), path.join(dir, "temporary"));
  const id = hub.selected.get("a");
  assert.equal(hub.sessions.get(id).state.projectless, true);
  const restored = new SessionHub({ defaultCwd: dir }, () => {}, undefined, { dataDir: dir });
  assert.equal(restored.metadata[id].projectless, true);
});

test("旁观刷新只使用读取接口并返回有界最新页", async t => {
  const { hub, calls, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one", historyMode: "paged" }, "a");
  calls.length = 0;
  await hub.dispatch({ type: "watchThread", threadId: "one", requestId: "watch" }, "a");
  assert(calls.every(c => ["thread/read", "thread/turns/list"].includes(c.method)));
  assert(messages.some(m => m.type === "historyUpdate" && m.requestId === "watch"));
});

test("重启等待所有运行任务并保留队列，恢复后暂停且不重复执行", async t => {
  const { hub, calls, dir } = fixture(t);
  let restarts = 0;
  enableServiceRestart(hub, async () => { restarts++; });
  await hub.dispatch({ type: "readThread", threadId: "one" }, "a");
  await hub.dispatch({ type: "prompt", text: "running" }, "a");
  await hub.dispatch({ type: "enqueuePrompt", text: "later", requestId: "queued" }, "a");
  await hub.dispatch({ type: "restartService", confirmed: true, requestId: "restart-one" }, "a");
  assert.equal(restarts, 0);
  assert.equal(hub.restart.phase, "waiting");
  const b = hub.sessions.get("one");
  hub.notification({ method: "turn/completed", params: { threadId: "one", turn: { id: b.state.turnId, status: "completed" } } });
  await b.commandQueue; await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarts, 1);
  assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
  const restored = new SessionHub({ defaultCwd: dir }, () => {}, undefined, { dataDir: dir });
  enableServiceRestart(restored, async () => {}); restored.restoreQueues();
  const queue = restored.sessions.get("one").promptQueue.snapshot();
  assert.equal(queue.paused, true); assert.equal(queue.items[0].text, "later");
  assert(queue.acceptedRequestIds.includes("queued"));
  assert.equal(fs.existsSync(path.join(dir, "restart-queue.json")), false);
  await restored.dispatch({ type: "restartService", confirmed: true, requestId: "restart-one" });
  assert.equal(restored.restart.phase, "idle", "受控重启后的重复请求不能再次重启");
});

test("取消等待重启恢复原队列状态，未确认或不支持的重启被拒绝", async t => {
  const { hub } = fixture(t);
  enableServiceRestart(hub, undefined);
  await assert.rejects(hub.dispatch({ type: "restartService", confirmed: true, requestId: "x" }), /不支持/);
  enableServiceRestart(hub, async () => {});
  await assert.rejects(hub.dispatch({ type: "restartService", requestId: "x" }), /确认/);
  await hub.dispatch({ type: "readThread", threadId: "one" });
  await hub.dispatch({ type: "prompt", text: "running" });
  await hub.dispatch({ type: "restartService", confirmed: true, requestId: "x" });
  await hub.dispatch({ type: "cancelRestart" });
  assert.equal(hub.restart.phase, "idle");
  assert.equal(hub.sessions.get("one").promptQueue.snapshot().paused, false);
});

test("尚未选会话时保存配置后直接发送能创建会话，旧客户端保留完整历史模式", async t => {
  const { hub, calls } = fixture(t);
  await hub.dispatch({ type: "setConfig", sandbox: "read-only", approvalPolicy: "never" });
  await hub.dispatch({ type: "prompt", text: "first" });
  assert.equal(calls.filter(c => c.method === "turn/start").length, 1);
  assert.equal(hub.sessions.values().next().value.history, null);
});

test("后台审批按会话分发，停止一个会话不影响另一个", async t => {
  const { hub, calls, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one" }, "a");
  await hub.dispatch({ type: "prompt", text: "one" }, "a");
  await hub.dispatch({ type: "readThread", threadId: "two" }, "a");
  await hub.dispatch({ type: "prompt", text: "two" }, "a");
  messages.length = 0;
  hub.serverRequest({ id: 123, method: "item/commandExecution/requestApproval", params: { threadId: "one", command: "fixture" } });
  assert.equal(hub.sessions.get("one").pendingApprovals.size, 1);
  assert.equal(hub.sessions.get("two").pendingApprovals.size, 0);
  assert(!messages.some(m => m.type === "approval"));
  assert(messages.some(m => m.type === "sessions" && m.sessions.find(s => s.threadId === "one")?.approvals === 1));
  await hub.dispatch({ type: "interrupt", threadId: "one" }, "a");
  assert.equal(calls.findLast(c => c.method === "turn/interrupt").params.threadId, "one");
  assert.equal(hub.sessions.get("two").state.status, "running");
});

test("关闭空闲标签释放自身订阅，运行中会话保留", async t => {
  const { hub, calls } = fixture(t);
  await hub.dispatch({ type: "newThread", scope: "project" }, "a");
  const idle = hub.selected.get("a");
  await hub.dispatch({ type: "closeThread", threadId: idle }, "a");
  assert(!hub.sessions.has(idle));
  assert(calls.some(c => c.method === "thread/unsubscribe"));
  await hub.dispatch({ type: "readThread", threadId: "one" }, "a");
  await hub.dispatch({ type: "prompt", text: "active" }, "a");
  await hub.dispatch({ type: "closeThread", threadId: "one" }, "a");
  assert.equal(hub.sessions.get("one").state.status, "running");
});

test("缓慢旁观读取不阻塞同一客户端的停止命令", async t => {
  const { hub, calls } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one" }, "a");
  await hub.dispatch({ type: "prompt", text: "active" }, "a");
  await hub.dispatch({ type: "readThread", threadId: "two", historyMode: "paged" }, "a");
  let release;
  const b = hub.sessions.get("two"), open = b.historyPager.open.bind(b.historyPager);
  b.historyPager.open = async id => { await new Promise(resolve => { release = resolve; }); return open(id); };
  const watching = hub.dispatch({ type: "watchThread", threadId: "two" }, "a");
  await new Promise(resolve => setImmediate(resolve));
  try {
    await hub.dispatch({ type: "interrupt", threadId: "one" }, "a");
    assert.equal(calls.at(-1).method, "turn/interrupt");
  } finally { release(); await watching; }
});

test("发送后快速切换，后台迟到的接续快照不能拉回旧会话", async t => {
  const { hub, messages } = fixture(t);
  await hub.dispatch({ type: "readThread", threadId: "one", historyMode: "paged" }, "a");
  const original = hub.control.codex.request;
  let release, started;
  const resuming = new Promise(resolve => { started = resolve; });
  hub.control.codex.request = async (method, params) => {
    if (method === "thread/resume" && params.threadId === "one") { started(); await new Promise(resolve => { release = resolve; }); }
    return original(method, params);
  };
  await hub.dispatch({ type: "enqueuePrompt", text: "queued", requestId: "race" }, "a");
  await resuming;
  await hub.dispatch({ type: "readThread", threadId: "two", historyMode: "paged" }, "a");
  messages.length = 0;
  release(); await hub.sessions.get("one").commandQueue;
  assert.equal(hub.selected.get("a"), "two");
  assert(!messages.some(m => m.type === "hello" && m.state.threadId === "one" && m.clientId === "a"));
  assert.equal(hub.sessions.get("one").state.status, "running");
});
