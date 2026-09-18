import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { WriterControl, validateThreadId, isWriterConflict } from "../core/writerControl.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";

const ID = "01a0704b-e9f9-7922-b3a3-203506ce0433";
const OTHER = "01a09357-e7af-7572-a93a-32c4f9c742d4";
const OWNER = { pid: 1234, name: "codex", started: "134336519147918381", canTerminate: true, affectedThreads: [ID, OTHER] };

function fixture(overrides = {}) {
  const calls = [];
  const control = new WriterControl({
    home: path.resolve("test-home"), platform: "win32", protectedPids: () => [9999],
    runner: async (args) => { calls.push(args); return args.action === "inspect" ? { owners: [{ ...OWNER }] } : { terminated: true }; },
    ...overrides,
  });
  return { control, calls };
}

test("writer lock paths accept only UUIDs and stay inside the lock directory", () => {
  const { control } = fixture();
  assert.equal(control.lockFile(ID), path.resolve("test-home", "thread-writer-locks", ID + ".lock"));
  assert.equal(validateThreadId(ID.toUpperCase()), ID);
  for (const value of ["../other", "", "x.lock", null, 1, ID + "\other"]) assert.throws(() => control.lockFile(value));
});

test("only the specific active-writer error offers process takeover", () => {
  assert(isWriterConflict(new Error('{"code":-32600,"message":"thread already has an active writer"}')));
  assert(!isWriterConflict(new Error("permission denied")));
});

test("inspection is read-only and exposes collateral conversations before confirmation", async () => {
  const { control, calls } = fixture();
  const conflict = await control.inspect(ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "inspect");
  assert.deepEqual(conflict.owners[0].affectedThreads, [ID, OTHER]);
  assert.equal(conflict.owners[0].canTerminate, true);
  assert(conflict.owners[0].token);
  assert.equal(conflict.owners[0].started, undefined);
});

test("a single-use confirmation is bound to PID, start time, thread and affected threads", async () => {
  const { control, calls } = fixture();
  const { token } = (await control.inspect(ID)).owners[0];
  await assert.rejects(control.terminate(ID, token, false), /确认/);
  await assert.rejects(control.terminate(OTHER, token, true), /确认/);
  assert.equal(calls.length, 1);
  assert.equal(await control.terminate(ID, token, true), OWNER.pid);
  assert.equal(calls[1].pid, OWNER.pid);
  assert.equal(calls[1].started, OWNER.started);
  assert.deepEqual(calls[1].affectedThreads, [ID, OTHER]);
  assert.equal(calls[1].lockFile, control.lockFile(ID));
  await assert.rejects(control.terminate(ID, token, true), /确认/);
});

test("expired confirmations cannot stop a process", async () => {
  let now = 0;
  const { control, calls } = fixture({ now: () => now });
  const { token } = (await control.inspect(ID)).owners[0];
  now = 60001;
  await assert.rejects(control.terminate(ID, token, true), /失效/);
  assert.equal(calls.length, 1);
});

test("current relay and its app-server processes cannot be selected for termination", async () => {
  const { control } = fixture({ protectedPids: () => [OWNER.pid] });
  const conflict = await control.inspect(ID);
  assert.equal(conflict.owners[0].canTerminate, false);
  assert.equal(conflict.owners[0].token, null);
});

test("process protection is checked again immediately before termination", async () => {
  let protectedPids = [];
  const { control, calls } = fixture({ protectedPids: () => protectedPids });
  const { token } = (await control.inspect(ID)).owners[0];
  protectedPids = [OWNER.pid];
  await assert.rejects(control.terminate(ID, token, true), /控制进程/);
  assert.equal(calls.length, 1);
});

test("ambiguous lock owners and non-Codex processes do not get termination tokens", async () => {
  for (const owners of [[{ ...OWNER, canTerminate: false }], [OWNER, { ...OWNER, pid: 5678 }]]) {
    const { control } = fixture({ runner: async () => ({ owners }) });
    assert((await control.inspect(ID)).owners.every((owner) => !owner.canTerminate && !owner.token));
  }
});

test("unsupported platforms never run process inspection or termination", async () => {
  const { control, calls } = fixture({ platform: "linux" });
  const conflict = await control.inspect(ID);
  assert.deepEqual(conflict.owners, []);
  assert.equal(calls.length, 0);
  await assert.rejects(control.terminate(ID, "anything", true));
});

test("inspection permission errors still produce a conflict window without kill controls", async () => {
  const { control } = fixture({ runner: async () => { throw new Error("permission denied"); } });
  const conflict = await control.inspect(ID);
  assert.equal(conflict.type, "writerConflict");
  assert.deepEqual(conflict.owners, []);
  assert.equal(conflict.message, "permission denied");
});

test("failed or unconfirmed process exit never implies successful takeover", async () => {
  for (const fails of [true, false]) {
    const { control } = fixture({ runner: async ({ action }) => {
      if (action === "inspect") return { owners: [OWNER] };
      if (fails) throw new Error("owner changed");
      return { terminated: false };
    } });
    const { token } = (await control.inspect(ID)).owners[0];
    await assert.rejects(control.terminate(ID, token, true));
    await assert.rejects(control.terminate(ID, token, true), /确认/);
  }
});

function bridgeFixture() {
  const messages = [], calls = [];
  const bridge = new CodexBridge({ defaultCwd: "project", model: "model", approvalPolicy: "on-request", sandbox: "read-only" }, (m) => messages.push(structuredClone(m)));
  Object.assign(bridge.state, { threadId: OTHER, codexConnected: true, readOnly: true });
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "turn/interrupt") return {};
    if (method === "thread/resume") return { thread: { id: ID, turns: [{ id: "active-turn", status: "inProgress", items: [] }] } };
    throw new Error("Unexpected method");
  };
  return { bridge, calls, messages };
}

