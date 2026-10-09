import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createLocalRelay, existingRelay } from "../relay/transport.mjs";
import { SharedAgentHub } from "../core/sharedAgentHub.mjs";

const until = async fn => {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("fixture timeout");
};
function setup(t, sleep = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-shared-"));
  const calls = [], messages = [], config = { host: "127.0.0.1", port: 0, token: "fixture", defaultCwd: dir, terminalEnabled: false };
  const relay = createLocalRelay({ config, dataDir: dir, ...sleep });
  let starts = 0;
  relay.hub.control.start = async () => { starts++; relay.hub.control.state.codexConnected = true; };
  relay.hub.control.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: params.threadId, cwd: dir, turns: [] } };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    throw new Error("unexpected " + method);
  };
  const configPath = path.join(dir, "relay.json");
  let proxy;
  t.after(async () => {
    await proxy?.stop(); await relay.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith("codexapp-shared-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { relay, calls, messages, starts: () => starts, async connect(token = config.token) {
    config.port = await relay.start();
    fs.writeFileSync(configPath, JSON.stringify({ ...config, token }));
    proxy = new SharedAgentHub({ config: { relayConfigPath: configPath }, base: dir, root: dir, emit: m => messages.push(m) });
    await proxy.start(); return proxy;
  } };
}

test("防休眠失败与恢复状态进入直连快照，并经共享中继转发至云端客户端", async t => {
  const sleepEvents = new EventEmitter();
  let status = { supported: true, enabled: true, active: false, phase: "retrying", error: "helper startup timed out", retryCount: 1, nextRetryAt: Date.now() + 1000 };
  const fixture = setup(t, { sleepStatus: () => status, sleepEvents });
  const proxy = await fixture.connect();
  const hello = await proxy.attach("phone");
  assert.deepEqual(hello.sleepPrevention, status);
  status = { ...status, active: true, phase: "active", error: null, retryCount: 0, nextRetryAt: null };
  sleepEvents.emit("status", status);
  await until(() => fixture.messages.some(m => m.type === "sleepPrevention" && m.clientId === "phone"));
  assert.deepEqual(fixture.messages.find(m => m.type === "sleepPrevention" && m.clientId === "phone").status, status);
  await proxy.stop(); await fixture.relay.close();
  assert.equal(sleepEvents.listenerCount("status"), 0);
});

test("Agent 复用正在运行的直连核心，两个客户端选中状态独立，退出适配器不停止中继", async t => {
  const { connect, relay, messages, starts } = setup(t);
  const proxy = await connect();
  assert.equal(proxy.owner, undefined);
  await proxy.attach("cloud-one"); await proxy.attach("cloud-two");
  await proxy.dispatch({ type: "readThread", threadId: "one", requestId: "first" }, "cloud-one");
  await proxy.dispatch({ type: "readThread", threadId: "two", requestId: "second" }, "cloud-two");
  await until(() => messages.some(m => m.requestId === "second"));
  assert.equal(relay.hub.selected.get("cloud-one"), "one");
  assert.equal(relay.hub.selected.get("cloud-two"), "two");
  assert.equal(messages.find(m => m.requestId === "first").clientId, "cloud-one");
  assert.equal(starts(), 1);
  assert.equal(await existingRelay(proxy.config), true);
  assert.equal(await existingRelay({ ...proxy.config, token: "wrong" }), false);
  proxy.disconnect("cloud-one");
  await until(() => !relay.hub.selected.has("cloud-one"));
  assert.equal(relay.hub.selected.get("cloud-two"), "two");
  await proxy.stop();
  assert(relay.server.listening);
  assert.equal(relay.hub.state.codexConnected, true);
});

test("Token 不匹配时明确拒绝复用，不能另起一个 Codex 进程", async t => {
  const { connect, starts, relay } = setup(t);
  await assert.rejects(connect("wrong-token"), /token/);
  assert.equal(starts(), 1);
  assert(relay.server.listening);
});
