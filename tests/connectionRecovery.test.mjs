import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watchSocket } from "../core/socketLiveness.mjs";
import { supervise } from "../scripts/supervisor.mjs";
import { CodexClient, CodexBridge } from "../core/codexBridge.mjs";

test("静默断网的 WebSocket 在心跳超时后关闭，健康连接不被关闭", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, ping() { this.pings++; }, pings: 0,
    terminate() { this.dead = true; this.emit("close"); } });
  watchSocket(ws, { interval: 100, timeout: 50 });
  t.mock.timers.tick(100); assert.equal(ws.pings, 1);
  ws.emit("pong"); t.mock.timers.tick(50); assert(!ws.dead);
  t.mock.timers.tick(50); t.mock.timers.tick(50); assert(ws.dead);
});

test("Codex RPC 超时移除等待记录，晚到响应不影响后续请求", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CodexClient();
  client.child = { stdin: { write(_data, cb) { cb?.(); } }, exitCode: null, signalCode: null };
  const failed = assert.rejects(client.request("initialize", {}, { timeoutMs: 100 }), /timed out/);
  t.mock.timers.tick(100); await failed; assert.equal(client.pending.size, 0);
  client._dispatch({ id: 1, result: {} });
  const result = client.request("config/read", {}, { timeoutMs: 100 });
  client._dispatch({ id: 2, result: { config: { model: "new" } } });
  assert.equal((await result).config.model, "new"); assert.equal(client.pending.size, 0);
});

test("结束输入后的存活控制进程不能重复启动", t => {
  const client = new CodexClient(process.execPath);
  const existing = { stdin: { destroyed: true, writableEnded: true }, exitCode: null, signalCode: null };
  client.child = existing;
  t.after(() => { if (client.child !== existing) client.child?.kill(); });
  assert.throws(() => client.start(), /仍在运行/);
});

test("连续两次健康检查超时才回收自己的 Codex，正常 RPC 错误不触发重启", async () => {
  let killed = 0, hang = false;
  const client = { child: { kill() { killed++; } }, request: async () => {
    const error = new Error("fixture"); if (hang) error.code = "CODEX_RPC_TIMEOUT"; throw error;
  } };
  const bridge = new CodexBridge({}, () => {}, undefined, { client });
  bridge.state.codexConnected = true;
  await bridge.checkHealth(); assert.equal(killed, 0);
  hang = true; await bridge.checkHealth(); assert.equal(killed, 0);
  await bridge.checkHealth(); assert.equal(killed, 1); bridge.stopRecovery();
});

test("系统长时间挂起后唤醒先探测连接，心跳监听随关闭清理", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, ping() { this.emit("pong"); }, terminate() { assert.fail("健康连接不应关闭"); } });
  watchSocket(ws, { interval: 100, timeout: 50 });
  t.mock.timers.tick(2 * 86400000);
  ws.emit("close"); assert.equal(ws.listenerCount("pong"), 0);
});

test("进程异常退出自动退避重启，主动停止和正常退出不重启", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const children = [];
  const supervisor = supervise(() => { const child = new EventEmitter(); child.kill = () => child.emit("exit", null, "SIGTERM"); children.push(child); return child; }, { logger: { error() {} } });
  children[0].emit("exit", 1, null);
  t.mock.timers.tick(999); assert.equal(children.length, 1);
  t.mock.timers.tick(1); assert.equal(children.length, 2);
  children[1].emit("exit", 1, null);
  t.mock.timers.tick(1999); assert.equal(children.length, 2);
  t.mock.timers.tick(1); assert.equal(children.length, 3);
  supervisor.stop(); t.mock.timers.tick(60000); assert.equal(children.length, 3);
  const clean = supervise(() => { const child = new EventEmitter(); child.kill = () => {}; children.push(child); return child; });
  children.at(-1).emit("exit", 0, null); t.mock.timers.tick(60000); assert.equal(children.length, 4); clean.stop();
});

test("启动器能回收卡住的子进程，电脑休眠唤醒后先重新探测", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const children = []; let responding = true;
  const supervisor = supervise(() => {
    const child = new EventEmitter(); child.connected = true;
    child.send = () => { if (responding) child.emit("message", { type: "codexapp-health" }); };
    child.kill = () => { child.killed = true; child.emit("exit", null, "SIGTERM"); };
    children.push(child); return child;
  }, { logger: { error() {} } });
  t.mock.timers.tick(2 * 86400000); assert(!children[0].killed);
  responding = false;
  for (let i = 0; i < 7; i++) t.mock.timers.tick(10000);
  assert(children[0].killed); t.mock.timers.tick(1000); assert.equal(children.length, 2);
  supervisor.stop();
});

test("退避等待期间停止启动器立即退出，不能因父级 IPC 保持而挂住", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let finished = false, starts = 0;
  const child = new EventEmitter();
  const supervisor = supervise(() => { starts++; return child; }, { logger: { error() {} }, finished: () => { finished = true; } });
  child.emit("exit", 1, null); supervisor.stopManaged();
  assert(finished); t.mock.timers.tick(30000); assert.equal(starts, 1);
});
