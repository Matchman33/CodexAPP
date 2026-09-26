import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: process.env.CODEXAPP_TEST_BROWSER || "msedge", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const root = path.resolve("web");
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep)) { await route.fulfill({ status: 403, body: "" }); return; }
    try { await route.fulfill({ body: await fs.readFile(file), contentType: ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[path.extname(file)] || "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404, body: "" }); }
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://terminal-fixture.test/");
  await page.waitForFunction(() => typeof webTerminal !== "undefined");
  await page.evaluate(() => {
    window.terminalRequests = [];
    webTerminal.send = m => {
      window.terminalRequests.push(m);
      if (m.type === "terminalOpen") queueMicrotask(() => webTerminal.receive({ type: "terminalAttached", requestId: m.requestId, terminalId: "fixture", lease: "fixture", cols: m.cols, rows: m.rows, seq: 0, data: "", cwd: "/fixture", status: "running", canInput: true }));
      if (m.type === "terminalList") queueMicrotask(() => webTerminal.receive({ type: "terminalList", requestId: m.requestId, terminals: [] }));
      return true;
    };
    webTerminal.configure({ supported: true }); webTerminal.show();
  });
  await page.waitForFunction(() => webTerminal.ready);
  await page.evaluate(() => webTerminal.receive({ type: "terminalOutput", terminalId: "fixture", seq: 1, data: Array.from({ length: 300 }, (_, i) => "OUTPUT-" + String(i).padStart(4, "0") + "\r\n").join("") }));
  await page.waitForFunction(() => webTerminal.term.buffer.active.baseY > 200);
  await page.mouse.move(0, 0); await page.waitForTimeout(1800);
  const scrollbar = page.locator(".xterm .scrollbar.vertical");
  assert.equal(await scrollbar.evaluate(el => Number(getComputedStyle(el).opacity)), 1, "长输出的滚动条必须持续可见");
  const screen = await page.locator(".xterm-screen").boundingBox(), viewport = await page.locator("#terminalViewport").boundingBox();
  assert(screen.y + screen.height <= viewport.y + viewport.height, "最后一行不能超出可视区域");
  const cdp = await context.newCDPSession(page);
  const gesture = async (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 3, radiusY: 3 })) });
  const startY = viewport.y + viewport.height / 2;
  await gesture("touchStart", [[180, startY, 0]]);
  for (let y = 3; y <= 120; y += 3) await gesture("touchMove", [[180, startY + y, 0]]);
  await gesture("touchEnd", []);
  await page.waitForFunction(() => webTerminal.term.buffer.active.viewportY < webTerminal.term.buffer.active.baseY - 3);
  const previousLine = await page.evaluate(() => webTerminal.term.buffer.active.viewportY);
  await page.evaluate(() => webTerminal.receive({ type: "terminalOutput", terminalId: "fixture", seq: 2, data: "LATER-OUTPUT\r\n" }));
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => webTerminal.term.buffer.active.viewportY), previousLine, "新输出不能打断旧记录阅读位置");
  await page.locator("#terminalLatest").click();
  await page.waitForFunction(() => webTerminal.term.buffer.active.viewportY === webTerminal.term.buffer.active.baseY);
  const thumb = await page.locator(".scrollbar.vertical .slider").boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2); await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width / 2, viewport.y + 12, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => webTerminal.term.buffer.active.viewportY < 5);
  await page.locator("#terminalZoomIn").click();
  await page.waitForFunction(() => webTerminal.term.options.fontSize === 14);
  await page.locator("#terminalZoomReset").click();
  await page.waitForFunction(() => webTerminal.term.options.fontSize === 13);
  await gesture("touchStart", [[130, startY, 0], [240, startY, 1]]);
  await gesture("touchMove", [[100, startY, 0], [270, startY, 1]]);
  await gesture("touchEnd", []);
  await page.waitForFunction(() => webTerminal.term.options.fontSize > 13);
  assert.equal(await page.evaluate(() => window.terminalRequests.filter(m => m.type === "terminalInput").length), 0, "拖动和缩放不能向终端发送按键");
  await fs.mkdir("dist-check/terminal-navigation", { recursive: true });
  await page.screenshot({ path: "dist-check/terminal-navigation/390-scrollback.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#terminalZoomReset").click(); await page.waitForTimeout(120);
  await page.locator("#terminalLatest").click();
  const desktop = await page.locator("#terminalViewport").boundingBox();
  await page.mouse.move(desktop.x + 200, desktop.y + 200); await page.mouse.down();
  await page.mouse.move(desktop.x + 200, desktop.y + 340, { steps: 20 }); await page.mouse.up();
  await page.waitForFunction(() => webTerminal.term.buffer.active.viewportY < webTerminal.term.buffer.active.baseY);
  await page.keyboard.down("Control"); await page.mouse.wheel(0, -120); await page.keyboard.up("Control");
  await page.waitForFunction(() => webTerminal.term.options.fontSize === 14);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#terminalWidth").selectOption("240");
    await page.waitForFunction(() => webTerminal.term.cols === 240);
    await page.locator("#terminalHorizontalBar").waitFor({ state: "visible" });
    await page.evaluate(width => webTerminal.receive({ type: "terminalOutput", terminalId: "fixture", seq: webTerminal.seq + 1, data: "\r\n" + " ".repeat(216) + "RIGHT-EDGE-" + width + "\r\n" }), width);
    await page.waitForFunction(width => [...Array(webTerminal.term.buffer.active.length).keys()].some(i => webTerminal.term.buffer.active.getLine(i)?.translateToString(true).includes("RIGHT-EDGE-" + width)), width);
    await page.evaluate(() => webTerminal.latest());
    await page.waitForTimeout(120);
    const horizontal = page.locator("#terminalHorizontalScroll");
    await horizontal.focus(); await page.keyboard.press("Home");
    assert.equal(await page.locator("#terminalViewport").evaluate(el => el.scrollLeft), 0);
    const bar = await horizontal.boundingBox(), thumbWidth = await horizontal.evaluate(el => parseFloat(el.style.getPropertyValue("--thumb-width")));
    await page.mouse.move(bar.x + thumbWidth / 2, bar.y + bar.height / 2); await page.mouse.down();
    await page.mouse.move(bar.x + bar.width - thumbWidth / 2, bar.y + bar.height / 2, { steps: 12 }); await page.mouse.up();
    assert(await page.locator("#terminalViewport").evaluate(el => el.scrollLeft >= el.scrollWidth - el.clientWidth - 2), "拖动横向滚动条必须到达右侧内容");
    if (width === 390) {
      await horizontal.focus(); await page.keyboard.press("Home");
      await gesture("touchStart", [[bar.x + thumbWidth / 2, bar.y + bar.height / 2, 0]]);
      await gesture("touchMove", [[bar.x + bar.width - thumbWidth / 2, bar.y + bar.height / 2, 0]]);
      await gesture("touchEnd", []);
      assert(await page.locator("#terminalViewport").evaluate(el => el.scrollLeft >= el.scrollWidth - el.clientWidth - 2), "手机触摸拖动横向条必须同步内容");
    }
    assert.equal(await page.evaluate(() => window.terminalRequests.filter(m => m.type === "terminalInput").length), 0);
    await page.screenshot({ path: "dist-check/terminal-navigation/" + width + "-horizontal.png" });
  }
  await page.locator("#terminalWidth").selectOption("0"); await page.waitForTimeout(120);
  assert.equal(await page.locator("#terminalHorizontalBar").isVisible(), false, "自适应模式没有溢出时隐藏横向条");
  const resizeCount = await page.evaluate(() => window.terminalRequests.filter(m => m.type === "terminalResize").length);
  await page.evaluate(() => webTerminal.receive({ type: "terminalResized", terminalId: "fixture", cols: 180, rows: 70 }));
  await page.locator("#terminalZoomIn").click(); await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => window.terminalRequests.filter(m => m.type === "terminalResize").length), resizeCount, "只读查看者缩放不应修改其他页面的 PTY 尺寸");
  assert(await page.locator("#terminalViewport").evaluate(el => el.scrollWidth > el.clientWidth));
  await page.mouse.move(desktop.x + 650, desktop.y + 250); await page.mouse.down();
  await page.mouse.move(desktop.x + 450, desktop.y + 250, { steps: 10 }); await page.mouse.up();
  assert(await page.locator("#terminalViewport").evaluate(el => el.scrollLeft > 0), "较宽的只读屏幕应能横向拖动查看");
  await page.locator("#terminalLatest").click();
  await page.waitForTimeout(100);
  await page.waitForFunction(() => webTerminal.term.buffer.active.viewportY === webTerminal.term.buffer.active.baseY);
  assert(await page.locator("#terminalViewport").evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), "只读大屏也能滚动到最后一行");
  assert.equal(await page.locator("#terminalViewport").evaluate(el => el.scrollLeft), 0);
  await page.screenshot({ path: "dist-check/terminal-navigation/1280-scrollback.png" });
  console.log("PASS: visible vertical/horizontal scrollbars, fixed/auto columns, dragging to right edge, touch/mouse panning, zoom, reading position and read-only resize isolation");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
