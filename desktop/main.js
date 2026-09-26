// CodexApp native desktop client (Electron).
// Runs the agent (panel server + broker connection + Codex bridge) inside the
// Electron main process, and shows its UI in a native window — no browser.
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

let win;

function readPanelUrl() {
  try { return fs.readFileSync(path.join(process.env.CODEXAPP_DIR, "panel.url"), "utf8").trim(); } catch { return ""; }
}

// Wait for the embedded agent's local panel to come up, then load it.
function waitAndLoad(tries = 0) {
  const url = readPanelUrl();
  if (url) {
    http.get(url, (res) => { res.destroy(); if (win && !win.isDestroyed()) win.loadURL(url); })
      .on("error", () => { if (tries < 80) setTimeout(() => waitAndLoad(tries + 1), 250); });
    return;
  }
  if (tries < 80) setTimeout(() => waitAndLoad(tries + 1), 250);
}

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 800, minWidth: 380, minHeight: 560,
    title: "CodexApp 电脑客户端",
    autoHideMenuBar: true,
    backgroundColor: "#0b1220",
    webPreferences: { contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  // External links (e.g. the broker/web client) open in the system DEFAULT browser,
  // never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  waitAndLoad();
}

const single = app.requestSingleInstanceLock();
if (!single) { app.quit(); }
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    process.env.CODEXAPP_NO_OPEN = "1";                 // don't spawn an external browser window
    process.env.CODEXAPP_DIR = app.getPath("userData"); // config + panel.url live here
    globalThis.codexappRestart = () => { app.relaunch(); app.exit(0); };
    require(path.join(__dirname, "agent.cjs"));          // start the embedded agent
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on("window-all-closed", () => app.quit());
}
