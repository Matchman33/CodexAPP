import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { newKeyPair, seal } from "../cloud/e2e.mjs";

const root = path.resolve("web"), out = path.resolve("dist-check/free-access");
const server = http.createServer(async (req, res) => {
  const file = path.resolve(root, "." + (req.url === "/" ? "/index.html" : req.url === "/admin" ? "/admin.html" : req.url));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await fs.readFile(file);
    const type = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(file)] || "application/json";
    res.writeHead(200, { "content-type": type }); res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  await fs.mkdir(out, { recursive: true });
  browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  let disabled = false, unverified = true, logins = 0, socket;
  await page.route("**/health", route => route.fulfill({ json: { ok: true, rooms: 0 } }));
  await page.route("**/api/login", route => {
    logins++;
    return route.fulfill(disabled ? { status: 403, json: { code: "account_disabled", error: "账号已被管理员停用，请联系管理员" } }
      : unverified ? { status: 403, json: { code: "unverified", error: "请先验证邮箱" } }
      : { json: { token: "free-fixture", accountId: "account" } });
  });
  const keys = newKeyPair();
  await page.routeWebSocket("**/link", route => {
    socket = route;
    route.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type !== "auth") return;
      route.send(JSON.stringify({ type: "authed", peerOnline: true, peerPubkey: keys.publicKey }));
      route.send(JSON.stringify({ type: "e2e", ...seal({ type: "hello", state: { codexConnected: true, status: "idle" }, config: {}, recentEvents: [], pendingApprovals: [] }, message.pubkey, keys.secretKey) }));
    });
  });
  await page.goto(base);
  await page.locator("#tabCloud").click();
  await page.locator("#cEmail").fill("free@example.com");
  await page.locator("#cPass").fill("fixture-password");
  await page.locator("#cLogin").click();
  await page.locator("#cResend").waitFor({ state: "visible" });
  unverified = false; disabled = true;
  await page.locator("#cLogin").click();
  await page.locator("#cMsg").filter({ hasText: "停用" }).waitFor();
  assert.equal(await page.locator("#cResend").isVisible(), false);
  disabled = false;
  await page.locator("#cLogin").click();
  await page.locator("#connDot.on").waitFor({ state: "visible" });
  assert.equal(await page.locator("#membership, #redeemBtn, #memberStatus").count(), 0);
  await page.screenshot({ path: path.join(out, "free-mobile.png"), fullPage: true });
  disabled = true;
  const beforeDisable = logins;
  socket.send(JSON.stringify({ type: "error", code: "account_disabled", message: "账号已被管理员停用，请联系管理员" }));
  await page.locator("#cMsg").filter({ hasText: "停用" }).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(logins, beforeDisable, "停用后不自动反复登录");
  await page.locator("#cLogin").click();
  await page.locator("#cMsg").filter({ hasText: "停用" }).waitFor();
  assert.equal(await page.locator("#cResend").isVisible(), false);
  disabled = false;
  await page.locator("#cLogin").click();
  await page.locator("#connDot.on").waitFor({ state: "visible" });

  const admin = await context.newPage();
  await admin.setViewportSize({ width: 1000, height: 900 });
  admin.on("pageerror", e => errors.push(e.message));
  const mutations = [];
  await admin.route("**/api/admin/**", route => {
    const endpoint = new URL(route.request().url()).pathname;
    assert(!endpoint.includes("codes") && !endpoint.includes("membership"));
    if (endpoint.endsWith("/overview")) return route.fulfill({ json: {
      counts: { total: 1, verified: 1, disabled: disabled ? 1 : 0 }, online: [],
      users: [{ id: "fixture", email: "free@example.com", verified: true, disabled, createdAt: Date.now() }],
    } });
    if (endpoint.endsWith("/user/status")) { const body = route.request().postDataJSON(); disabled = body.disabled; mutations.push(body); }
    return route.fulfill({ json: { ok: true } });
  });
  await admin.addInitScript(() => sessionStorage.setItem("codexapp.admin", "fixture-admin"));
  await admin.goto(base + "/admin");
  admin.on("dialog", dialog => dialog.accept());
  await admin.getByRole("button", { name: "停用账号", exact: true }).click();
  await admin.getByRole("button", { name: "恢复账号", exact: true }).waitFor();
  assert.match(await admin.locator("#users").innerText(), /已停用/);
  await admin.screenshot({ path: path.join(out, "disabled-admin.png"), fullPage: true });
  await admin.getByRole("button", { name: "恢复账号", exact: true }).click();
  await admin.getByRole("button", { name: "停用账号", exact: true }).waitFor();
  assert.deepEqual(mutations, [{ id: "fixture", disabled: true }, { id: "fixture", disabled: false }]);
  assert(!/会员|兑换码|续费/.test(await admin.locator("body").innerText()));
  assert.deepEqual(errors, []);
  console.log("PASS: free cloud login without membership fields; disabled account feedback and no retry loop; admin disable/enable; no billing controls or script errors.");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
