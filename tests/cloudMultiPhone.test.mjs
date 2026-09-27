import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LinkRouter } from "../cloud/linkRouter.mjs";
import { AgentPhones } from "../cloud/agentPhones.mjs";
import { newKeyPair, seal, open, sas } from "../cloud/e2e.mjs";
import { SessionHub } from "../core/sessionHub.mjs";

function socket() {
  return { readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); },
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; } };
}
function join(router, account, role, multiPhone = true) {
  const ws = socket();
  router.join(ws, account, { role, multiPhone, pubkey: newKeyPair().publicKey });
  return ws;
}

test("不同账号隔离，同账号多手机定向收发且不能伪造路由身份", () => {
  const router = new LinkRouter();
  const a = join(router, "a", "agent"), b = join(router, "b", "agent");
  const p = join(router, "a", "phone"), q = join(router, "a", "phone"), other = join(router, "b", "phone");
  for (const ws of [a, b, p, q, other]) ws.messages = [];
  router.forward(p, { type: "e2e", phoneId: other.phoneId, accountId: "b", box: "p", nonce: "n" });
  assert.equal(a.messages[0].phoneId, p.phoneId);
  assert.equal(b.messages.length, 0);
  router.forward(a, { type: "e2e", phoneId: p.phoneId, box: "reply", nonce: "n" });
  assert.equal(p.messages[0].box, "reply");
  assert.equal(q.messages.length, 0);
  router.forward(a, { type: "e2e", phoneId: other.phoneId, box: "wrong" });
  assert.equal(other.messages.length, 0);
  router.forward(a, { type: "e2e", box: "no target" });
  assert.equal(q.messages.length, 0);
  router.leave(p);
  router.forward(p, { type: "e2e", box: "stale" });
  assert(!a.messages.some(m => m.box === "stale"));
  assert.equal(a.messages.at(-1).phoneId, p.phoneId);
  assert.equal(router.rooms.get("a").phones.size, 1);
  router.forward(q, { type: "e2e", box: "still connected" });
  assert.equal(a.messages.at(-1).box, "still connected");
});

test("无设备身份的旧 Agent 不能共存，原路由保留；断线重连可发现所有手机", () => {
  const router = new LinkRouter();
  const p = join(router, "a", "phone"), q = join(router, "a", "phone");
  const a = join(router, "a", "agent");
  assert.equal(a.messages[0].peers.length, 2);
  const duplicate = join(router, "a", "agent");
  assert.equal(duplicate.messages[0].code, "agent_already_online");
  router.leave(duplicate);
  assert.equal(router.rooms.get("a").agents.get("legacy"), a);
  router.leave(a);
  assert.equal(p.messages.at(-1).online, false);
  const next = join(router, "a", "agent");
  assert.deepEqual(next.messages[0].peers.map(x => x.phoneId), [p.phoneId, q.phoneId]);
  router.leave(a);
  assert.equal(router.rooms.get("a").agents.get("legacy"), next);
  router.disconnectAccount("a");
  assert.equal(router.rooms.size, 0);
  assert([next, p, q].every(ws => ws.closed?.code === 4001));
  router.forward(next, { type: "e2e", phoneId: p.phoneId, box: "deleted" });
  assert(!p.messages.some(m => m.box === "deleted"));
});

test("旧 Agent 保留单手机兼容，第二个手机明确拒绝", () => {
  const router = new LinkRouter();
  const a = join(router, "a", "agent", false), p = join(router, "a", "phone");
  const q = join(router, "a", "phone");
  assert.equal(q.messages[0].code, "agent_upgrade_required");
  router.forward(a, { type: "e2e", box: "legacy" });
  assert.equal(p.messages.at(-1).box, "legacy");
  join(router, "b", "phone"); join(router, "b", "phone");
  assert.equal(join(router, "b", "agent", false).messages[0].code, "agent_upgrade_required");
});

