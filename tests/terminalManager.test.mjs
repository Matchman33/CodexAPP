import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { TerminalManager } from "../core/terminalManager.mjs";

test("终端在指定目录启动，输入、缩放与退出独立于 AI 会话", async () => {
  const messages = [], writes = [], sizes = [];
  let output, exited, spawned;
  const manager = new TerminalManager(m => messages.push(m), { spawn: (file, args, options) => {
    spawned = options;
    return { pid: 42, onData: cb => { output = cb; }, onExit: cb => { exited = cb; }, write: text => writes.push(text), resize: (cols, rows) => sizes.push([cols, rows]), pause() {}, resume() {}, kill: () => exited({ exitCode: 0 }) };
  } });
  const opened = await manager.open({ cwd: os.tmpdir(), threadId: "one", cols: 80, rows: 24 }, "browser-a");
  assert.equal(spawned.cwd.toLowerCase(), os.tmpdir().toLowerCase());
  manager.input({ ...opened, data: "cd subdir\r", inputSeq: 1 }, "browser-a");
  manager.input({ ...opened, data: "\x03", inputSeq: 2 }, "browser-a");
  manager.resize({ ...opened, cols: 100, rows: 30 }, "browser-a");
  assert.deepEqual(writes.slice(-2), ["cd subdir\r", "\x03"]);
  assert.deepEqual(sizes.at(-1), [100, 30]);
  output("fixture-output\r\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(messages.some(m => m.type === "terminalOutput" && m.data.includes("fixture-output")));
  await manager.close({ ...opened, confirmed: true }, "browser-a");
  assert.equal(manager.activeCount, 0);
  manager.dispose();
});

function fixture() {
  const messages = [], writes = []; let output, exit;
  const manager = new TerminalManager(m => messages.push(m), { spawn: () => ({
    onData: cb => { output = cb; }, onExit: cb => { exit = cb; }, write: data => writes.push(data), resize() {}, pause() {}, resume() {}, kill: () => exit({ exitCode: 0 }),
  }) });
  return { manager, messages, writes, output: data => output(data) };
}

test("多页面可查看，未接管页面不能输入，断线重连不重放命令", async () => {
  const { manager, writes, output } = fixture();
  const a = await manager.open({ cwd: os.tmpdir() }, "a");
  const b = await manager.attach({ terminalId: a.terminalId }, "b");
  assert.equal(b.canInput, false);
  assert.throws(() => manager.input({ ...b, data: "bad\r", inputSeq: 1 }, "b"), /控制权/);
  manager.input({ ...a, data: "once\r", inputSeq: 1 }, "a");
  manager.input({ ...a, data: "once\r", inputSeq: 1 }, "a");
  assert.equal(writes.length, 1);
  output("\x1b[32mretained\x1b[0m\r\n");
  manager.detach("a");
  const restored = await manager.attach({ terminalId: a.terminalId }, "new-a");
  assert(restored.data.includes("retained"));
  assert.equal(restored.canInput, true);
  assert.equal(writes.length, 1, "连接不得重放先前输入");
  assert.throws(() => manager.input({ ...a, data: "stale\r", inputSeq: 2 }, "a"), /控制权/);
  const takeover = await manager.attach({ terminalId: a.terminalId, takeControl: true }, "b");
  assert.throws(() => manager.input({ ...restored, data: "stale\r", inputSeq: 1 }, "new-a"), /控制权/);
  await manager.close({ ...takeover, confirmed: true }, "b");
});

test("慢页面停止接收无界输出，重连恢复当前屏幕", async () => {
  const { manager, messages, output } = fixture();
  const opened = await manager.open({ cwd: os.tmpdir() }, "a");
  output("x".repeat(200000));
  const restored = await manager.attach({ terminalId: opened.terminalId }, "a");
  assert(messages.some(m => m.type === "terminalPaused"));
  assert(messages.filter(m => m.type === "terminalOutput").reduce((sum, m) => sum + m.data.length, 0) <= 131072);
  assert(restored.data.length <= 1048576);
  assert(restored.data.includes("x"));
  await manager.close({ ...restored, confirmed: true }, "a");
});

test("非法输入与未经确认的关闭不能操作 PTY", async () => {
  const { manager, writes } = fixture();
  const opened = await manager.open({ cwd: os.tmpdir() }, "a");
  for (const data of [null, {}, "x".repeat(16385)]) assert.throws(() => manager.input({ ...opened, data, inputSeq: 1 }, "a"));
  assert.throws(() => manager.resize({ ...opened, cols: -1, rows: 20 }, "a"));
  await assert.rejects(manager.close({ ...opened }, "a"), /确认/);
  assert.equal(manager.activeCount, 1); assert.equal(writes.length, 0);
  await manager.close({ ...opened, confirmed: true }, "a");
});
