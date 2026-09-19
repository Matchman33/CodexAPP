import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-change-preview-")), web = path.resolve("web");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), file = path.resolve(web, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(web + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const text = "文件变更中的文本预览\n<script>window.__changeScript = true</script>\n" + "long_line_".repeat(30), workbook = Buffer.from("spreadsheet transport fixture");
  await fs.writeFile(path.join(root, "notes.txt"), text);
  await fs.writeFile(path.join(root, "example.mjs"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "report.xlsx"), workbook);
  await fs.copyFile("web/icon-512.png", path.join(root, "image.png"));
  let socket; const requests = [];
  const bridge = new CodexBridge({ defaultCwd: root }, message => socket?.send(JSON.stringify(message)));
  Object.assign(bridge.state, { threadId: "one", turnId: "turn", cwd: root, codexConnected: true, readOnly: false });
  bridge.history = { paged: true, nextCursor: null };
  bridge._onNotification({ method: "item/completed", params: { threadId: "one", turnId: "turn", item: { id: "file-change", type: "fileChange", status: "completed", changes: ["notes.txt", "example.mjs", "image.png", "report.xlsx"].map(file => ({ path: file, kind: { type: "add" }, diff: "fixture change" })) } } });
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", acceptDownloads: true });
  const url = "http://127.0.0.1:" + server.address().port;
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "file-change-fixture" })), { url });
  const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/ws?*", route => {
    socket = route; route.send(JSON.stringify(bridge.snapshot()));
    route.onMessage(async raw => {
      const message = JSON.parse(raw); requests.push(message);
      if (message.type === "listThreads") { route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] })); return; }
      if (message.type === "historyPage") { route.send(JSON.stringify({ type: "historyPage", threadId: "one", requestId: message.requestId, events: bridge.snapshot().recentEvents, nextCursor: null })); return; }
      try { await bridge.dispatch(message); } catch (error) { route.send(JSON.stringify({ type: "error", requestId: message.requestId, message: error.message })); }
    });
  });
  await page.goto(url); await page.waitForFunction(() => sessionReady && !pageRequest);
  const panel = page.locator('.entry.file details'); await panel.locator("summary").click();
  await panel.getByRole("button", { name: "预览文本：notes.txt", exact: true }).waitFor();
  assert.equal(await panel.locator(".file-attachment").count(), 4);
  assert.equal(await page.locator(".entry.file > .file-attachments").count(), 0);
  assert.equal(await panel.getByRole("button", { name: /^下载文件：/ }).count(), 4);
  assert.equal(await panel.getByRole("button", { name: /^预览/ }).count(), 3);
  assert.equal(requests.filter(m => m.type === "readAttachment").length, 0, "展开文件变更不自动传输任何文件内容");
  await fs.mkdir("dist-check/file-changes-ui", { recursive: true });
  await page.screenshot({ path: "dist-check/file-changes-ui/preview-buttons.png" });
  for (const [name, expected] of [["notes.txt", text], ["example.mjs", "export const value = 1;\n"]]) {
    await panel.getByRole("button", { name: "预览文本：" + name, exact: true }).click();
    await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#textPreviewContent").textContent(), expected);
    assert.equal(await page.getByRole("checkbox", { name: "自动换行", exact: true }).isChecked(), false);
    assert.equal(await page.locator("#textPreviewContent").evaluate(element => getComputedStyle(element).whiteSpace), "pre");
    if (name === "notes.txt") {
      assert(await page.locator("#textPreviewContent").evaluate(element => element.scrollWidth > element.clientWidth));
      await page.getByRole("checkbox", { name: "自动换行", exact: true }).check();
      assert(await page.locator("#textPreviewContent").evaluate(element => getComputedStyle(element).whiteSpace === "pre-wrap" && element.scrollWidth <= element.clientWidth + 1));
      assert.equal(await page.locator("#textPreviewContent").textContent(), expected);
      await page.screenshot({ path: "dist-check/file-changes-ui/text-wrapped.png" });
    }
    assert.equal(await page.evaluate(() => window.__changeScript), undefined);
    await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  }
  await panel.getByRole("button", { name: "预览图片：image.png", exact: true }).click();
  await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 512);
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  const pending = page.waitForEvent("download"); await panel.getByRole("button", { name: "下载文件：report.xlsx", exact: true }).click();
  const download = await pending; assert.deepEqual(await fs.readFile(await download.path()), workbook);
  await page.reload(); await page.locator('.entry.file details summary').click();
  await page.locator('.entry.file details').getByRole("button", { name: "预览文本：notes.txt", exact: true }).waitFor();
  assert.equal(await page.locator('.entry.file details .file-attachment').count(), 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ width: 390, passed: "文件变更框内预览/下载按钮、图片/文本/代码预览、Excel 下载、刷新恢复、展开不预取内容", modelPromptsSent: 0 }));
} finally {
  if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(root); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert(path.basename(resolved).startsWith("codexapp-change-preview-"));
  await fs.rm(resolved, { recursive: true, force: true });
}
