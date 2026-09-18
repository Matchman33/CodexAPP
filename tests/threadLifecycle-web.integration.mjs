import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-lifecycle-"));
let child, browser;
try {
  await fs.cp("core", path.join(root, "core"), { recursive: true });
  await fs.mkdir(path.join(root, "relay"));
  await fs.copyFile("relay/server.mjs", path.join(root, "relay/server.mjs"));
  for (const directory of ["node_modules", "web"]) await fs.symlink(path.resolve(directory), path.join(root, directory), process.platform === "win32" ? "junction" : "dir");
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  await fs.writeFile(path.join(root, "codexapp.config.json"), JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port, token: "isolated-lifecycle", model: "fixture-model", defaultCwd: root, preventSleep: false }));
  child = spawn(process.execPath, [path.join(root, "relay/server.mjs")], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/lifecycleCodex.mjs")).href, CODEX_HOME: path.join(root, "home"), CODEXAPP_PREVENT_SLEEP: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const url = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(url + "/health")).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, log);
  const readCalls = async () => (await fs.readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "isolated-lifecycle" })), { url });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => sessionReady && threadManagement.release);
  await page.locator("#sessionsBtn").click(); await page.locator('.session-item[data-thread-id="one"]').click();
  await page.waitForFunction(() => appState.threadId === "one" && !pendingSelection);
  await page.locator("#input").fill("隔离模拟消息"); await page.locator("#sendBtn").click();
  await page.waitForFunction(() => appState.status === "idle" && appState.turnId && !pendingPrompt);
  await page.locator("#input").fill("保留的草稿");
  await page.locator("#menuBtn").click(); await page.locator("#releaseThreadBtn").click();
  assert.equal(await page.locator("#threadActionName").textContent(), "需要交接的会话");
  await page.locator("#threadActionCancel").click();
  assert(!(await readCalls()).some(c => c.method === "thread/unsubscribe"));
  await page.locator("#releaseThreadBtn").click(); await page.locator("#threadActionConfirm").click();
  await page.waitForFunction(() => appState.writerReleased === true && !threadActionPending);
  const inits = (await readCalls()).filter(c => c.method === "initialize");
  assert.equal(inits.length, 2); assert.notEqual(inits[0].pid, inits[1].pid, "卸载宽限期内重连仅中继自己的空闲控制进程");
  assert.equal(child.exitCode, null, "中继进程继续运行");
  assert.equal(await page.locator("#input").inputValue(), "保留的草稿");
  assert.equal(await page.locator("#feed").textContent().then(t => t.includes("隔离模拟消息")), true);
  await page.locator("#sheetClose").click();
  await page.reload(); await page.waitForFunction(() => appState.writerReleased === true);
  await page.locator("#sessionsBtn").click();
  await page.getByRole("button", { name: "删除会话：待删除的会话", exact: true }).click();
  assert.equal(await page.locator("#threadActionName").textContent(), "待删除的会话");
  assert.equal(await page.evaluate(() => document.activeElement.id), "threadActionCancel");
  assert.match(await page.locator("#threadActionMessage").textContent(), /永久删除.*子会话/);
  await fs.mkdir("dist-check/lifecycle-ui", { recursive: true });
  await page.screenshot({ path: "dist-check/lifecycle-ui/delete-confirm.png" });
  await page.locator("#threadActionCancel").click();
  assert(!(await readCalls()).some(c => c.method === "thread/delete"));
  await fs.writeFile(path.join(root, "fail-delete"), "fixture");
  await page.getByRole("button", { name: "删除会话：待删除的会话", exact: true }).click(); await page.locator("#threadActionConfirm").click();
  await page.locator("#threadActionError").filter({ hasText: "fixture delete failure" }).waitFor();
  assert.equal(await page.locator('.session-item[data-thread-id="two"]').count(), 1);
  await fs.unlink(path.join(root, "fail-delete"));
  await page.locator("#threadActionConfirm").click(); await page.locator("#threadActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator('.session-item[data-thread-id="two"]').count(), 0);
  assert.equal(await page.evaluate(() => appState.threadId), "one");
  await page.getByRole("button", { name: "删除会话：外部运行中的会话", exact: true }).click(); await page.locator("#threadActionConfirm").click();
  await page.locator("#threadActionError").filter({ hasText: "目标会话正在运行" }).waitFor();
  assert(!(await readCalls()).some(c => c.method === "thread/delete" && c.params.threadId === "busy"));
  await page.locator("#threadActionCancel").click();
  await page.getByRole("button", { name: "删除会话：需要交接的会话", exact: true }).click(); await page.locator("#threadActionConfirm").click();
  await page.locator("#threadActionDialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => appState.threadId === null && !lastProjectTree.projectless.some(t => t.id === "child"));
  assert.equal(await page.locator("#feed .entry").count(), 0);
  await page.reload(); await page.waitForFunction(() => sessionReady);
  await page.locator("#sessionsBtn").click(); await page.locator('.session-item[data-thread-id="busy"]').waitFor();
  assert.equal(await page.locator('.session-item[data-thread-id="one"], .session-item[data-thread-id="child"]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ width: 390, passed: "release confirmation, actual child reconnect, relay stays alive, drafts/history, refresh, delete confirmation/cancel/failure/success/descendants, active guard", realTasksModified: 0 }));
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  for (const directory of ["node_modules", "web"]) { try { await fs.unlink(path.join(root, directory)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  await fs.rm(root, { recursive: true, force: true });
}
