import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-file-web-"));
const workbook = crypto.randomBytes(192 * 1024 * 2 + 257), pdf = Buffer.from("%PDF-1.4\ntransport fixture\n%%EOF");
let child, browser, observer;
try {
  await fs.cp("core", path.join(root, "core"), { recursive: true }); await fs.mkdir(path.join(root, "relay"));
  await fs.copyFile("relay/server.mjs", path.join(root, "relay/server.mjs"));
  for (const name of ["web", "node_modules"]) await fs.symlink(path.resolve(name), path.join(root, name), process.platform === "win32" ? "junction" : "dir");
  await fs.mkdir(path.join(root, "exports")); await fs.writeFile(path.join(root, "exports/报表.xlsx"), workbook); await fs.writeFile(path.join(root, "exports/report.pdf"), pdf);
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  await fs.writeFile(path.join(root, "codexapp.config.json"), JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port, token: "files-fixture", defaultCwd: root, preventSleep: false }));
  child = spawn(process.execPath, [path.join(root, "relay/server.mjs")], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/filesCodex.mjs")).href, CODEX_HOME: path.join(root, "home"), CODEXAPP_PREVENT_SLEEP: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", b => { log += b; }); child.stderr.on("data", b => { log += b; });
  const url = "http://127.0.0.1:" + port;
  let healthy = false;
  for (let i = 0; i < 100; i++) { try { healthy = (await fetch(url + "/health")).ok; } catch {} if (healthy || child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(healthy, log);
  const rejected = new WebSocket("ws://127.0.0.1:" + port + "/ws?token=invalid"), rejectedMessages = [];
  rejected.on("message", data => rejectedMessages.push(JSON.parse(data)));
  assert.equal((await once(rejected, "close"))[0], 4001); assert(!rejectedMessages.some(m => m.type === "attachmentChunk"));
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "files-fixture" })), { url });
  const page = await context.newPage(), errors = [], receivedDownloads = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("download", d => receivedDownloads.push(d));
  const image = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 300; const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 480, 300); ctx.fillStyle = "#15966e"; ctx.fillRect(40, 100, 100, 160); ctx.fillStyle = "#eab841"; ctx.fillRect(180, 45, 100, 215); ctx.fillStyle = "#ce5263"; ctx.fillRect(320, 145, 100, 115); return canvas.toDataURL("image/png").split(",")[1]; });
  await fs.writeFile(path.join(root, "exports/chart.png"), Buffer.from(image, "base64"));
  await page.goto(url); await page.waitForFunction(() => sessionReady);
  await page.locator("#sessionsBtn").click(); await page.locator('.session-item[data-thread-id="one"]').click();
  await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).waitFor();
  assert.equal(await page.locator(".file-attachment").count(), 3);
  await page.getByRole("link", { name: "项目外文件", exact: true }).click();
  await page.locator("#downloadStatus").filter({ hasText: "未开放下载" }).waitFor(); assert.equal(page.url(), url + "/");
  const firstId = await page.evaluate(() => historyFeed.events.find(e => e.files?.length).files[0].id);
  const observed = []; observer = new WebSocket("ws://127.0.0.1:" + port + "/ws?token=files-fixture"); observer.on("message", raw => observed.push(JSON.parse(raw))); await once(observer, "open");
  const downloadFile = async name => {
    const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "下载文件：" + name, exact: true }).click();
    const download = await pending; assert.equal(download.suggestedFilename(), name); assert.equal(await download.failure(), null); return fs.readFile(await download.path());
  };
  assert.deepEqual(await downloadFile("报表.xlsx"), workbook);
  assert.deepEqual(await downloadFile("report.pdf"), pdf);
  assert(!observed.some(m => m.type === "attachmentChunk"), "文件内容只返回请求方，不向其他客户端广播");
  await page.getByRole("button", { name: "预览图片：chart.png", exact: true }).click();
  await page.locator("#imageDialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => $("imageDialog").querySelector("img").naturalWidth === 480);
  await fs.mkdir("dist-check/files-ui", { recursive: true }); await page.screenshot({ path: "dist-check/files-ui/image-preview.png" });
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await page.reload(); await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => historyFeed.events.find(e => e.files?.length).files[0].id), firstId);
  await page.screenshot({ path: "dist-check/files-ui/attachments.png" });
  const downloadsBefore = receivedDownloads.length;
  await page.evaluate(() => { document.querySelector('[aria-label="下载文件：报表.xlsx"]').click(); $("cancelDownload").click(); });
  await page.locator("#downloadStatus").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await page.evaluate(() => fileDownloads.active), null);
  await page.evaluate(() => { document.querySelector('[aria-label="下载文件：报表.xlsx"]').click(); disposeConnection(); });
  await page.locator("#downloadStatus").filter({ hasText: "连接已断开" }).waitFor();
  await page.evaluate(() => resumeConnection()); await page.waitForFunction(() => sessionReady);
  await fs.writeFile(path.join(root, "exports/报表.xlsx"), "changed during download");
  await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).click();
  await page.locator("#downloadStatus").filter({ hasText: "变化" }).waitFor();
  assert.equal(receivedDownloads.length, downloadsBefore);
  assert.equal((await fetch(url + "/exports/报表.xlsx")).status, 404);
  const response = once(observer, "message"); observer.send(JSON.stringify({ type: "readAttachment", attachmentId: path.join(root, "codexapp.config.json"), threadId: "one", requestId: "bad" }));
  const invalid = JSON.parse((await response)[0]); assert.equal(invalid.type, "error");
  assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  console.log(JSON.stringify({ width: 390, passed: "图片预览、Excel/PDF 字节一致下载、鉴权、请求方隔离、刷新、取消、断线和文件变化拒绝", modelPromptsSent: 0 }));
} finally {
  observer?.terminate(); if (browser) await browser.close();
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  for (const name of ["node_modules", "web"]) { try { await fs.unlink(path.join(root, name)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert(path.basename(resolved).startsWith("codexapp-file-web-"));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
