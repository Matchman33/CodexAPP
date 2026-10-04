import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

test("隔离 Agent 的静默断网、Broker 恢复、进程崩溃后重连，Codex 不重复启动", { timeout: 20000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-agent-recovery-"));
  let launcher, log = "", sockets = [], auths = 0;
  const server = http.createServer((req, res) => { res.writeHead(500).end(); });
  const wss = new WebSocketServer({ server, autoPong: false });
  wss.on("connection", socket => {
    sockets.push(socket);
    socket.on("message", raw => {
      const m = JSON.parse(raw);
      if (m.type === "auth") {
        auths++;
        socket.send(JSON.stringify({ type: "authed", multiPhone: true, deviceIdentity: true, agentId: "fixture", peerOnline: false }));
      }
    });
    // 第一个连接模拟网关静默丢包；后续连接正常回复心跳。
    if (sockets.length > 1) socket.on("ping", data => socket.pong(data));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const until = async fn => {
    for (let i = 0; i < 160; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error("timeout: " + log);
  };
  try {
    const reserve = http.createServer();
    await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
    const relayPort = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const configFile = path.join(dir, "relay.json");
    await fs.writeFile(configFile, JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port: relayPort, token: "fixture", defaultCwd: dir, model: "fixture", terminalEnabled: false }));
    await fs.writeFile(path.join(dir, "agent.config.json"), JSON.stringify({ email: "fixture@example.com", password: "fixture-password", sessionToken: "fixture-token", panelPort: 0, preventSleep: false, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 100 }));
    launcher = fork(path.resolve("scripts/run.mjs"), ["agent"], { cwd: dir,
      env: { ...process.env, CODEXAPP_DIR: dir, CODEXAPP_RELAY_CONFIG: configFile, CODEXAPP_BROKER: "http://127.0.0.1:" + server.address().port,
        CODEX_HOME: path.join(dir, "home"), CODEXAPP_DATA_DIR: path.join(dir, "sessions"), CODEXAPP_OPEN_PANEL: "0", CODEXAPP_PREVENT_SLEEP: "0",
        NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/restartCodex.mjs")).href },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    launcher.stdout.on("data", d => { log += d; }); launcher.stderr.on("data", d => { log += d; });
    await until(() => auths >= 2);
    assert.match(log, /心跳超时/);
    let calls = (await fs.readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter(m => m.method === "initialize").length, 1, "网络重连不能重启 Codex 或中断任务");
    sockets.at(-1).close(1012, "broker restarting");
    await until(() => auths >= 3);
    const panel = await fs.readFile(path.join(dir, "panel.url"), "utf8");
    assert.equal((await (await fetch(panel + "/api/status")).json()).brokerConnected, true);
    const activePid = (await (await fetch(panel + "/api/status")).json()).processId;
    process.kill(activePid, "SIGKILL");
    await until(() => auths >= 4);
    calls = (await fs.readFile(path.join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter(m => m.method === "initialize").length, 2);
    console.log("PASS: Agent 心跳断线、服务端恢复、进程崩溃恢复；没有重复启动 Codex，没有发送模型任务");
  } finally {
    if (launcher?.exitCode === null) { const exit = once(launcher, "exit"); launcher.send({ type: "codexapp-stop" }); await exit; }
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
