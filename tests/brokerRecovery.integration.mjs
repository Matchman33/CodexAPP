import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import { supervise } from "../scripts/supervisor.mjs";

test("真实隔离 Broker 崩溃后同端口恢复，保留数据库和签名密钥，主动停止不重启", { timeout: 15000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-broker-recovery-"));
  const children = []; let supervisor, log = "";
  try {
    await fs.mkdir(path.join(dir, "cloud")); await fs.mkdir(path.join(dir, "core"));
    for (const name of await fs.readdir("cloud")) if (name.endsWith(".mjs")) await fs.copyFile(path.join("cloud", name), path.join(dir, "cloud", name));
    await fs.copyFile("core/managedProcess.mjs", path.join(dir, "core/managedProcess.mjs"));
    await fs.symlink(path.resolve("node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const url = "http://127.0.0.1:" + port;
    supervisor = supervise(() => {
      const child = fork(path.join(dir, "cloud/broker.mjs"), [], { cwd: dir, windowsHide: true,
        env: { ...process.env, CODEXAPP_MANAGED: "1", HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: url, DB_PATH: path.join(dir, "broker.db"), SMTP_HOST: "", TLS_CERT: "", TLS_KEY: "", ADMIN_TOKEN: "isolated-fixture", NODE_OPTIONS: "" },
        stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
      children.push(child); return child;
    }, { logger: { error(...args) { log += args.join(" "); } } });
    const healthy = async () => { try { return (await (await fetch(url + "/health")).json()).ok; } catch { return false; } };
    const until = async predicate => { for (let i = 0; i < 120; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error("timeout: " + log); };
    await until(healthy);
    const secret = await fs.readFile(path.join(dir, "cloud/broker.secret"));
    const registered = await fetch(url + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fixture@example.com", password: "isolated-password" }) });
    assert.equal(registered.status, 200);
    children[0].kill("SIGKILL");
    await until(async () => children.length === 2 && await healthy());
    assert.notEqual(children[0].pid, children[1].pid);
    assert.deepEqual(await fs.readFile(path.join(dir, "cloud/broker.secret")), secret);
    const overview = await (await fetch(url + "/api/admin/overview", { headers: { "x-admin-token": "isolated-fixture" } })).json();
    assert(overview.users.some(user => user.email === "fixture@example.com"));
    const stopped = once(children[1], "exit"); supervisor.stopManaged(); await stopped;
    assert.equal(children.length, 2);
    console.log("PASS: Broker 实际崩溃自动恢复、原端口、账号与签名密钥保留、主动停止不重启");
  } finally {
    supervisor?.stop();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
    try { await fs.unlink(path.join(dir, "node_modules")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