function fixture(t, mode = "open") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-cloud-"));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith("codexapp-cloud-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const keys = newKeyPair(), pairing = { code: "ABCDEF", pinnedPhones: [] }, calls = [], outgoing = [];
  let phones, saved = 0;
  const hub = new SessionHub({ defaultCwd: dir, model: "fixture", approvalPolicy: "on-request", sandbox: "read-only" },
    m => phones.broadcast(m), undefined, { dataDir: dir });
  hub.control.state.codexConnected = true;
  hub.control.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (["thread/read", "thread/resume"].includes(method)) return { thread: { id: params.threadId, cwd: dir, turns: [] } };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "turn/start") return { turn: { id: "turn-" + params.threadId } };
    if (method === "model/list") return { data: [{ model: "fixture", isDefault: true }] };
    if (method === "config/read") return { config: { model: "fixture" } };
    if (method === "turn/interrupt") return {};
    throw new Error("unexpected: " + method);
  };
  hub.control.codex.respond = (id, result) => calls.push({ response: id, result });
  phones = new AgentPhones({ hub, keys, pairing, pairingMode: () => mode,
    savePairing: () => { saved++; }, send: m => outgoing.push(m) });
  function phone(id, key = newKeyPair()) {
    phones.online(id, key.publicKey);
    return { id, key, send: m => phones.receive({ phoneId: id, ...seal(m, keys.publicKey, key.secretKey) }),
      messages: () => outgoing.filter(m => m.phoneId === id).map(m => open(m, keys.publicKey, key.secretKey)) };
  }
  return { hub, phones, keys, pairing, calls, outgoing, phone, saved: () => saved };
}

test("两台旧手机即使没有 clientId 也独立选会话，停止和断线不影响另一台", async t => {
  const { hub, phones, calls, outgoing, phone, keys } = fixture(t);
  const p = phone("p"), q = phone("q");
  await p.send({ type: "readThread", threadId: "one", requestId: "p-read" });
  await q.send({ type: "readThread", threadId: "two", requestId: "q-read" });
  assert.equal(p.messages().find(m => m.requestId === "p-read").state.threadId, "one");
  assert(!q.messages().some(m => m.requestId === "p-read"));
  assert(outgoing.filter(m => m.phoneId === "p").every(m => open(m, keys.publicKey, q.key.secretKey) === null));
  await p.send({ type: "prompt", text: "first" });
  await q.send({ type: "prompt", text: "second" });
  assert.deepEqual(calls.filter(c => c.method === "turn/start").map(c => c.params.threadId), ["one", "two"]);
  await p.send({ type: "interrupt" });
  assert.equal(calls.at(-1).params.threadId, "one");
  const qHubId = phones.peers.get("q").hubId;
  const detach = [];
  hub.terminals.detach = id => detach.push(id);
  const pHubId = phones.peers.get("p").hubId;
  phones.offline("p");
  assert.deepEqual(detach, [pHubId]);
  assert.equal(hub.selected.get(qHubId), "two");
  assert.equal(hub.sessions.get("two").state.status, "running");
  await q.send({ type: "getState", requestId: "still here" });
  assert.equal(q.messages().find(m => m.requestId === "still here").state.threadId, "two");
});

test("相同网页 clientId 不会合并身份，同会话审批只处理一次并同步", async t => {
  const { hub, phones, calls, phone } = fixture(t);
  const p = phone("p"), q = phone("q", p.key);
  const command = { type: "readThread", threadId: "one", clientId: "same-web-id" };
  await p.send(command); await q.send(command);
  assert.notEqual(phones.peers.get("p").hubId, phones.peers.get("q").hubId);
  await p.send({ type: "prompt", text: "first", clientId: command.clientId });
  hub.serverRequest({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "one", command: "fixture" } });
  const approval = p.messages().find(m => m.type === "approval");
  assert.equal(approval.clientId, command.clientId);
  assert(q.messages().some(m => m.type === "approval" && m.approval.key === approval.approval.key));
  await p.send({ type: "approval", key: approval.approval.key, optionId: "approve", clientId: command.clientId });
  await q.send({ type: "approval", key: approval.approval.key, optionId: "approve", clientId: command.clientId });
  assert.equal(calls.filter(c => c.response === 42).length, 1);
  assert(q.messages().some(m => m.type === "approvalResolved"));
  assert(q.messages().some(m => m.type === "error" && /审批已失效/.test(m.message)));
  await p.send({ type: "getState", clientId: phones.peers.get("q").hubId, requestId: "spoof" });
  assert(p.messages().some(m => m.requestId === "spoof" && m.type === "error"));
  assert(!q.messages().some(m => m.requestId === "spoof"));
});

