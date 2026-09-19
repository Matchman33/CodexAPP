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
const textFixtures = { "notes.txt": "你好，文本预览。\n<script>window.__textExecuted = true</script>\n第二行", "readme.md": "# 文本标题\n\n**保留 Markdown 原文**", "data.json": '{"测试":true}', "data.csv": "名称,数量\n苹果,3", "long.txt": "长文本\n".repeat(220000), "empty.txt": "" };
let child, browser, observer, proxy;
const proxySockets = new Set();
try {
  await fs.cp("core", path.join(root, "core"), { recursive: true }); await fs.mkdir(path.join(root, "relay"));
  await fs.copyFile("relay/server.mjs", path.join(root, "relay/server.mjs"));
  for (const name of ["web", "node_modules"]) await fs.symlink(path.resolve(name), path.join(root, name), process.platform === "win32" ? "junction" : "dir");
  await fs.mkdir(path.join(root, "exports")); await fs.writeFile(path.join(root, "exports/报表.xlsx"), workbook); await fs.writeFile(path.join(root, "exports/report.pdf"), pdf);
  for (const [name, content] of Object.entries(textFixtures)) await fs.writeFile(path.join(root, "exports", name), content);
  await fs.writeFile(path.join(root, "exports/gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
  await fs.writeFile(path.join(root, "exports/utf16.txt"), Buffer.concat([Buffer.from([255, 254]), Buffer.from("UTF-16 中文", "utf16le")]));
  await fs.writeFile(path.join(root, "exports/binary.txt"), Buffer.from([0, 1, 2, 3]));
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  await fs.writeFile(path.join(root, "codexapp.config.json"), JSON.stringify({ codexBin: process.execPath, host: "127.0.0.1", port, token: "files-fixture", defaultCwd: root, preventSleep: false }));
  child = spawn(process.execPath, [path.join(root, "relay/server.mjs")], { cwd: root, env: { ...process.env, NODE_OPTIONS: "--import=" + pathToFileURL(path.resolve("tests/fixtures/filesCodex.mjs")).href, CODEX_HOME: path.join(root, "home"), CODEXAPP_PREVENT_SLEEP: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", b => { log += b; }); child.stderr.on("data", b => { log += b; });
  const upstreamUrl = "http://127.0.0.1:" + port;
  let healthy = false;
  for (let i = 0; i < 100; i++) { try { healthy = (await fetch(upstreamUrl + "/health")).ok; } catch {} if (healthy || child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert(healthy, log);
  // 模拟 NPS 的 TCP 转发：浏览器只知道转发入口，与电脑中继端口不同。
  proxy = net.createServer(socket => {
    const upstream = net.connect({ host: "127.0.0.1", port });
    for (const connection of [socket, upstream]) { proxySockets.add(connection); connection.on("close", () => proxySockets.delete(connection)); }
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port, url = "http://phone-gateway.test:" + proxyPort;
  const rejected = new WebSocket("ws://127.0.0.1:" + port + "/ws?token=invalid"), rejectedMessages = [];
  rejected.on("message", data => rejectedMessages.push(JSON.parse(data)));
  assert.equal((await once(rejected, "close"))[0], 4001); assert(!rejectedMessages.some(m => m.type === "attachmentChunk"));
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true, args: ["--host-resolver-rules=MAP phone-gateway.test 127.0.0.1", "--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", acceptDownloads: true });
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "files-fixture" })), { url });
  const page = await context.newPage(), errors = [], receivedDownloads = [], networkUrls = [], attachmentRequests = [];
  page.on("request", request => networkUrls.push(request.url())); page.on("websocket", socket => { networkUrls.push(socket.url()); socket.on("framesent", frame => { try { const message = JSON.parse(frame.payload); if (message.type === "readAttachment") attachmentRequests.push(message); } catch {} }); });
  page.on("pageerror", error => errors.push(error.message)); page.on("download", d => receivedDownloads.push(d));
  const image = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 300; const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 480, 300); ctx.fillStyle = "#15966e"; ctx.fillRect(40, 100, 100, 160); ctx.fillStyle = "#eab841"; ctx.fillRect(180, 45, 100, 215); ctx.fillStyle = "#ce5263"; ctx.fillRect(320, 145, 100, 115); return canvas.toDataURL("image/png").split(",")[1]; });
  await fs.writeFile(path.join(root, "exports/chart.png"), Buffer.from(image, "base64"));
  await page.goto(url); await page.waitForFunction(() => sessionReady);
  await page.locator("#sessionsBtn").click(); await page.locator('.session-item[data-thread-id="one"]').click();
  await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).waitFor();
  assert.equal(await page.locator("#downloadBar, #downloadStatus, #saveDownloadedFile, #cancelDownload").count(), 0);
  assert.equal(await page.locator(".file-attachment").count(), 12);
  await page.getByRole("link", { name: "项目外文件", exact: true }).click();
  await page.locator(".file-message").filter({ hasText: "未开放下载" }).waitFor(); assert.equal(page.url(), url + "/");
  const firstId = await page.evaluate(() => historyFeed.events.find(e => e.files?.length).files[0].id);
  const observed = []; observer = new WebSocket("ws://127.0.0.1:" + port + "/ws?token=files-fixture"); observer.on("message", raw => observed.push(JSON.parse(raw))); await once(observer, "open");
  const downloadFile = async name => {
    const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "下载文件：" + name, exact: true }).click();
    const download = await pending; assert.equal(download.suggestedFilename(), name); assert.equal(await download.failure(), null); return fs.readFile(await download.path());
  };
  assert.deepEqual(await downloadFile("报表.xlsx"), workbook);
  assert.deepEqual(await downloadFile("report.pdf"), pdf);
  const linkDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载测试图片", exact: true }).click();
  const picture = await linkDownload; assert.equal(picture.suggestedFilename(), "chart.png"); assert.deepEqual(await fs.readFile(await picture.path()), Buffer.from(image, "base64"));
  // 手机浏览器可直接再次点击聊天链接保存，不需要单独状态栏。
  const manualSave = page.waitForEvent("download"); await page.getByRole("link", { name: "下载测试图片", exact: true }).click();
  assert.equal((await manualSave).suggestedFilename(), "chart.png");
  assert(!observed.some(m => m.type === "attachmentChunk"), "文件内容只返回请求方，不向其他客户端广播");
  await page.getByRole("link", { name: "测试图片", exact: true }).click();
  await page.locator("#imageDialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => $("imageDialog").querySelector("img").naturalWidth === 480);
  assert((await page.locator("#imageDialog img").getAttribute("src")).startsWith("blob:" + url + "/"));
  assert.equal(await page.locator('.body a[href^="javascript:"], .body img').count(), 0);
  await fs.mkdir("dist-check/files-ui", { recursive: true }); await page.screenshot({ path: "dist-check/files-ui/image-preview.png" });
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await page.evaluate(() => { fileDownloads.configure(null); for (const row of historyFeed.rows.values()) setEventText(row, row._event); });
  await page.getByRole("link", { name: "下载测试图片", exact: true }).click();
  await page.locator(".file-message").filter({ hasText: "当前中继尚未启用" }).waitFor();
  await page.reload(); await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => historyFeed.events.find(e => e.files?.length).files[0].id), firstId);
  await page.screenshot({ path: "dist-check/files-ui/attachments.png" });
  for (const name of ["notes.txt", "readme.md", "data.json", "data.csv", "empty.txt"]) {
    await page.getByRole("button", { name: "预览文本：" + name, exact: true }).click();
    await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#textPreviewTitle").textContent(), name);
    assert.equal(await page.locator("#textPreviewContent").textContent(), textFixtures[name]);
    assert.equal(await page.locator("#textPreviewContent script, #textPreviewContent img").count(), 0);
    if (name === "notes.txt") {
      assert.equal(await page.evaluate(() => window.__textExecuted), undefined);
      await page.screenshot({ path: "dist-check/files-ui/text-preview.png" });
      const textDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "下载完整文本文件", exact: true }).click();
      assert.equal((await fs.readFile(await (await textDownload).path())).toString(), textFixtures[name]);
    } else await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  }
  await page.getByRole("button", { name: "预览文本：gbk.txt", exact: true }).click(); await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#textPreviewContent").textContent(), "你好");
  await page.locator("#textPreviewEncoding").selectOption("utf-8"); assert.match(await page.locator("#textPreviewNote").textContent(), /无法按此编码/);
  await page.locator("#textPreviewEncoding").selectOption("gb18030"); assert.equal(await page.locator("#textPreviewContent").textContent(), "你好");
  await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  await page.getByRole("button", { name: "预览文本：utf16.txt", exact: true }).click(); await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#textPreviewContent").textContent(), "UTF-16 中文");
  await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  await page.getByRole("button", { name: "预览文本：binary.txt", exact: true }).click(); await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#textPreviewNote").textContent(), /内容不是文本/);
  await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  const requestStart = attachmentRequests.length;
  await page.getByRole("button", { name: "预览文本：long.txt", exact: true }).click(); await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
  assert.match(await page.locator("#textPreviewNote").textContent(), /仅预览前 1 MiB/);
  assert(attachmentRequests.slice(requestStart).every(request => request.offset < 1048576), "长文本预览不读取完整文件");
  assert((await page.locator("#textPreviewContent").textContent()).startsWith("长文本\n"));
  const completeTextDownload = page.waitForEvent("download"); await page.getByRole("button", { name: "下载完整文本文件", exact: true }).click();
  assert.equal((await fs.readFile(await (await completeTextDownload).path())).toString(), textFixtures["long.txt"]);
  const downloadsBefore = receivedDownloads.length;
  await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => { document.querySelector('[aria-label="下载文件：报表.xlsx"]').click(); document.querySelector('[aria-label="取消接收：报表.xlsx"]').click(); });
  await page.locator(".file-feedback").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await page.evaluate(() => fileDownloads.active), null);
  await page.evaluate(() => { document.querySelector('[aria-label="下载文件：报表.xlsx"]').click(); disposeConnection(); });
  await page.locator(".file-feedback").filter({ hasText: "连接已断开" }).waitFor();
  await page.evaluate(() => resumeConnection()); await page.waitForFunction(() => sessionReady);
  await fs.writeFile(path.join(root, "exports/报表.xlsx"), "changed during download");
  await page.getByRole("button", { name: "下载文件：报表.xlsx", exact: true }).click();
  await page.locator(".file-feedback").filter({ hasText: "变化" }).waitFor();
  assert.equal(receivedDownloads.length, downloadsBefore);
  assert.equal((await fetch("http://127.0.0.1:" + proxyPort + "/exports/报表.xlsx")).status, 404);
  const response = once(observer, "message"); observer.send(JSON.stringify({ type: "readAttachment", attachmentId: path.join(root, "codexapp.config.json"), threadId: "one", requestId: "bad" }));
  const invalid = JSON.parse((await response)[0]); assert.equal(invalid.type, "error");
  assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert(networkUrls.some(address => address.startsWith("ws://phone-gateway.test:" + proxyPort + "/ws")));
  assert(!networkUrls.some(address => /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(address)), "手机浏览器不能请求电脑的回环地址");
  console.log(JSON.stringify({ width: 390, passed: "无全局下载状态栏、聊天内下载和取消、纯文本预览与安全显示、编码切换、长文本有界预览、NPS 转发和图片/Excel/PDF 回归", modelPromptsSent: 0 }));
} finally {
  observer?.terminate(); if (browser) await browser.close();
  for (const socket of proxySockets) socket.destroy();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  for (const name of ["node_modules", "web"]) { try { await fs.unlink(path.join(root, name)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert(path.basename(resolved).startsWith("codexapp-file-web-"));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