test("a conflicting resume preserves the old conversation and offers inspection without killing", async () => {
  const { bridge, messages } = bridgeFixture();
  bridge.codex.request = async () => { throw new Error("thread " + ID + " already has an active writer"); };
  let kills = 0;
  bridge.writers = { inspect: async (threadId) => ({ type: "writerConflict", threadId }), terminate: async () => { kills++; } };
  await bridge.dispatch({ type: "resumeThread", threadId: ID });
  assert.equal(bridge.state.threadId, OTHER);
  assert.equal(kills, 0);
  assert.equal(messages.at(-1).type, "writerConflict");
});

test("resuming an active thread retains its turn ID so stopping sends valid parameters", async () => {
  const { bridge, calls } = bridgeFixture();
  await bridge.dispatch({ type: "resumeThread", threadId: ID });
  assert.equal(bridge.state.status, "running");
  assert.equal(bridge.state.turnId, "active-turn");
  await bridge.dispatch({ type: "interrupt" });
  assert.deepEqual(calls.at(-1), { method: "turn/interrupt", params: { threadId: ID, turnId: "active-turn" } });
});

test("takeover resumes only after a confirmed successful process exit", async () => {
  const { bridge, calls } = bridgeFixture();
  let terminated = false;
  bridge.writers.terminate = async (threadId, token, confirmed) => {
    assert.equal(threadId, ID); assert.equal(token, "token"); assert.equal(confirmed, true);
    assert.equal(calls.length, 0); terminated = true;
  };
  await bridge.dispatch({ type: "takeoverThread", threadId: ID, token: "token", confirmed: true });
  assert(terminated);
  assert.equal(bridge.state.threadId, ID);
  assert.equal(calls[0].method, "thread/resume");
});

test("failed termination cannot switch conversations or resume the target", async () => {
  const { bridge, calls } = bridgeFixture();
  bridge.writers.terminate = async () => { throw new Error("process changed"); };
  await assert.rejects(bridge.dispatch({ type: "takeoverThread", threadId: ID, token: "token", confirmed: true }));
  assert.equal(bridge.state.threadId, OTHER);
  assert.equal(calls.length, 0);
});

test("进入会话的检查仅提示外部持有者，不把本中继占用当成外部冲突", async () => {
  const external = fixture();
  const conflict = await external.control.inspectExternal(ID);
  assert.equal(conflict.owners[0].pid, OWNER.pid);
  assert.ok(conflict.owners[0].token);
  assert.equal(external.calls[0].action, "inspect");
  const own = fixture({ protectedPids: () => [OWNER.pid] });
  assert.equal(await own.control.inspectExternal(ID), null);
  assert.equal(own.control.confirmations.size, 0);
  const empty = fixture({ runner: async () => ({ owners: [] }) });
  assert.equal(await empty.control.inspectExternal(ID), null);
});

test("外部检查保留探测失败状态，不谎报无人占用；不支持的平台不运行探测", async () => {
  const failed = fixture({ runner: async () => { throw new Error("检测权限不足"); } });
  assert.equal((await failed.control.inspectExternal(ID)).inspectionFailed, true);
  const unsupported = fixture({ platform: "linux" });
  assert.equal(await unsupported.control.inspectExternal(ID), null);
  assert.equal(unsupported.calls.length, 0);
});

test("打开被占用会话时先返回绑定选择请求的冲突，不加载历史、不释放旧会话、不接续", async () => {
  const { bridge, messages, calls } = bridgeFixture();
  bridge.state.readOnly = false;
  bridge.eventLog = [{ id: "old", kind: "user", text: "保留旧历史" }];
  const { control, calls: inspections } = fixture();
  bridge.writers = control;
  await bridge.dispatch({ type: "readThread", threadId: ID, historyMode: "paged", requestId: "selection-1", checkWriter: true });
  assert.equal(calls.length, 0);
  assert.equal(inspections.length, 1); assert.equal(inspections[0].action, "inspect");
  assert.equal(bridge.state.threadId, OTHER); assert.equal(bridge.state.readOnly, false);
  assert.equal(bridge.eventLog[0].text, "保留旧历史");
  assert.deepEqual([messages.at(-1).type, messages.at(-1).onOpen, messages.at(-1).requestId], ["writerConflict", true, "selection-1"]);
});

test("空闲会话正常打开，仅查看历史可明确跳过外部检查，两者都不抢占会话", async () => {
  for (const checkWriter of [true, false]) {
    const { bridge, messages, calls } = bridgeFixture();
    let inspections = 0;
    bridge.writers.inspectExternal = async () => { inspections++; return null; };
    bridge.codex.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: ID, turns: [] } }; };
    await bridge.dispatch({ type: "readThread", threadId: ID, requestId: "selection", checkWriter });
    assert.equal(inspections, checkWriter ? 1 : 0);
    assert.equal(bridge.state.threadId, ID); assert.equal(bridge.state.readOnly, true);
    assert.deepEqual(calls.map(c => c.method), ["thread/read"]);
    assert.equal(messages.at(-1).type, "hello"); assert.equal(messages.at(-1).requestId, "selection");
  }
});

test("解除自身占用不会走外部进程检查或结束路径", async () => {
  const { bridge, calls, messages } = bridgeFixture();
  bridge.writers.inspectExternal = bridge.writers.terminate = async () => { throw new Error("不应操作外部进程"); };
  bridge.codex.request = async (method, params) => { calls.push({ method, params }); return { status: "notLoaded" }; };
  await bridge.dispatch({ type: "releaseThread", threadId: OTHER, requestId: "release-self" });
  assert.deepEqual(calls.map(c => c.method), ["thread/unsubscribe"]);
  assert.equal(messages.at(-1).type, "threadReleased");
});
