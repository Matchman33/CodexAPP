import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const origin = "http://broker.test", root = path.resolve("web");
const browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let logins = 0, sockets = 0;
  const errors = [];
  await context.addInitScript(() => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "cloud", email: "fixture@example.com", password: "fixture-password" })));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/api/login") {
      logins++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fixture-token" }) });
    }
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) return route.abort();
    try { await route.fulfill({ contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream", body: await fs.readFile(file) }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.routeWebSocket("**/link", socket => {
    sockets++;
    socket.onMessage(raw => { const m = JSON.parse(raw); if (m.type === "auth") socket.send(JSON.stringify({ type: "authed", peerOnline: false })); });
  });
  await page.goto(origin);
  await page.waitForFunction(() => ws?.readyState === WebSocket.OPEN && connectionTimer === null);
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => resumeConnection());
    await page.waitForFunction(() => ws?.readyState === WebSocket.OPEN && connectionTimer === null);
  }
  assert.equal(sockets, 11);
  assert.equal(logins, 1, "重连应复用有效令牌");
  await page.evaluate(() => loginFailed("登录失效，请重新登录"));
  await page.locator("#cPass").fill("fixture-password");
  await page.locator("#cLogin").click();
  await page.waitForFunction(() => ws?.readyState === WebSocket.OPEN && connectionTimer === null);
  assert.equal(logins, 2, "失效令牌必须清除，显式登录时重新认证");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS: reconnect reuses token; revoked login reauthenticates. Network mocked locally.");
} finally { await browser.close(); }
