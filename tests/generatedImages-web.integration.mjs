import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { FileAttachments } from "../core/fileAttachments.mjs";
import { itemToEvent } from "../core/threadDisplay.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-generated-images-web-"));
const project = path.join(temp, "project"), codexHome = path.join(temp, ".codex");
const origin = "http://generated-images.test", web = path.resolve("web");
let browser;
try {
  await fs.mkdir(path.join(project, "outputs"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "generated_images"), { recursive: true });
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", acceptDownloads: true });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const file = path.resolve(web, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(web + path.sep)) return route.fulfill({ status: 403, body: "" });
    try { await route.fulfill({ contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream", body: await fs.readFile(file) }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  });
  const page = await context.newPage(), errors = [], requests = [];
  let heldAttachment = null, releaseHeldRead = null;
  page.on("pageerror", error => errors.push(error.message));
  const store = new FileAttachments({ codexHome }); store.remember("one", project);
  await page.exposeFunction("readGeneratedAttachment", async request => {
    requests.push(request);
    if (request.attachmentId === heldAttachment) {
      heldAttachment = null;
      await new Promise(resolve => { releaseHeldRead = resolve; });
    }
    return store.read(request);
  });
  await page.goto(origin); await page.waitForFunction(() => window.ChatUI && typeof fileDownloads !== "undefined");
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 300;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#15966e"; ctx.fillRect(0, 0, 480, 300);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const bytes = Buffer.from(image, "base64"), projectImage = path.join(project, "outputs", "项目图片.png"), defaultImage = path.join(codexHome, "generated_images", "默认图片.png");
  await fs.writeFile(projectImage, bytes); await fs.writeFile(defaultImage, bytes);
  const smokeImage = path.join(project, "page", ".smoke", "skill-hover-1040.png");
  await fs.mkdir(path.dirname(smokeImage), { recursive: true }); await fs.writeFile(smokeImage, bytes);
  const events = [
    { kind: "item:agentMessage", threadId: "one", text: "图片已生成，保存在 " + projectImage + "，请查看。" },
    { ...itemToEvent({ id: "image", type: "imageGeneration", savedPath: defaultImage, status: "completed" }), threadId: "one" },
    { ...itemToEvent({ id: "view", type: "imageView", path: smokeImage, status: "completed" }), threadId: "one" },
  ].map(event => store.decorateEvent(event, { threadId: "one", cwd: project }));
  assert(events.every(event => event.files?.length === 1));
  const nativeLinks = await page.evaluate(file => {
    const body = document.createElement("div");
    body.innerHTML = window.ChatUI.markdown("[原生路径图片](<" + file.reference + ">)\n\n![原生路径图片](<" + file.reference + ">)", [file]);
    return [...body.querySelectorAll("a")].map(link => link.getAttribute("href"));
  }, events[1].files[0]);
  assert.deepEqual(nativeLinks, ["#codex-file-0", "#codex-preview-0"], "带隐藏目录的原生 Windows 图片链接必须关联实际附件");
  const externalLink = await page.evaluate(file => {
    const body = document.createElement("div");
    body.innerHTML = window.ChatUI.markdown("[`示例](" + file.reference + ")`](https://example.com)", [file]);
    return body.querySelector("a").getAttribute("href");
  }, events[1].files[0]);
  assert.equal(externalLink, "https://example.com", "链接标签中的本地路径不能覆盖真实网页地址");
  await page.evaluate(events => {
    $("setup").classList.add("hidden"); $("app").classList.add("hidden");
    fileDownloads.configure({ supported: true });
    fileDownloads.send = request => { window.readGeneratedAttachment(request).then(message => fileDownloads.receive(message)).catch(error => fileDownloads.error({ requestId: request.requestId, message: error.message })); return true; };
    for (const [index, event] of events.entries()) {
      const row = createEventRow(event); row.id = "generated-" + index; document.body.append(row);
    }
  }, events);
  await page.waitForFunction(() => [...document.querySelectorAll(".file-image-preview img")].filter(image => image.naturalWidth === 480).length === 3, null, { timeout: 5000 });
  assert.match(await page.locator("#generated-2 summary").textContent(), /执行记录.*已完成/);
  assert.equal(await page.locator("#generated-2 .body").textContent(), "[图片] " + smokeImage);
  assert.equal(await page.locator("#imageDialog").isVisible(), false, "自动缩略图不应打开弹窗");
  const beforePreview = requests.length;
  await page.locator("#generated-0 .file-image-preview").click();
  await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 480);
  assert.equal(requests.length, beforePreview, "放大已加载图片应复用内容");
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件：默认图片.png", exact: true }).click();
  const download = await pending; assert.deepEqual(await fs.readFile(await download.path()), bytes);
  assert.equal(download.suggestedFilename(), "默认图片.png");
  await page.locator("#generated-2 .file-image-preview").click();
  await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 480);
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  const pendingSmoke = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件：skill-hover-1040.png", exact: true }).click();
  assert.deepEqual(await fs.readFile(await (await pendingSmoke).path()), bytes);
  await page.evaluate(event => fileDownloads.render(document.querySelector("#generated-0"), event), events[0]);
  await page.waitForFunction(() => document.querySelector("#generated-0 .file-image-preview img")?.naturalWidth === 480);
  assert.equal(requests.length, beforePreview, "重绘和下载应复用缩略图缓存");
  assert.equal(await page.locator('.body img, img[src^="file:"], img[src^="https:"]').count(), 0);
  await fs.mkdir("dist-check/generated-images", { recursive: true });
  await page.screenshot({ path: "dist-check/generated-images/thumbnails.png" });
  const backgroundImage = path.join(project, "outputs", "后台图片.png"), foregroundFile = path.join(project, "outputs", "前台文件.txt");
  await fs.writeFile(backgroundImage, bytes); await fs.writeFile(foregroundFile, "前台预览无需等待图片");
  const priorityEvent = store.decorateEvent({ kind: "item:agentMessage", threadId: "one", text: "后台与前台附件", fileRefs: [backgroundImage, foregroundFile] }, { threadId: "one", cwd: project });
  heldAttachment = priorityEvent.files[0].id;
  await page.evaluate(event => {
    const row = document.createElement("div"); row.id = "generated-priority"; document.body.append(row); fileDownloads.render(row, event);
  }, priorityEvent);
  await page.locator("#generated-priority .file-image-preview").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => fileDownloads.active?.preview === "thumbnail" && fileDownloads.active.file.name === "后台图片.png");
  await page.getByRole("button", { name: "预览文本：前台文件.txt", exact: true }).click();
  await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#textPreviewContent").textContent(), "前台预览无需等待图片", "缓慢后台缩略图不能阻塞用户预览");
  assert(releaseHeldRead); releaseHeldRead();
  await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#generated-priority .file-image-preview img")?.naturalWidth === 480);
  const reconnectImage = path.join(project, "outputs", "重连图片.png"); await fs.writeFile(reconnectImage, bytes);
  const reconnectEvent = store.decorateEvent({ kind: "item:agentMessage", threadId: "one", text: "重连附件", fileRefs: [reconnectImage] }, { threadId: "one", cwd: project });
  heldAttachment = reconnectEvent.files[0].id;
  await page.evaluate(event => {
    const row = document.createElement("div"); row.id = "generated-reconnect"; document.body.append(row); fileDownloads.render(row, event);
  }, reconnectEvent);
  await page.locator("#generated-reconnect .file-image-preview").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => fileDownloads.active?.preview === "thumbnail" && fileDownloads.active.file.name === "重连图片.png");
  await page.evaluate(() => fileDownloads.disconnect());
  releaseHeldRead();
  await page.evaluate(event => { fileDownloads.configure({ supported: true }); fileDownloads.render(document.querySelector("#generated-reconnect"), event); }, reconnectEvent);
  await page.waitForFunction(() => document.querySelector("#generated-reconnect .file-image-preview img")?.naturalWidth === 480, null, { timeout: 5000 });
  await page.evaluate(() => fileDownloads.reset());
  assert.equal(await page.locator(".file-image-preview img[src]").count(), 0, "切换电脑或重置时移除旧图片 URL");
  assert.deepEqual(errors, []);
  console.log("项目、默认目录和 .smoke 查看图片执行记录：缩略图、放大、下载、缓存复用、前台请求优先、断线重连及重置验证通过。");
} finally {
  await browser?.close();
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("codexapp-generated-images-web-"));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
