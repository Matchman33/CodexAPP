import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CodexBridge } from "../core/codexBridge.mjs";

const root = path.resolve("web"), output = path.resolve("dist-check/images-ui");
const cache = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-image-web-"));
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = cache;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await fs.mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const width = Number(process.env.CODEXAPP_TEST_WIDTH || 390);
  const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], sent = [], calls = [];
  let socket, hold = false, held = [], accepted;
  const bridge = new CodexBridge({ defaultCwd: "/fixture", approvalPolicy: "on-request", sandbox: "read-only" }, message => {
    if (hold && ["promptQueue", "promptAccepted"].includes(message.type)) { held.push(message); if (message.type === "promptAccepted") accepted?.(); }
    else socket?.send(JSON.stringify(message));
  });
  Object.assign(bridge.state, { codexConnected: true, threadId: "one", status: "running", turnId: "existing" });
  bridge.history = { paged: true, nextCursor: null };
  bridge.models.resolve = async () => "fixture-model"; bridge.models.resolveEffort = async () => null;
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "turn/start") {
      const turn = { id: "image-turn", status: "inProgress" };
      bridge._onNotification({ method: "turn/started", params: { threadId: "one", turn } }); return { turn };
    }
    if (method === "thread/turns/list") return { data: [{ id: "image-turn", startedAt: 100 }], nextCursor: null };
    if (method.includes("items/list")) return { data: [{ id: "saved-user", type: "userMessage", content: calls.find(c => c.method === "turn/start")?.params.input || [] }], nextCursor: null };
    if (method === "turn/interrupt" || method === "turn/steer") return {};
    throw new Error("Unexpected fixture request: " + method);
  };
  page.on("pageerror", error => errors.push(error.message));
  const url = "http://127.0.0.1:" + server.address().port;
  await context.addInitScript(({ url }) => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "lan", url, token: "image-fixture" })), { url });
  await page.routeWebSocket("**/ws?*", route => {
    socket = route; route.send(JSON.stringify(bridge.snapshot()));
    route.onMessage(async raw => {
      const message = JSON.parse(raw); sent.push(message);
      if (message.type === "listThreads") { route.send(JSON.stringify({ type: "projectTree", projects: [], projectless: [] })); return; }
      try { await bridge.dispatch(message); } catch (error) { route.send(JSON.stringify({ type: "error", message: error.message, requestId: message.requestId })); }
    });
  });
  await page.goto(url); await page.waitForFunction(() => sessionReady && imageUploadSupported);
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 320;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#14866d"; ctx.fillRect(0,0,480,320); ctx.fillStyle = "#edb63e"; ctx.fillRect(30,30,200,180); ctx.fillStyle = "#ffffff"; ctx.font = "28px sans-serif"; ctx.fillText("Image upload",30,270); return canvas.toDataURL("image/png");
  });
  const file = { name: "capture.png", mimeType: "image/png", buffer: Buffer.from(data.split(",")[1], "base64") };
  const largeData = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 700;
    const ctx = canvas.getContext("2d"), pixels = ctx.createImageData(700,700);
    for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, Math.min(i + 65536, pixels.data.length)));
    ctx.putImageData(pixels,0,0); return canvas.toDataURL("image/png");
  });
  const largeFile = { name: "large.png", mimeType: "image/png", buffer: Buffer.from(largeData.split(",")[1], "base64") };
  assert(largeFile.buffer.length > 1048576);
  await page.locator("#imageInput").setInputFiles(largeFile); await page.waitForFunction(() => attachments.items.length === 1 && !attachments.busy);
  assert(await page.evaluate(() => attachments.items[0].dataUrl.startsWith("data:image/jpeg;base64,") && atob(attachments.items[0].dataUrl.split(",")[1]).length <= 1048576));
  await page.getByRole("button", { name: "移除图片：large.png" }).click();
  await page.locator("#imageInput").setInputFiles(file);
  await page.waitForFunction(() => attachments.items.length === 1 && !attachments.busy);
  await page.getByRole("button", { name: "移除图片：capture.png" }).click();
  assert.equal(await page.locator("#imageDrafts img").count(), 0);
  await page.locator("#imageInput").setInputFiles(file);
  await page.waitForFunction(() => attachments.items.length === 1 && !attachments.busy);
  await page.locator("#imageDrafts .photo-preview").click(); await page.locator("#imageDialog").waitFor({ state: "visible" });
  assert(await page.locator("#imageDialog img").evaluate(image => image.complete && image.naturalWidth > 0));
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  for (const type of ["paste", "drop"]) {
    await page.evaluate(({ data, type }) => {
      const bytes = Uint8Array.from(atob(data.split(",")[1]), c => c.charCodeAt(0)), transfer = new DataTransfer();
      transfer.items.add(new File([bytes], type + ".png", { type: "image/png" }));
      if (type === "paste") $("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      else document.querySelector(".composer-box").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { data, type });
    await page.waitForFunction(expected => attachments.items.length === expected && !attachments.busy, type === "paste" ? 2 : 3);
  }
  await page.locator("#imageInput").setInputFiles({ name: "blocked.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await page.locator("#promptStatus").filter({ hasText: "仅支持" }).waitFor(); assert.equal(await page.locator("#imageDrafts img").count(), 3);
  await page.locator("#imageInput").setInputFiles([file,file]);
  await page.locator("#promptStatus").filter({ hasText: "最多" }).waitFor(); assert.equal(await page.locator("#imageDrafts img").count(), 3);
  await page.locator("#input").fill("Inspect these images");
  await page.screenshot({ path: path.join(output, width + "-draft.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  hold = true; const acknowledgement = new Promise(resolve => { accepted = resolve; });
  await page.locator("#sendBtn").click(); await acknowledgement;
  assert.equal(await page.locator("#imageDrafts img").count(), 3); assert.equal(await page.locator("#input").inputValue(), "Inspect these images");
  assert(await page.getByRole("button", { name: "移除图片：capture.png" }).isDisabled());
  hold = false; for (const message of held) socket.send(JSON.stringify(message)); held = [];
  await page.waitForFunction(() => !pendingPrompt && attachments.items.length === 0);
  assert.equal(bridge.snapshot().promptQueue.items[0].images.length, 3);
  assert.equal(bridge.snapshot().promptQueue.items[0].images[0].dataUrl, undefined);
  await page.reload(); await page.waitForFunction(() => sessionReady && promptQueueState?.items[0]?.images.length === 3);
  assert.equal(calls.filter(call => call.method === "turn/start").length, 0);
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "existing", status: "completed" } } });
  await bridge.commandQueue; await page.waitForFunction(() => appState.turnId === "image-turn" && promptQueueState.items.length === 0);
  const started = calls.find(call => call.method === "turn/start");
  assert.equal(started.params.input.filter(input => input.type === "image").length, 3);
  await page.locator(".message-photos img").first().waitFor();
  await page.evaluate(() => requestHistoryPage(0, true));
  await page.waitForFunction(() => !pageRequest && historyFeed.events.some(event => event.itemId === "saved-user"));
  assert.equal(await page.locator(".entry.user").count(), 1, "persisted image input replaces its temporary echo");
  assert.equal(await page.locator(".message-photos img").count(), 3);
  await page.screenshot({ path: path.join(output, width + "-sent.png") });
  await page.locator("#input").fill(""); await page.locator("#steerMode").check();
  await page.locator("#imageInput").setInputFiles(file); await page.waitForFunction(() => attachments.items.length === 1 && !attachments.busy);
  assert.equal(await page.locator("#sendBtn").isDisabled(), false);
  await page.locator("#sendBtn").click(); await page.waitForFunction(() => attachments.items.length === 0);
  await page.waitForFunction(() => historyFeed.events.some(event => event.text === "↪ [图片]"));
  assert.deepEqual(calls.find(call => call.method === "turn/steer").params.input.map(input => input.type), ["image"]);
  await page.locator("#interruptBtn").click(); await page.waitForFunction(() => promptQueueState.paused);
  assert.equal(calls.filter(call => call.method === "turn/interrupt").length, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ width, passed: "compression, selection, removal, reselection, preview, paste, drop, validation, acknowledgement, queue, refresh, history identity, image-only steer and stop", modelPromptsSent: 0 }));
  await context.close();
} finally {
  if (browser) await browser.close(); await new Promise(resolve => server.close(resolve));
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  const previews = path.join(cache, "codexapp-image-previews");
  try { for (const file of await fs.readdir(previews)) await fs.unlink(path.join(previews, file)); await fs.rmdir(previews); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.rmdir(cache);
}
