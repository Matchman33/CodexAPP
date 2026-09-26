import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const origin = "http://39.102.80.25:7002", root = path.resolve("web");
const browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  // Every request is fulfilled locally: no request is sent to the example public server.
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (url.pathname === "/demo") { await route.fulfill({ contentType: "text/html", body: "<h1>fixture web destination</h1>" }); return; }
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { await route.fulfill({ status: 403, body: "" }); return; }
    try { await route.fulfill({ contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream", body: await fs.readFile(file) }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  });
  const page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => window.ChatUI && typeof fileDownloads !== "undefined");
  const result = await page.evaluate(() => {
    document.querySelector("#setup").classList.add("hidden");
    document.querySelector("#app").classList.add("hidden");
    const row = document.createElement("div"); row.id = "link-fixture";
    const body = document.createElement("div"); body.className = "body markdown";
    body.innerHTML = window.ChatUI.markdown("[访问网页](39.102.80.25:7002/demo)\n\n[原始网页](http://39.102.80.25:7002/demo)\n\n[无法访问的文件](missing.md)");
    for (const link of body.querySelectorAll("a")) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
    row.append(body); document.body.append(row);
    fileDownloads.configure({ supported: true }); fileDownloads.render(row, { kind: "item:agentMessage", files: [] });
    return [...body.querySelectorAll("a")].map(a => ({ text: a.textContent, href: a.getAttribute("href"), resolved: a.href }));
  });
  assert.equal(result[0].href, origin + "/demo", "IP:port links must remain web addresses");
  assert.equal(result[1].href, origin + "/demo");
  assert.equal(result[2].href, null, "unavailable files must not become broken public hash URLs");
  await page.locator("#link-fixture a").nth(2).click();
  assert.equal(page.url(), origin + "/");
  assert.match(await page.locator("#link-fixture .file-message").textContent(), /未开放下载/);
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "访问网页", exact: true }).click();
  const destination = await opened; await destination.waitForLoadState();
  assert.equal(destination.url(), origin + "/demo");
  assert.equal(await destination.locator("h1").textContent(), "fixture web destination");
  await destination.close();
  const extra = await page.evaluate(() => {
    const row = document.querySelector("#link-fixture"), body = row.querySelector(".body");
    const file = { id: "registered", threadId: "one", name: "demo.js", size: 12, reference: "demo.js:12" };
    body.innerHTML = window.ChatUI.markdown("[有行号的源码](demo.js:12)\n\n[旧占位链接](http://39.102.80.25:7002/#codex-file-unavailable)\n\n[脚本](javascript:alert(1))", [file]);
    fileDownloads.render(row, { kind: "item:agentMessage", files: [file] });
    window.linkDownloadCalls = [];
    fileDownloads.start = (file, preview) => window.linkDownloadCalls.push({ id: file.id, preview });
    return [...body.querySelectorAll("a")].map(a => a.getAttribute("href"));
  });
  assert.equal(extra[1], null); assert.equal(extra[2], null);
  await page.getByRole("link", { name: "有行号的源码", exact: true }).click();
  assert.equal((await page.evaluate(() => window.linkDownloadCalls))[0].id, "registered");
  await page.getByRole("button", { name: "旧占位链接", exact: true }).focus(); await page.keyboard.press("Enter");
  assert.equal(page.url(), origin + "/");
  console.log("PASS: IP and port web links, unavailable file feedback, no placeholder navigation; network requests mocked locally");
} finally { await browser.close(); }
