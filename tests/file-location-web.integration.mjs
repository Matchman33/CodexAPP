import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.resolve("web");
const browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { await route.fulfill({ status: 403, body: "" }); return; }
    try { await route.fulfill({ body: await fs.readFile(file), contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  });
  const page = await context.newPage(), errors = [], downloads = [];
  page.on("pageerror", e => errors.push(e.message)); page.on("download", d => downloads.push(d));
  await page.goto("http://preview-fixture.test/");
  await page.waitForFunction(() => typeof fileDownloads !== "undefined");
  const source = Array.from({ length: 250 }, (_, index) => index === 119 ? " ".repeat(180) + "const TARGET = '<script>window.previewExecuted=true</script>';" : "// source line " + (index + 1)).join("\r\n");
  await page.evaluate(({ source, base64 }) => {
    const file = { id: "source-file", threadId: "fixture", name: "demo.js", size: atob(base64).length, reference: "demo.js:20", references: ["demo.js:20", "demo.js:120:190", "demo.js#L200-L202", "demo.js:9999", "demo.js"] };
    window.sourceFixture = source;
    fileDownloads.configure({ supported: true });
    fileDownloads.send = message => {
      queueMicrotask(() => fileDownloads.receive({ type: "attachmentChunk", attachmentId: file.id, threadId: "fixture", requestId: message.requestId, offset: 0, total: file.size, nextOffset: null, data: base64 }));
      return true;
    };
    const row = document.createElement("div"), body = document.createElement("div");
    row.id = "source-links"; row.style.position = "relative"; row.style.zIndex = "100"; row.style.background = "white";
    body.className = "body markdown";
    body.innerHTML = window.ChatUI.markdown("[第20行](demo.js:20)\n\n[第120行](demo.js:120:190)\n\n[范围](demo.js#L200-L202)\n\n[越界](demo.js:9999)\n\n[不定位](demo.js)\n\n[demo.js:70](demo.js)\n\n[外部行号](demo.js):90", [file]);
    row.append(body); document.body.append(row); fileDownloads.render(row, { kind: "item:agentMessage", files: [file] });
  }, { source, base64: Buffer.from(source).toString("base64") });
  const open = async (name, line) => {
    await page.getByRole("link", { name, exact: true }).click();
    await page.locator("#textPreviewDialog").waitFor({ state: "visible" });
    if (line) {
      assert.equal(await page.locator(".text-preview-target").getAttribute("data-line"), String(line));
      await page.waitForFunction(() => {
        const content = document.querySelector("#textPreviewContent"), anchor = content.querySelector(".text-preview-anchor");
        if (!anchor) return false;
        const a = anchor.getBoundingClientRect(), c = content.getBoundingClientRect();
        return a.top >= c.top && a.bottom <= c.bottom && a.left >= c.left && a.right <= c.right;
      });
    }
    assert.equal(await page.locator("#textPreviewContent").textContent(), source);
  };
  const close = () => page.locator("#textPreviewClose").click();
  await open("第120行", 120);
  assert(await page.locator("#textPreviewContent").evaluate(el => el.scrollLeft > 0));
  assert.equal(await page.locator("#textPreviewContent script").count(), 0);
  assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
  await page.locator("#textPreviewWrap").check();
  await page.waitForFunction(() => {
    const box = document.querySelector("#textPreviewContent").getBoundingClientRect(), line = document.querySelector(".text-preview-anchor").getBoundingClientRect();
    return line.top >= box.top && line.bottom <= box.bottom;
  });
  await fs.mkdir("dist-check/file-location", { recursive: true });
  await page.screenshot({ path: "dist-check/file-location/390-target-line.png" });
  await close();
  await open("第20行", 20); await close();
  await open("范围", 200);
  assert.equal(await page.locator(".text-preview-target").getAttribute("data-end-line"), "202"); await close();
  await open("demo.js:70", 70); await close();
  await open("外部行号", 90); await close();
  await open("不定位"); assert.equal(await page.locator(".text-preview-target").count(), 0);
  assert.equal(await page.locator("#textPreviewContent").evaluate(el => el.scrollTop), 0); await close();
  await open("越界"); assert.match(await page.locator("#textPreviewNote").textContent(), /超出文件范围/); await close();
  await page.evaluate(() => fileDownloads.showTextPreview({ file: { name: "large.js", size: 2000000 }, bytes: new TextEncoder().encode("first\nsecond"), truncated: true, location: { line: 50000 } }));
  assert.match(await page.locator("#textPreviewNote").textContent(), /不在当前预览范围/);
  assert.equal(await page.locator(".text-preview-target").count(), 0);
  assert.equal(downloads.length, 0); assert.deepEqual(errors, []);
  console.log("PASS: per-link line/column/range navigation, label and trailing line numbers, wrapped text, safe highlighting, unchanged text and out-of-range feedback");
} finally { await browser.close(); }
