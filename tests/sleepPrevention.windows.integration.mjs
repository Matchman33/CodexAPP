import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { SleepPrevention } from "../core/sleepPrevention.mjs";

if (process.platform !== "win32") {
  console.log("SKIP: Windows sleep-prevention integration test");
  process.exit(0);
}

const quiet = { log() {}, warn() {} };
const guard = new SleepPrevention({ logger: quiet });
try {
  assert.equal((await guard.start()).active, true, guard.status().error);
  const child = guard.child;
  const output = [];
  child.stdout.on("data", (d) => output.push(d.toString()));
  await guard.stop();
  assert.equal(guard.status().active, false);
  assert.match(output.join(""), /released/);
  assert.equal(child.exitCode, 0);
  console.log("PASS: native request acquired and explicitly released on the same thread");
} finally { await guard.stop(); }

// This independent parent has no Codex session. Killing it must release via EOF.
const moduleUrl = new URL("../core/sleepPrevention.mjs", import.meta.url).href;
const parent = spawn(process.execPath, ["--input-type=module", "-e",
  "import { SleepPrevention } from " + JSON.stringify(moduleUrl) + ";" +
  "const g=new SleepPrevention({logger:{log(){},warn(){}}});" +
  "const s=await g.start();if(!s.active)throw Error(s.error);" +
  "process.stdout.write(JSON.stringify({pid:g.child.pid})+'\\n');setInterval(()=>{},1000);",
], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "", helperPid, observer;
try {
  helperPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("parent startup timeout")), 20000);
    parent.once("error", reject);
    parent.once("exit", () => { clearTimeout(timer); if (!helperPid) reject(new Error("parent exited before ready")); });
    parent.stdout.on("data", (d) => {
      output += d.toString();
      if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.trim()).pid); }
    });
    parent.stderr.on("data", (d) => { output += d.toString(); });
  });
  // Wait on the exact helper process, so PID reuse cannot be mistaken for exit.
  const command = "$p=Get-Process -Id " + helperPid + " -ErrorAction Stop; [Console]::WriteLine('observing'); if(!$p.WaitForExit(10000)){exit 1}";
  observer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { observer.stdout.once("data", resolve); observer.once("exit", (code) => { if (code) reject(new Error("helper observer failed")); }); });
  const observerClosed = once(observer, "close");
  const parentClosed = once(parent, "close");
  parent.kill();
  await parentClosed;
  const [code] = await observerClosed;
  assert.equal(code, 0, "helper did not exit after parent termination");
  console.log("PASS: forced parent exit releases the helper without leaving an orphan");
} finally {
  if (parent.exitCode == null && parent.signalCode == null) { const closed = once(parent, "close"); parent.kill(); await closed; }
  if (observer && observer.exitCode == null && observer.signalCode == null) { const closed = once(observer, "close"); observer.kill(); await closed; }
}

const temporaryBase = path.resolve(os.tmpdir());
const dir = await fs.mkdtemp(path.join(temporaryBase, "codexapp-power-"));
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
await fs.writeFile(path.join(dir, "agent.config.json"), JSON.stringify({ email: "", password: "", panelPort: port }));
const agent = spawn(process.execPath, [fileURLToPath(new URL("../cloud/agent.mjs", import.meta.url))], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, CODEXAPP_DIR: dir, CODEXAPP_NO_OPEN: "1", CODEXAPP_PREVENT_SLEEP: "1", CODEXAPP_EMAIL: "", CODEXAPP_PASSWORD: "" },
});
let agentErrors = "";
agent.stdout.on("data", () => {});
agent.stderr.on("data", (d) => { agentErrors = (agentErrors + d.toString()).slice(-4096); });
try {
  let status;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assert.equal(agent.exitCode, null, agentErrors);
    try { status = await (await fetch("http://127.0.0.1:" + port + "/api/status")).json(); }
    catch {}
    if (status?.sleepPrevention.active || status?.sleepPrevention.error) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.phase, "needLogin");
  assert.equal(status?.codexConnected, false);
  assert.equal(status?.sleepPrevention.active, true, status?.sleepPrevention.error || agentErrors);
  console.log("PASS: isolated Agent service reports active sleep prevention without login or Codex tasks");
} finally {
  if (agent.exitCode == null && agent.signalCode == null) { const closed = once(agent, "close"); agent.kill(); await closed; }
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== temporaryBase || !path.basename(resolved).startsWith("codexapp-power-")) throw new Error("unsafe test cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
}
