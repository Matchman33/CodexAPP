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
  for (const directory of ["node_modules", "web"]) await fs.symlink(path.resolve(directory), path.join(root, directory), process.platform === "win32" ? "junction" : "dir");
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  await fs.writeFile(path.join(root, "codexapp.config.json"), JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port, token: "isolated-writer-open", model: "fixture-model", defaultCwd: root, preventSleep: false }));
  child = spawn(process.execPath, [path.join(root, "relay/server.mjs")], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/writerOnOpen.mjs")).href, CODEX_HOME: path.join(root, "home"), CODEXAPP_PREVENT_SLEEP: "0" }, stdio: ["ignore", "pipe", "pipe"] });
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
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "isolated-writer-open" })), { url });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => sessionReady);
  const select = async threadId => { await page.locator("#sessionsBtn").click(); await page.locator('.session-item[data-thread-id="' + threadId + '"]').click(); };
  await select("one"); await page.waitForFunction(() => appState.threadId === "one" && !pendingSelection);
  assert(await page.locator("#writerSheet").isHidden());
  await page.locator("#input").fill("保留的草稿");
  await select("two"); await page.locator("#writerSheet").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => appState.threadId), "one");
  assert.equal(await page.evaluate(() => pendingSelection), null);
  assert.equal(await page.locator("#input").inputValue(), "保留的草稿");
  assert((await page.locator("#writerOwners").textContent()).includes("4242"));
  assert(!(await records("calls.jsonl")).some(call => call.params?.threadId === "two"), "弹窗必须先于读取历史或尝试接续");
  assert.equal((await terminated()).length, 0);
  await fs.mkdir("dist-check/writer-open-ui", { recursive: true });
  await page.screenshot({ path: "dist-check/writer-open-ui/external-writer.png" });
  await page.locator("#writerClose").click(); assert.equal(await page.evaluate(() => appState.threadId), "one");

  // 迟到检查只属于旧的选择，不应打断后来选择的空闲会话。
  await fs.writeFile(path.join(root, "hold-check"), "fixture");
  await select("two");
  await page.evaluate(() => selectHistoryThread("one"));
  await fs.unlink(path.join(root, "hold-check"));
  await page.waitForFunction(() => appState.threadId === "one" && !pendingSelection);
  assert(await page.locator("#writerSheet").isHidden());

  await select("two"); await page.locator("#writerSheet").waitFor({ state: "visible" });
  await page.locator("#writerReadOnly").click();
  await page.waitForFunction(() => appState.threadId === "two" && appState.readOnly && !pendingSelection);
  assert(!(await records("calls.jsonl")).some(call => call.method === "thread/resume"));
  await page.locator("#menuBtn").click(); await page.locator("#releaseThreadBtn").click(); await page.locator("#threadActionConfirm").click();
  await page.waitForFunction(() => appState.writerReleased === true && !threadActionPending);
  assert.equal((await terminated()).length, 0, "解除自身占用按钮不能结束外部进程");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "external-writer.json"), "utf8")).occupied, true);
  await page.locator("#sheetClose").click();

  await select("two"); await page.locator("#writerSheet").waitFor({ state: "visible" });
  await page.locator("#writerOwners button").click();
  await page.locator("#writerConfirm").waitFor({ state: "visible" });
  assert.equal((await terminated()).length, 0, "显示确认不会结束进程");
  await page.locator("#writerCancelBtn").click(); assert.equal((await terminated()).length, 0);
  await page.locator("#writerOwners button").click(); await page.locator("#writerConfirmBtn").click();
  await page.waitForFunction(() => !writerPending && !appState.readOnly && appState.threadId === "two");
  assert.equal((await terminated()).length, 1);
  assert((await records("calls.jsonl")).some(call => call.method === "thread/resume" && call.params.threadId === "two"));
  assert(await page.locator("#writerSheet").isHidden());
  assert.equal(await page.locator("#input").inputValue(), "保留的草稿");
  assert(!(await records("calls.jsonl")).some(call => call.method === "turn/start"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ width: 390, passed: "进入即检查和弹窗、关闭保留原会话和草稿、迟到检查隔离、仅查看历史、自身释放不碰外部进程、明确确认后接续", realProcessesTerminated: 0, modelPromptsSent: 0 }));
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill(); await once(child, "exit"); }
  for (const directory of ["node_modules", "web"]) { try { await fs.unlink(path.join(root, directory)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
  if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith("codexapp-writer-open-")) throw new Error("拒绝清理测试目录以外的路径");
  await fs.rm(resolved, { recursive: true, force: true });
}
