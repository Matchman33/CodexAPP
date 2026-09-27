import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const origin = "http://broker.test", root = path.resolve("web");
const browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
try {
  for (const limited of [true, false]) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    let logins = 0, sockets = 0;
    const errors = [];
    await context.addInitScript(() => localStorage.setItem("codexapp.profile", JSON.stringify({ mode: "cloud", email: "fixture@example.com", password: "fixture-password" })));
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/login") {
        logins++;
        return route.fulfill({ status: limited ? 429 : 200, contentType: "application/json", headers: limited ? { "Retry-After": "900" } : {}, body: JSON.stringify(limited ? { error: "尝试过于频繁，请稍后再试" } : { token: "fixture-token" }) });
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
    await page.waitForFunction(() => typeof connectionWanted !== "undefined");
    if (limited) {
      await page.waitForFunction(() => document.getElementById("cMsg").textContent.includes("15"), null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => connectionWanted), false);
      await page.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
      assert.equal(logins, 1, "429 后停止自动重试，页面唤醒不能再次登录");
      assert.equal(sockets, 0);
    } else {
      await page.waitForFunction(() => ws?.readyState === WebSocket.OPEN && connectionTimer === null);
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => resumeConnection());
        await page.waitForFunction(() => ws?.readyState === WebSocket.OPEN && connectionTimer === null);
      }
      assert.equal(sockets, 11);
      assert.equal(logins, 1, "重连应复用令牌，不能反复消耗登录额度");
      await page.evaluate(() => loginFailed("登录失效，请重新登录"));
      await page.locator("#cPass").fill("fixture-password");
      await page.locator("#cLogin").click();
      await page.waitForFunction(() => ws?.readyState === WebSocket.OPEN && connectionTimer === null);
      assert.equal(logins, 2, "失效令牌必须清除，显式登录时重新认证");
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: 429 stops retries and shows wait time; reconnect reuses token; revoked login reauthenticates. Network mocked locally.");
} finally { await browser.close(); }