test("每台手机单独配对，未配对手机不能获取状态或命令；已配对手机重连免码", async t => {
  const { phones, keys, pairing, phone, calls, outgoing, saved } = fixture(t, "code");
  const p = phone("p"), q = phone("q");
  assert.equal(p.messages()[0].type, "needPairing");
  await p.send({ type: "pair", tag: sas(pairing.code, keys.publicKey, p.key.publicKey) });
  assert.equal(saved(), 1);
  assert(p.messages().some(m => m.type === "hello"));
  await q.send({ type: "prompt", text: "blocked" });
  await q.send({ type: "pair", tag: sas(pairing.code, keys.publicKey, p.key.publicKey) });
  assert(q.messages().some(m => m.type === "paired" && !m.ok));
  assert(!q.messages().some(m => m.type === "hello"));
  assert.equal(calls.length, 0);
  outgoing.length = 0;
  phones.broadcast({ type: "sessions", sessions: [] });
  assert.deepEqual(outgoing.map(m => m.phoneId), ["p"]);
  phones.offline("p");
  const reconnected = phone("p-new", p.key);
  assert.equal(reconnected.messages()[0].type, "hello");
  assert.equal(phones.peers.get("q").trusted, false);
});

test("断线时仍在读取的请求完成后只清理原连接，不能污染重连会话", async t => {
  const { hub, phones, phone } = fixture(t);
  const p = phone("p");
  const request = hub.control.codex.request;
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  hub.control.codex.request = async (method, params) => {
    if (method === "thread/read" && params.threadId === "slow") {
      started(); await new Promise(resolve => { release = resolve; });
    }
    return request(method, params);
  };
  const pending = p.send({ type: "readThread", threadId: "slow" });
  await waiting;
  const oldId = phones.peers.get("p").hubId;
  phones.offline("p");
  const next = phone("p", p.key);
  const nextId = phones.peers.get("p").hubId;
  await next.send({ type: "readThread", threadId: "new" });
  release(); await pending;
  assert(!hub.selected.has(oldId));
  assert.equal(hub.selected.get(nextId), "new");
});

test("多手机终端保留独立控制权，旁观手机断开不释放控制手机", async t => {
  const { hub, phones, phone } = fixture(t);
  const written = [];
  let exited;
  hub.terminals.spawn = () => ({ onData() {}, onExit: cb => { exited = cb; },
    write: data => written.push(data), resize() {}, pause() {}, resume() {}, kill: () => exited({ exitCode: 0 }) });
  hub.terminals.error = null;
  const p = phone("p"), q = phone("q");
  await p.send({ type: "terminalOpen", requestId: "open" });
  const opened = p.messages().find(m => m.type === "terminalAttached");
  assert(opened.canInput);
  await q.send({ type: "terminalAttach", terminalId: opened.terminalId });
  assert.equal(q.messages().find(m => m.type === "terminalAttached").canInput, false);
  await q.send({ type: "terminalInput", terminalId: opened.terminalId, lease: opened.lease, inputSeq: 1, data: "blocked" });
  assert.equal(written.length, 0);
  phones.offline("q");
  await p.send({ type: "terminalInput", terminalId: opened.terminalId, lease: opened.lease, inputSeq: 1, data: "allowed" });
  assert.deepEqual(written, ["allowed"]);
  await p.send({ type: "terminalClose", terminalId: opened.terminalId, lease: opened.lease, confirmed: true });
  assert.equal(hub.terminals.activeCount, 0);
});
