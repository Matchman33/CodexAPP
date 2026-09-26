import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { chromium } from "@playwright/test";

const root = path.resolve("web");
const server = http.createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://localhost").pathname, file = path.resolve(root, "." + (name === "/" ? "/index.html" : name));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream");
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [], requests = [];
  page.on("pageerror", e => errors.push(e.message)); page.on("request", r => requests.push(r.url()));
  const url = "http://127.0.0.1:" + server.address().port;
  await page.goto(url); await page.waitForFunction(() => typeof fileDownloads !== "undefined");
  const fixtures = [
    ["demo.js", "// comment\r\nconst name = '中文😀';\r\nfunction add(a) { return a + 42; }\r\n"],
    ["demo.mjs", "export const active = true;"],
    ["demo.ts", "interface User { name: string }\nconst user: User = { name: 'hello' };"],
    ["demo.py", "# comment\ndef greet(name):\n    return 'Hello ' + name"],
    ["demo.c", "#include <stdio.h>\nint main(void) { return 0; }"],
    ["demo.cpp", "template <typename T> class Box { public: T value; };"],
    ["demo.h", "class Box { public: int value = 2; };"],
    ["demo.json", '{"title":"hello", "enabled":true, "value":42}'],
    ["demo.html", '<script>window.syntaxExecuted=true</script><img src="https://example.invalid/a" onerror="window.syntaxExecuted=true">'],
    ["demo.svg", '<svg><path d="M0 0 L10 10" /></svg>'],
    ["demo.css", "/* comment */\nbody { color: #ff0000; display: flex; }"],
    ["demo.md", "# Heading\n**strong** and [link](https://example.invalid)"],
  ];
  const show = async (name, text, location) => {
    await page.evaluate(({ name, text, location }) => {
      const bytes = new TextEncoder().encode(text);
      fileDownloads.showTextPreview({ file: { name, size: bytes.length }, bytes, location });
    }, { name, text, location });
    await page.waitForFunction(() => !document.querySelector("#textPreviewNote").textContent.includes("正在着色"));
    assert.equal(await page.locator("#textPreviewContent").textContent(), text);
  };
  for (const [name, text] of fixtures) {
    await show(name, text, { line: 1 });
    assert(await page.locator('#textPreviewContent [class*="hljs-"]').count() > 0, name + " must have syntax tokens");
    assert.equal(await page.locator("#textPreviewContent script, #textPreviewContent img, #textPreviewContent svg, #textPreviewContent a").count(), 0);
    assert.equal(await page.locator(".text-preview-target").count(), 1);
  }
  assert.equal(await page.evaluate(() => window.syntaxExecuted), undefined);
  for (const name of ["plain.txt", "table.csv"]) {
    await show(name, "const value = 42;");
    assert.equal(await page.locator('#textPreviewContent [class*="hljs-"]').count(), 0);
  }
  await page.locator("#textPreviewLanguage").selectOption("javascript");
  await page.waitForFunction(() => !!document.querySelector("#textPreviewContent .hljs-keyword"));
  await page.locator("#textPreviewLanguage").selectOption("plain");
  assert.equal(await page.locator('#textPreviewContent [class*="hljs-"]').count(), 0);
  const longSource = "const word = 'large';\n".repeat(10000);
  await show("large.js", longSource);
  assert.match(await page.locator("#textPreviewNote").textContent(), /内容较长/);
  assert.equal(await page.locator('#textPreviewContent [class*="hljs-"]').count(), 0);
  const source = Array.from({ length: 120 }, (_, i) => "const value" + i + " = 'row " + i + "'; // comment").join("\r\n");
  await show("position.js", source, { line: 80, column: 10, endLine: 82 });
  assert.equal(await page.locator(".text-preview-target").getAttribute("data-line"), "80");
  assert(await page.locator(".text-preview-target .hljs-string").count() > 0);
  await page.waitForFunction(() => document.querySelector("#textPreviewContent").scrollTop > 0);
  await fs.mkdir("dist-check/preview-syntax", { recursive: true });
  const light = await page.locator("#textPreviewContent .hljs-keyword").first().evaluate(el => getComputedStyle(el).color);
  await page.screenshot({ path: "dist-check/preview-syntax/light.png" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const dark = await page.locator("#textPreviewContent .hljs-keyword").first().evaluate(el => getComputedStyle(el).color);
  assert.notEqual(light, dark); await page.screenshot({ path: "dist-check/preview-syntax/dark.png" });
  await page.evaluate(() => {
    fileDownloads.showTextPreview({ file: { name: "old.js", size: 12 }, bytes: new TextEncoder().encode("const old = 1;") });
    fileDownloads.showTextPreview({ file: { name: "new.txt", size: 9 }, bytes: new TextEncoder().encode("new plain") });
  });
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#textPreviewContent").textContent(), "new plain");
  assert.equal(await page.locator('#textPreviewContent [class*="hljs-"]').count(), 0);
  await context.route("**/preview-highlight-worker.js", route => route.abort());
  await show("offline.js", "const fallback = 1;");
  assert.match(await page.locator("#textPreviewNote").textContent(), /高亮不可用/);
  assert(requests.every(address => address.startsWith(url)), "No source text or assets may be sent to a CDN");
  assert.deepEqual(errors, []);
  console.log("PASS: all advertised formats, source/CRLF preservation, safe markup, line ranges, light/dark themes, manual/plain modes, large-file fallback and stale-worker isolation");
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
