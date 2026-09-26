import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { SessionHub } from "../core/sessionHub.mjs";
import { enableServiceRestart } from "../core/serviceRestart.mjs";

test("鉴权后的终端命令不依赖 Codex 连接，忽略客户端传入的工作目录并阻止误重启", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-terminal-hub-")), messages = [], calls = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let exit, spawned;
  const hub = new SessionHub({ defaultCwd: dir }, m => messages.push(m), undefined, { dataDir: dir, terminal: { spawn: (file, args, options) => {
    spawned = options;
    return { onData() {}, onExit: cb => { exit = cb; }, write: data => calls.push(data), resize() {}, pause() {}, resume() {}, kill: () => exit({ exitCode: 0 }) };
  } } });
  hub.control.codex.request = () => { throw new Error("不应请求模型接口"); };
  enableServiceRestart(hub, async () => { throw new Error("不应重启"); });
  await hub.dispatch({ type: "terminalOpen", cwd: "/untrusted", requestId: "open" }, "a");
  const opened = messages.find(m => m.type === "terminalAttached");
  assert.equal(spawned.cwd, dir);
  assert.equal(opened.clientId, "a");
  await hub.dispatch({ type: "terminalInput", ...{ terminalId: opened.terminalId, lease: opened.lease }, inputSeq: 1, data: "pwd\r" }, "a");
  assert.deepEqual(calls, ["pwd\r"]);
  await assert.rejects(hub.dispatch({ type: "terminalInput", terminalId: opened.terminalId, lease: opened.lease, inputSeq: 2, data: "wrong" }, "b"), /控制权/);
  await assert.rejects(hub.dispatch({ type: "restartService", confirmed: true, requestId: "restart" }, "a"), /活动终端/);
  assert.equal(hub.restart.phase, "idle");
  await hub.dispatch({ type: "terminalClose", terminalId: opened.terminalId, lease: opened.lease, confirmed: true }, "a");
  assert.equal(hub.terminals.activeCount, 0);
});
