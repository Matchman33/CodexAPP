import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

test("隔离直连中继支持图文、图片排队、纯图片纠偏和刷新恢复", { timeout: 20000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-image-relay-"));
  let child, socket;
  try {
    await fs.cp("core", path.join(root, "core"), { recursive: true });
    await fs.mkdir(path.join(root, "relay"));
    await fs.copyFile("relay/server.mjs", path.join(root, "relay/server.mjs"));
    await fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    await fs.writeFile(path.join(root, "codexapp.config.json"), JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port, token: "isolated-image-relay", defaultCwd: root, model: "fixture-model", preventSleep: false }));
    // NODE_OPTIONS 仅用于此隔离目录；子进程是模拟 JSON-RPC 的 Node，不启动 Codex。
    await fs.writeFile(path.join(root, "fake.mjs"), String.raw`
import fs from "node:fs";
import readline from "node:readline";
if (process.argv[1]?.endsWith("app-server")) {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", raw => {
    const m = JSON.parse(raw); if (m.id === undefined) return;
    fs.appendFileSync("calls.jsonl", JSON.stringify(m) + "\n");
    let result = {};
    if (m.method === "initialize") result = { userAgent: "image-fixture" };
    if (m.method === "config/read") result = { config: { model: "fixture-model" } };
    if (m.method === "model/list") result = { data: [{ model: "fixture-model", isDefault: true }], nextCursor: null };
    if (m.method === "thread/start") result = { thread: { id: "one", cwd: process.cwd(), turns: [] } };
    if (m.method === "turn/start") result = { turn: { id: "image-turn" } };
    process.stdout.write(JSON.stringify({ id: m.id, result }) + "\n");
  });
  lines.on("close", () => process.exit(0));
  await new Promise(() => {});
}
`);
    child = spawn(process.execPath, [path.join(root, "relay/server.mjs")], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.join(root, "fake.mjs")).href, CODEX_HOME: path.join(root, "home"), CODEXAPP_PREVENT_SLEEP: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const messages = []; let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const until = async condition => { for (let i = 0; i < 100; i++) { if (await condition()) return; if (child.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("等待隔离中继超时：" + output); };
    await until(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/health")).ok; } catch { return false; } });
    const connect = async () => {
      const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws?token=isolated-image-relay");
      ws.on("message", data => messages.push(JSON.parse(data))); await once(ws, "open"); return ws;
    };
    socket = await connect(); await until(() => messages.some(m => m.type === "hello"));
    assert.equal(messages.find(m => m.type === "hello").imageUpload.supported, true);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE0kAAAAASUVORK5CYII=";
    const images = [{ name: "fixture.png", dataUrl: png, previewDataUrl: png }];
    socket.send(JSON.stringify({ type: "prompt", text: "inspect", images, requestId: "direct" }));
    await until(() => messages.some(m => m.type === "state" && m.state.status === "running"));
    const readCalls = async () => (await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const start = (await readCalls()).find(c => c.method === "turn/start");
    assert.equal(start.params.input[1].url, png);
    assert.equal(messages.find(m => m.event?.id === "direct").event.images[0].url, png);
    socket.send(JSON.stringify({ type: "steer", text: "", images }));
    await until(async () => (await readCalls()).some(c => c.method === "turn/steer"));
    assert.deepEqual((await readCalls()).find(c => c.method === "turn/steer").params.input.map(i => i.type), ["image"]);
    socket.send(JSON.stringify({ type: "enqueuePrompt", text: "", images, threadId: "one", requestId: "queued" }));
    await until(() => messages.some(m => m.type === "promptAccepted" && m.requestId === "queued"));
    socket.close(); await once(socket, "close"); messages.length = 0;
    socket = await connect(); await until(() => messages.some(m => m.type === "hello"));
    const snapshot = messages.find(m => m.type === "hello");
    assert.equal(snapshot.state.status, "running"); assert.equal(snapshot.promptQueue.items[0].images[0].url, png);
    assert.equal(snapshot.promptQueue.items[0].images[0].dataUrl, undefined);
    socket.send(JSON.stringify({ type: "interrupt" }));
    await until(async () => (await readCalls()).some(c => c.method === "turn/interrupt"));
    assert.deepEqual((await readCalls()).find(c => c.method === "turn/interrupt").params, { threadId: "one", turnId: "image-turn" });
    socket.send(JSON.stringify({ type: "prompt", text: "bad", requestId: "bad", images: [{ dataUrl: "C:/secret.png" }] }));
    await until(() => messages.some(m => m.type === "error" && m.requestId === "bad"));
    assert.equal((await readCalls()).filter(c => c.method === "turn/start").length, 1);
  } finally {
    socket?.terminate();
    if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
    // 只清理本测试创建的临时目录，先移除 node_modules 链接，不递归进入依赖目录。
    try { await fs.unlink(path.join(root, "node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
