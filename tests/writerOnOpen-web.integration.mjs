import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-writer-open-"));
let child, browser;
try {
  await fs.cp("core", path.join(root, "core"), { recursive: true });
  await fs.mkdir(path.join(root, "relay"));
  await fs.copyFile("relay/server.mjs", path.join(root, "relay/server.mjs"));
  await fs.copyFile("relay/transport.mjs", path.join(root, "relay/transport.mjs"));
  for (const directory of ["node_modules", "web"]) await fs.symlink(path.resolve(directory), path.join(root, directory), process.platform === "win32" ? "junction" : "dir");
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  await fs.writeFile(path.join(root, "codexapp.config.json"), JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port, token: "isolated-writer-open", model: "fixture-model", defaultCwd: root, preventSleep: false }));
  child = spawn(process.execPath, [path.join(root, "relay/server.mjs")], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/writerOnOpen.mjs")).href, CODEX_HOME: path.join(root, "home"), CODEXAPP_DATA_DIR: path.join(root, "data"), CODEXAPP_PREVENT_SLEEP: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const url = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(url + "/health")).ok; } catch {}
    if (ready || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, log);
  const records = async file => (await fs.readFile(path.join(root, file), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const terminated = async () => (await records("checks.jsonl")).filter(record => record.action === "terminate");
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.addInitScript(url => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "isolated-writer-open" })), url);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => sessionReady);
  const select = async id => { await page.evaluate(id => selectHistoryThread(id), id); await page.waitForFunction(id => appState.threadId === id && !pendingSelection, id); };
  await select("one"); await page.locator("#input").fill("保留的草稿");
  await select("two");
  assert(await page.locator("#writerSheet").isHidden());
  assert(!(await records("checks.jsonl")).length, "打开时不检查占用");
  assert(!(await records("calls.jsonl")).some(c => c.method === "thread/resume"));
  await page.locator("#input").fill("仅发送一次"); await page.locator("#sendBtn").click();
  await page.locator("#writerSheet").waitFor({ state: "visible" });
  assert((await page.locator("#writerOwners").textContent()).includes("4242"));
  assert.equal((await terminated()).length, 0);
  await page.locator("#writerClose").click();
  await select("one"); assert.equal(await page.locator("#input").inputValue(), "保留的草稿");
  await select("two");
  await page.evaluate(() => sendWs({ type: "resumeQueue", threadId: "two" }));
  await page.locator("#writerSheet").waitFor({ state: "visible" });
  await page.locator("#writerOwners button").click();
  assert.equal((await terminated()).length, 0, "显示确认不能结束进程");
  await page.locator("#writerCancelBtn").click(); assert.equal((await terminated()).length, 0);
  await page.locator("#writerOwners button").click(); await page.locator("#writerConfirmBtn").click();
  await page.waitForFunction(() => !writerPending && !appState.readOnly && appState.threadId === "two");
  assert.equal((await terminated()).length, 1);
  assert(!(await records("calls.jsonl")).some(c => c.method === "turn/start"), "接管后仍等待手动继续队列");
  await page.evaluate(() => sendWs({ type: "resumeQueue", threadId: "two" }));
  await page.waitForFunction(() => !promptQueueState.items.length && appState.status === "idle");
  assert.equal((await records("calls.jsonl")).filter(c => c.method === "turn/start").length, 1);
  assert.deepEqual(errors, []);
  console.log("PASS: read without takeover, conflict on send, preserve drafts, explicit takeover, resume queued message exactly once; real processes terminated: 0");
} finally {
  await browser?.close();
  if (child?.exitCode === null) { child.kill(); await once(child, "exit"); }
  for (const directory of ["node_modules", "web"]) { try { await fs.unlink(path.join(root, directory)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("codexapp-writer-open-")) throw new Error("无效清理目录");
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
