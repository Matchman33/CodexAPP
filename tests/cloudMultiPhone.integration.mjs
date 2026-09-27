import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fork } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { newKeyPair, seal, open, sas } from "../cloud/e2e.mjs";
import { signDeviceChallenge } from "../cloud/deviceIdentity.mjs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

test("真实 Broker 与两个隔离 Agent：多账号、多手机、配对、断线与重连", { timeout: 40000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-cloud-process-"));
  const processes = [], sockets = [], logs = [];
  const until = async predicate => {
    for (let i = 0; i < 160; i++) {
      if (await predicate()) return;
      if (processes.some(p => p.exitCode !== null)) throw new Error("child exited: " + logs.join(""));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("timeout: " + logs.join(""));
  };
  const freePort = async () => {
    const s = net.createServer();
    await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
    const port = s.address().port;
    await new Promise(resolve => s.close(resolve));
    return port;
  };
  const launch = (entry, cwd, env) => {
    const child = fork(path.join(root, entry), [], { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout.on("data", data => logs.push(String(data)));
    child.stderr.on("data", data => logs.push(String(data)));
    processes.push(child);
    return child;
  };
  try {
    await fs.mkdir(path.join(root, "cloud"));
    for (const name of ["broker.mjs", "authRateLimit.mjs", "linkRouter.mjs", "db.mjs", "mailer.mjs", "agent.mjs", "agentPhones.mjs", "e2e.mjs", "deviceIdentity.mjs"]) {
      await fs.copyFile(path.join("cloud", name), path.join(root, "cloud", name));
    }
    await fs.cp("core", path.join(root, "core"), { recursive: true });
    await fs.cp("relay", path.join(root, "relay"), { recursive: true });
    await build({ entryPoints: ["cloud/agent.mjs"], outfile: path.join(root, "bundle/agent.cjs"), bundle: true,
      platform: "node", format: "cjs", external: ["bufferutil", "utf-8-validate"], logLevel: "error" });
    await fs.mkdir(path.join(root, "bundle/web"));
    await fs.copyFile("web/index.html", path.join(root, "bundle/web/index.html"));
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const port = await freePort(), base = "http://127.0.0.1:" + port;
    const admin = "isolated-test-admin";
    launch("cloud/broker.mjs", root, { HOST: "127.0.0.1", PORT: String(port), DB_PATH: path.join(root, "test.db"),
      ADMIN_TOKEN: admin, PUBLIC_URL: base, SMTP_HOST: "", TLS_CERT: "", TLS_KEY: "", NODE_OPTIONS: "" });
    await until(async () => { try { return (await fetch(base + "/health")).ok; } catch { return false; } });
    const post = async (route, body, isAdmin = false) => {
      const res = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...(isAdmin ? { "x-admin-token": admin } : {}) }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, await res.clone().text());
      return res.json();
    };
    const account = async name => {
      const credentials = { email: name + "@example.com", password: "isolated-password" };
      await post("/api/register", credentials);
      const overview = await (await fetch(base + "/api/admin/overview", { headers: { "x-admin-token": admin } })).json();
      const id = overview.users.find(user => user.email === credentials.email).id;
      await post("/api/admin/user/verify", { id }, true);
      const loggedIn = await post("/api/login", credentials);
      assert(!Object.hasOwn(loggedIn, "membershipUntil"), "免费账号不需要会员字段");
      return { ...credentials, id, token: loggedIn.token };
    };
    const a = await account("account-a"), b = await account("account-b");
    const connectPhone = async (account, key = newKeyPair(), clientId) => {
      const ws = new WebSocket(base.replace("http", "ws") + "/link");
      sockets.push(ws);
      const phone = { ws, key, agentPub: null, raw: [], messages: [] };
      ws.on("error", () => {});
      ws.on("message", data => {
        const m = JSON.parse(data); phone.raw.push(m);
        if (m.type === "authed") phone.agentPub = m.peerPubkey;
        if (m.type === "peer") phone.agentPub = m.online ? m.pubkey : null;
        if (m.type === "e2e") {
          const decoded = open(m, phone.agentPub, key.secretKey);
          if (decoded) phone.messages.push(decoded);
        }
      });
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", role: "phone", pubkey: key.publicKey, token: account.token }));
      await until(() => phone.raw.some(m => m.type === "authed"));
      phone.send = message => ws.send(JSON.stringify({ type: "e2e", ...seal({ ...message, ...(clientId ? { clientId } : {}) }, phone.agentPub, key.secretKey) }));
      phone.pair = code => phone.send({ type: "pair", tag: sas(code, phone.agentPub, key.publicKey) });
      return phone;
    };
    const p = await connectPhone(a, undefined, "web-a");
    const q = await connectPhone(a);
    const r = await connectPhone(b, undefined, "web-b");
    const agent = async (account, name) => {
      const dir = path.join(root, name), panelPort = await freePort();
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "agent.config.json"), JSON.stringify({ ...account, token: undefined,
        codexBin: process.execPath, panelPort, relayPort: await freePort(), relayConfigPath: path.join(dir, "relay.json"), defaultCwd: dir, pairingMode: "code", preventSleep: false, terminalEnabled: false, model: "fixture" }));
      const child = launch(name === "agent-b" ? "bundle/agent.cjs" : "cloud/agent.mjs", dir, { CODEXAPP_DIR: dir, CODEXAPP_DATA_DIR: path.join(dir, "data"), CODEX_HOME: path.join(dir, "home"),
        CODEXAPP_BROKER: base, CODEXAPP_NO_OPEN: "1", CODEXAPP_PREVENT_SLEEP: "0", CODEXAPP_EMAIL: account.email, CODEXAPP_PASSWORD: account.password,
        NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/restartCodex.mjs")).href });
      const status = async () => { try { return await (await fetch("http://127.0.0.1:" + panelPort + "/api/status")).json(); } catch { return {}; } };
      await until(async () => (await status()).brokerConnected);
      return { child, dir, status, code: (await status()).pairingCode };
    };
    const agentA = await agent(a, "agent-a"), agentB = await agent(b, "agent-b");
    const bundledRelay = JSON.parse(await fs.readFile(path.join(agentB.dir, "relay.json"), "utf8"));
    assert.equal((await fetch("http://127.0.0.1:" + bundledRelay.port + "/")).status, 200, "打包 Agent 托管随包网页");
    await until(() => [p, q, r].every(phone => phone.messages.some(m => m.type === "needPairing")));
    p.pair(agentA.code); q.pair("WRONGCODE"); r.pair(agentB.code);
    await until(() => p.messages.some(m => m.type === "hello") && r.messages.some(m => m.type === "hello") && q.messages.some(m => m.type === "paired" && !m.ok));
    assert(!q.messages.some(m => m.type === "hello"));
    q.pair(agentA.code);
    await until(() => q.messages.some(m => m.type === "hello"));
    assert.equal((await agentA.status()).pairedPhones, 2);
    assert.equal((await agentB.status()).pairedPhones, 1);
    for (const [phone, threadId, requestId] of [[p, "one", "p"], [q, "two", "q"], [r, "other", "r"]]) {
      phone.send({ type: "readThread", threadId, requestId });
      await until(() => phone.messages.some(m => m.requestId === requestId && m.type === "hello"));
      assert.equal(phone.messages.find(m => m.requestId === requestId).state.threadId, threadId);
    }
    assert(!q.messages.some(m => m.requestId === "p"));
    assert(!r.messages.some(m => m.type === "sessions" && m.sessions.some(s => s.threadId === "one")));
    p.send({ type: "prompt", text: "fixture only" });
    q.send({ type: "prompt", text: "fixture only" });
    await until(() => p.messages.some(m => m.state?.status === "running") && q.messages.some(m => m.state?.status === "running"));
    const closed = once(q.ws, "close"); q.ws.close(); await closed;
    await until(async () => (await agentA.status()).onlinePhones === 1);
    p.send({ type: "getState", requestId: "p-still" });
    await until(() => p.messages.some(m => m.requestId === "p-still"));
    assert.equal(p.messages.find(m => m.requestId === "p-still").state.threadId, "one");
    const q2 = await connectPhone(a, q.key);
    await until(() => q2.messages.some(m => m.type === "hello"));
    assert(!q2.messages.some(m => m.type === "needPairing"));
    q2.send({ type: "getState", threadId: "two", requestId: "q-restored" });
    await until(() => q2.messages.some(m => m.requestId === "q-restored"));
    assert.equal(q2.messages.find(m => m.requestId === "q-restored").state.status, "running");
    const relayConfig = JSON.parse(await fs.readFile(path.join(agentA.dir, "relay.json"), "utf8"));
    const direct = new WebSocket(`ws://127.0.0.1:${relayConfig.port}/ws?token=${relayConfig.token}&clientId=direct`);
    sockets.push(direct);
    const directMessages = [];
    direct.on("message", data => directMessages.push(JSON.parse(data)));
    await once(direct, "open");
    direct.send(JSON.stringify({ type: "getState", threadId: "one", requestId: "direct-shared" }));
    await until(() => directMessages.some(m => m.requestId === "direct-shared"));
    assert.equal(directMessages.find(m => m.requestId === "direct-shared").state.status, "running");
    const callsBefore = (await fs.readFile(path.join(agentA.dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(callsBefore.filter(c => c.method === "initialize").length, 1, "两个入口只有一个 Codex 控制进程");
    const duplicate = new WebSocket(base.replace("http", "ws") + "/link"); sockets.push(duplicate);
    const rejected = [];
    duplicate.on("message", data => rejected.push(JSON.parse(data)));
    await once(duplicate, "open");
    duplicate.send(JSON.stringify({ type: "auth", role: "agent", multiPhone: true, token: a.token, pubkey: newKeyPair().publicKey }));
    await until(() => rejected.some(m => m.code === "agent_already_online"));
    assert.equal((await agentA.status()).brokerConnected, true);
    // 只有持有原设备私钥的连接可以替换仍未断开的旧 Agent。
    const identity = JSON.parse(await fs.readFile(path.join(agentA.dir, "agent.identity.json"), "utf8"));
    const agentKeys = JSON.parse(await fs.readFile(path.join(agentA.dir, "agent.keys.json"), "utf8"));
    const forged = new WebSocket(base.replace("http", "ws") + "/link"); sockets.push(forged);
    const forgedMessages = [];
    forged.on("message", data => {
      const m = JSON.parse(data); forgedMessages.push(m);
      if (m.type === "agentChallenge") forged.send(JSON.stringify({ type: "agentProof", signature: "invalid" }));
    });
    await once(forged, "open");
    forged.send(JSON.stringify({ type: "auth", role: "agent", multiPhone: true, token: a.token, pubkey: agentKeys.publicKey, deviceKey: identity.publicKey, identityVerified: true }));
    await until(() => forgedMessages.some(m => m.type === "error"));
    assert.equal((await agentA.status()).brokerConnected, true);
    const replacement = new WebSocket(base.replace("http", "ws") + "/link"); sockets.push(replacement);
    const replacementMessages = [];
    replacement.on("message", data => {
      const m = JSON.parse(data); replacementMessages.push(m);
      if (m.type === "agentChallenge") replacement.send(JSON.stringify({ type: "agentProof", signature: signDeviceChallenge(identity, m.challenge) }));
    });
    await once(replacement, "open");
    replacement.send(JSON.stringify({ type: "auth", role: "agent", multiPhone: true, token: a.token, pubkey: agentKeys.publicKey, deviceKey: identity.publicKey }));
    await until(() => replacementMessages.some(m => m.type === "authed"));
    await until(async () => (await agentA.status()).phase === "error");
    assert.equal(replacementMessages.find(m => m.type === "authed").peers.length, 2);
    assert.equal((await agentA.status()).codexConnected, true, "云连接被替换不能停止本地任务");
    const overview = await (await fetch(base + "/api/admin/overview", { headers: { "x-admin-token": admin } })).json();
    assert.equal(overview.online.find(x => x.email === a.email).phoneCount, 2);
    await post("/api/admin/user/revoke-sessions", { id: a.id }, true);
    await until(() => replacement.readyState === WebSocket.CLOSED && p.ws.readyState === WebSocket.CLOSED);
    const revoked = new WebSocket(base.replace("http", "ws") + "/link"); sockets.push(revoked);
    const revokedMessages = [];
    revoked.on("message", data => revokedMessages.push(JSON.parse(data)));
    await once(revoked, "open");
    revoked.send(JSON.stringify({ type: "auth", role: "phone", token: a.token, pubkey: newKeyPair().publicKey }));
    await until(() => revokedMessages.some(m => m.type === "error"));
    assert.match(revokedMessages[0].message, /token/);
    direct.send(JSON.stringify({ type: "getState", threadId: "one", requestId: "after-revoke" }));
    await until(() => directMessages.some(m => m.requestId === "after-revoke"));
    assert.equal(directMessages.find(m => m.requestId === "after-revoke").state.status, "running");
    await post("/api/admin/user/delete", { id: a.id }, true);
    await until(() => p.ws.readyState === WebSocket.CLOSED && q2.ws.readyState === WebSocket.CLOSED);
    r.send({ type: "getState", requestId: "b-survives" });
    await until(() => r.messages.some(m => m.requestId === "b-survives"));
    assert.equal(r.messages.find(m => m.requestId === "b-survives").state.threadId, "other");
    await post("/api/forgot-password", { email: b.email });
    const database = new DatabaseSync(path.join(root, "test.db"));
    const resetToken = database.prepare("SELECT reset_token FROM accounts WHERE id = ?").get(b.id).reset_token;
    database.close();
    const newPassword = "changed-fixture-password";
    await post("/api/reset-password", { token: resetToken, password: newPassword });
    await until(() => r.ws.readyState === WebSocket.CLOSED);
    await until(async () => (await agentB.status()).phase === "needLogin");
    assert.equal((await agentB.status()).codexConnected, true);
    const loginConfig = JSON.parse(await fs.readFile(path.join(agentB.dir, "agent.config.json"), "utf8"));
    assert.equal(loginConfig.loginRequired, true);
    const panelLogin = await fetch("http://127.0.0.1:" + loginConfig.panelPort + "/api/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: b.email, password: newPassword }),
    });
    assert.equal(panelLogin.status, 200);
    await until(async () => (await agentB.status()).brokerConnected);
    const bNew = { ...b, token: (await post("/api/login", { email: b.email, password: newPassword })).token };
    const rNew = await connectPhone(bNew, r.key, "web-b");
    await until(() => rNew.messages.some(m => m.type === "hello"));
    const unauthAdmin = await fetch(base + "/api/admin/user/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: b.id, disabled: true }) });
    assert.equal(unauthAdmin.status, 401);
    await post("/api/admin/user/status", { id: b.id, disabled: true }, true);
    await until(() => rNew.ws.readyState === WebSocket.CLOSED);
    assert(rNew.raw.some(m => m.code === "account_disabled"));
    await until(async () => (await agentB.status()).phase === "needLogin");
    assert.equal((await agentB.status()).codexConnected, true, "停用账号不能结束本机任务");
    const disabledLogin = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: b.email, password: newPassword }) });
    assert.equal(disabledLogin.status, 403);
    assert.equal((await disabledLogin.json()).code, "account_disabled");
    async function rejectedPhone(token) {
      const ws = new WebSocket(base.replace("http", "ws") + "/link"); sockets.push(ws);
      const received = []; ws.on("message", data => received.push(JSON.parse(data)));
      await once(ws, "open"); ws.send(JSON.stringify({ type: "auth", role: "phone", token, pubkey: newKeyPair().publicKey }));
      await until(() => received.some(m => m.type === "error")); return received;
    }
    assert.equal((await rejectedPhone(bNew.token))[0].code, "account_disabled");
    await post("/api/admin/user/status", { id: b.id, disabled: false }, true);
    assert.equal((await rejectedPhone(bNew.token))[0].code, "session_revoked", "恢复账号后旧令牌仍然失效");
    const restored = await post("/api/login", { email: b.email, password: newPassword });
    const restoredPhone = await connectPhone({ ...b, token: restored.token });
    assert(restoredPhone.raw.some(m => m.type === "authed"));
    for (const route of ["/api/redeem", "/api/admin/user/membership", "/api/admin/codes/generate"]) {
      const response = await fetch(base + route, { method: "POST", headers: { "x-admin-token": admin, "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 404, "旧收费接口已取消：" + route);
    }
    const limitedLogin = () => fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "rate-fixture@example.com", password: "wrong-password" }) });
    for (let i = 0; i < 8; i++) assert.equal((await limitedLogin()).status, 401);
    const limited = await limitedLogin();
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert(retryAfter > 0 && retryAfter <= 900);
    assert.equal((await limited.json()).retryAfter, retryAfter);
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const child of processes.reverse()) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    }
    try { await fs.unlink(path.join(root, "node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("codexapp-cloud-process-"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
