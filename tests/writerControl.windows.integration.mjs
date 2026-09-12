// Opt-in OS test: uses a temporary CODEX_HOME and never sends a model prompt.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveCodexBin } from "../core/codexBridge.mjs";
import { WriterControl } from "../core/writerControl.mjs";

if (process.platform !== "win32") throw new Error("This integration test requires Windows");
const bin = resolveCodexBin(process.env.CODEX_BIN);
if (!bin) throw new Error("Codex executable not found");
const tempRoot = path.resolve(os.tmpdir());
const home = fs.mkdtempSync(path.join(tempRoot, "codexapp-writer-test-"));
const child = spawn(bin, ["app-server"], {
  env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let sequence = 0, buffer = "";
child.stderr.resume();
child.stdout.on("data", (data) => {
  buffer += data.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const request = pending.get(message.id);
    if (!request) continue;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }
});
const exited = new Promise((resolve) => child.once("close", resolve));
child.on("error", (error) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timeout")); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
try {
  await request("initialize", { clientInfo: { name: "codex_vscode", title: "Writer control test", version: "0.1.0" }, capabilities: null });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const result = await request("thread/start", { cwd: home, model: "gpt-5.4", approvalPolicy: "on-request", sandbox: "read-only" });
  const threadId = result.thread.id;
  const control = new WriterControl({ home });
  const conflict = await control.inspect(threadId);
  const owner = conflict.owners.find((o) => o.pid === child.pid);
  assert(owner?.canTerminate && owner.token, "Temporary writer must be identified");
  assert.deepEqual(owner.affectedThreads, [threadId]);
  await control.terminate(threadId, owner.token, true);
  await exited;
  assert.deepEqual((await control.inspect(threadId)).owners, []);
  console.log("PASS: isolated writer identified, confirmed, terminated, and its lock released; no model prompt sent");
} finally {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("test complete")); }
  pending.clear();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited;
  const resolved = path.resolve(home);
  if (!resolved.startsWith(tempRoot + path.sep) || !path.basename(resolved).startsWith("codexapp-writer-test-") || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Refusing cleanup outside the verified test directory");
  }
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
