import test from "node:test";
import assert from "node:assert/strict";
import { LinkRouter } from "../cloud/linkRouter.mjs";
import { newKeyPair } from "../cloud/e2e.mjs";

const socket = () => ({ readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); }, close() { this.readyState = 3; } });
function agent(router, key, account = "account") {
  const ws = socket();
  router.join(ws, account, { role: "agent", multiPhone: true, pubkey: newKeyPair().publicKey, deviceKey: key, identityVerified: true, deviceName: "Same name" });
  return ws;
}
function phone(router, agentId, account = "account", multiAgent = true) {
  const ws = socket();
  router.join(ws, account, { role: "phone", multiAgent, agentId, pubkey: newKeyPair().publicKey });
  return ws;
}

test("同账号两台已验证电脑共存，选择与密文路由不能跨电脑或账号伪造", () => {
  const router = new LinkRouter(), a = agent(router, "a"), b = agent(router, "b"), other = agent(router, "other", "other");
  const waiting = phone(router, null), p = phone(router, a.agentId), q = phone(router, b.agentId), foreign = phone(router, other.agentId);
  assert.equal(waiting.messages[0].agents.length, 2);
  assert.equal(waiting.messages[0].peerOnline, false);
  assert.equal(foreign.messages[0].peerOnline, false);
  assert.notEqual(a.agentId, b.agentId);
  for (const ws of [a,b,p,q,other]) ws.messages = [];
  router.forward(p, { type: "e2e", agentId: b.agentId, phoneId: q.phoneId, box: "from-a", nonce: "n" });
  assert.equal(a.messages.at(-1).box, "from-a"); assert.equal(b.messages.length, 0);
  router.forward(a, { type: "e2e", phoneId: q.phoneId, box: "wrong" });
  assert.equal(q.messages.length, 0);
  router.forward(b, { type: "e2e", phoneId: q.phoneId, box: "from-b" });
  assert.equal(q.messages.at(-1).agentId, b.agentId);
  assert.equal(other.messages.length, 0);
  router.disconnectAccount("account");
  assert([a,b,p,q,waiting,foreign].every(ws => ws.readyState === 3)); assert.equal(other.readyState, 1);
});

test("目标离线不切换到其他电脑，同设备重连只替换自己的连接", () => {
  const router = new LinkRouter(), a = agent(router, "a"), b = agent(router, "b");
  const p = phone(router, a.agentId), q = phone(router, b.agentId);
  router.leave(a);
  assert.equal(p.agentId, a.agentId);
  assert(p.messages.some(m => m.type === "peer" && !m.online));
  const before = b.messages.length;
  router.forward(p, { type: "e2e", box: "must-not-failover" });
  assert.equal(b.messages.length, before);
  const next = agent(router, "a");
  assert.equal(next.messages[0].peers[0].phoneId, p.phoneId);
  const replacement = agent(router, "a");
  assert.equal(next.readyState, 3); assert.equal(b.readyState, 1);
  router.leave(next); router.leave(a);
  assert.equal(router.rooms.get("account").agents.get(a.agentId), replacement);
  assert.equal(q.agentId, b.agentId);
});

test("一台电脑自动选择，多台时旧手机明确要求升级，未选手机不会收到业务消息", () => {
  const router = new LinkRouter(), p = phone(router, null), a = agent(router, "a");
  assert.equal(p.agentId, a.agentId);
  const old = phone(router, null, "account", false); assert.equal(old.agentId, a.agentId);
  agent(router, "b");
  assert.equal(old.agentId, a.agentId);
  const rejected = phone(router, null, "account", false);
  assert.equal(rejected.messages[0].code, "agent_selection_required");
  const chooser = phone(router, null);
  router.forward(a, { type: "e2e", phoneId: chooser.phoneId, box: "blocked" });
  assert(!chooser.messages.some(m => m.type === "e2e"));
});
