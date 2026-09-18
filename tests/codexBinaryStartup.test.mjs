import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { CodexBridge } from "../core/codexBridge.mjs";
import { restartIdleCodex } from "../core/threadLifecycle.mjs";

test("Windows 云 Agent 和直连启动均不固定自动路径，重连时重新选择版本", { skip: process.platform !== "win32", timeout: 25000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-binary-startup-"));
  const local = path.join(root, "profile"), base = path.join(local, "OpenAI", "Codex", "bin");
  const envKeys = ["LOCALAPPDATA", "PATH", "NODE_OPTIONS", "CODEX_HOME"], previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let bridge, relay;
  try {
    const preload = path.join(root, "fake.mjs");
    await fs.writeFile(preload, `
import readline from 'node:readline';
import path from 'node:path';
if (process.argv[1]?.endsWith('app-server')) {
  const lines=readline.createInterface({input:process.stdin});
  lines.on('line',raw=>{const m=JSON.parse(raw);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:path.basename(path.dirname(process.execPath))}})+'\\n');});
  lines.on('close',()=>process.exit(0));
  await new Promise(()=>{});
}
`);
    const version = async (hash, time, complete = true) => {
      const directory = path.join(base, hash); await fs.mkdir(directory, { recursive: true });
      const bin = path.join(directory, "codex.exe");
      // Node 作为模拟 RPC 程序，测试不会启动真实 Codex 或模型任务。
      if (complete) await fs.copyFile(process.execPath, bin); else await fs.writeFile(bin, "incomplete fixture");
      await fs.utimes(bin, time, time);
      if (complete) await fs.writeFile(path.join(directory, "codex-code-mode-host.exe"), "fixture");
      return bin;
    };
    const first = await version("1111111111111111", 100);
    Object.assign(process.env, { LOCALAPPDATA: local, PATH: "", NODE_OPTIONS: "--import=" + pathToFileURL(preload).href, CODEX_HOME: path.join(root, "home") });
    const config = { codexBin: "", defaultCwd: root };
    bridge = new CodexBridge(config, () => {});
    await bridge.start();
    assert.equal(bridge.codex.bin, first); assert.equal(config.codexBin, "");
    const second = await version("2222222222222222", 200);
    await version("3333333333333333", 300, false);
    await restartIdleCodex(bridge.codex, () => bridge._bootstrap());
    assert.equal(bridge.codex.bin, second); assert.equal(config.codexBin, "");
    assert.equal(bridge.state.codexVersion, "2222222222222222");
    bridge.codex.onExit = () => {};
    const closed = once(bridge.codex.child, "close"); bridge.codex.child.stdin.end(); await closed;

    const serverRoot = path.join(root, "relay-app");
    await fs.mkdir(path.join(serverRoot, "relay"), { recursive: true });
    await fs.copyFile("relay/server.mjs", path.join(serverRoot, "relay/server.mjs"));
    await fs.cp("core", path.join(serverRoot, "core"), { recursive: true });
    await fs.symlink(path.resolve("node_modules"), path.join(serverRoot, "node_modules"), "junction");
    const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const relayConfig = { codexBin: "", token: "isolated-binary-fixture", port, host: "127.0.0.1", preventSleep: false };
    const configFile = path.join(serverRoot, "codexapp.config.json"); await fs.writeFile(configFile, JSON.stringify(relayConfig));
    relay = spawn(process.execPath, [path.join(serverRoot, "relay/server.mjs")], { cwd: serverRoot, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CODEXAPP_PREVENT_SLEEP: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = ""; relay.stdout.on("data", chunk => { log += chunk; }); relay.stderr.on("data", chunk => { log += chunk; });
    let healthy = false;
    for (let i = 0; i < 80; i++) {
      try { healthy = (await (await fetch("http://127.0.0.1:" + port + "/health")).json()).codexConnected; } catch {}
      if (healthy || relay.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(healthy, log);
    assert(log.includes(second));
    assert.deepEqual(JSON.parse(await fs.readFile(configFile, "utf8")), relayConfig, "启动不能将自动路径写入配置");
  } finally {
    if (bridge) {
      bridge.codex.onExit = () => {};
      const child = bridge.codex.child;
      if (child && child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.stdin.end(); await closed; }
    }
    if (relay && relay.exitCode === null) { const closed = once(relay, "close"); relay.kill(); await closed; }
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    try { await fs.unlink(path.join(root, "relay-app", "node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("codexapp-binary-startup-")) throw new Error("无效测试目录");
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
