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
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator(".file-image-preview").count(), 0, "聊天不显示自动缩略图");
  assert.equal(requests.length, 0, "展示附件不会自动读取图片");
  assert.match(await page.locator("#generated-2 summary").textContent(), /执行记录.*已完成/);
  assert.equal(await page.locator("#generated-2 .body").textContent(), "[图片] " + smokeImage);
  assert.equal(await page.locator("#imageDialog").isVisible(), false, "展示附件不应打开弹窗");
  for (const name of ["项目图片.png", "默认图片.png", "skill-hover-1040.png"]) {
    await page.getByRole("button", { name: "预览图片：" + name, exact: true }).click();
    await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 480);
    await page.getByRole("button", { name: "关闭图片预览" }).click();
  }
  assert.equal(requests.length, 3, "只读取用户点击预览的图片");
  const beforePreview = requests.length;
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件：默认图片.png", exact: true }).click();
  const download = await pending; assert.deepEqual(await fs.readFile(await download.path()), bytes);
  assert.equal(download.suggestedFilename(), "默认图片.png");
  const pendingSmoke = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载文件：skill-hover-1040.png", exact: true }).click();
  assert.deepEqual(await fs.readFile(await (await pendingSmoke).path()), bytes);
  await page.evaluate(event => fileDownloads.render(document.querySelector("#generated-0"), event), events[0]);
  await page.getByRole("button", { name: "预览图片：项目图片.png", exact: true }).click();
  await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 480);
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  assert.equal(requests.length, beforePreview, "再次预览和下载应复用已读取图片");
  assert.equal(await page.locator('.body img, img[src^="file:"], img[src^="https:"]').count(), 0);
  for (const [index, item] of [
    { id: "mcp", type: "mcpToolCall", server: "fixture", tool: "image", result: { content: [{ type: "image", mimeType: "image/png", data: image }] } },
    { id: "dynamic", type: "dynamicToolCall", tool: "image", contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64," + image }] },
    { id: "result", type: "imageGeneration", status: "completed", result: image },
  ].entries()) {
    const event = store.decorateEvent({ ...itemToEvent(item), threadId: "one" }, { threadId: "one", cwd: project });
    const before = requests.length;
    await page.evaluate(({ event, index }) => { const row = createEventRow(event); row.id = "tool-image-" + index; document.body.append(row); }, { event, index });
    assert.equal(requests.length, before, "工具图片也只能点击后读取");
    const row = page.locator("#tool-image-" + index);
    if (await row.locator("details").count()) await row.locator("summary").click();
    await row.getByRole("button", { name: "预览图片：工具图片-1.png", exact: true }).click();
    await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 480);
    await page.getByRole("button", { name: "关闭图片预览" }).click();
    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "下载文件：工具图片-1.png", exact: true }).click();
    assert.deepEqual(await fs.readFile(await (await download).path()), bytes);
  }
  await fs.mkdir("dist-check/generated-images", { recursive: true });
  await page.screenshot({ path: "dist-check/generated-images/preview-buttons.png" });
  const backgroundImage = path.join(project, "outputs", "后台图片.png"), foregroundFile = path.join(project, "outputs", "前台文件.txt");
  await fs.writeFile(backgroundImage, bytes); await fs.writeFile(foregroundFile, "前台预览无需等待图片");
  const priorityEvent = store.decorateEvent({ kind: "item:agentMessage", threadId: "one", text: "后台与前台附件", fileRefs: [backgroundImage, foregroundFile] }, { threadId: "one", cwd: project });
  await page.evaluate(event => {
    const row = document.createElement("div"); row.id = "generated-priority"; document.body.append(row); fileDownloads.render(row, event);
  }, priorityEvent);
  await page.getByRole("button", { name: "预览文本：前台文件.txt", exact: true }).click();
  await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#textPreviewContent").textContent(), "前台预览无需等待图片");
  assert(!requests.some(request => request.attachmentId === priorityEvent.files[0].id), "未点击的图片不能后台加载或占用文本预览");
  await page.getByRole("button", { name: "关闭文本预览", exact: true }).click();
  const reconnectImage = path.join(project, "outputs", "重连图片.png"); await fs.writeFile(reconnectImage, bytes);
  const reconnectEvent = store.decorateEvent({ kind: "item:agentMessage", threadId: "one", text: "重连附件", fileRefs: [reconnectImage] }, { threadId: "one", cwd: project });
  heldAttachment = reconnectEvent.files[0].id;
  await page.evaluate(event => {
    const row = document.createElement("div"); row.id = "generated-reconnect"; document.body.append(row); fileDownloads.render(row, event);
  }, reconnectEvent);
  await page.getByRole("button", { name: "预览图片：重连图片.png", exact: true }).click();
  await page.waitForFunction(() => fileDownloads.active?.preview === "image" && fileDownloads.active.file.name === "重连图片.png");
  await page.evaluate(() => fileDownloads.disconnect());
  releaseHeldRead();
  await page.evaluate(event => { fileDownloads.configure({ supported: true }); fileDownloads.render(document.querySelector("#generated-reconnect"), event); }, reconnectEvent);
  await page.getByRole("button", { name: "预览图片：重连图片.png", exact: true }).click();
  await page.waitForFunction(() => $("imageDialog").open && $("imageDialog").querySelector("img").naturalWidth === 480);
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  const cachedUrl = await page.evaluate(id => fileDownloads.imageCache.get(id).url, reconnectEvent.files[0].id);
  const cachedBytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], cachedUrl);
  assert.deepEqual(Buffer.from(cachedBytes), bytes, "重置前缓存图片 URL 可读取原图");
  const revoked = await page.evaluate(async url => { fileDownloads.reset(); try { await fetch(url); return false; } catch { return true; } }, cachedUrl);
  assert.equal(revoked, true, "切换电脑或重置时撤销旧图片 URL");
  assert.deepEqual(errors, []);
  console.log("项目、默认目录和 .smoke 查看图片执行记录：不自动加载、点击预览、下载、缓存复用、文本预览、断线重连及重置验证通过。");
} finally {
  await browser?.close();
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("codexapp-generated-images-web-"));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
