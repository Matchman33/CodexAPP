// CodexApp PC agent (cloud mode) — with a built-in local control panel.
//
// Runs on the user's PC next to Codex. Double-click → it opens a local web panel
// (http://127.0.0.1:7878) where you LOGIN / REGISTER and watch status. After
// login it connects OUTBOUND to the cloud broker, authenticates with the account,
// and bridges the broker <-> local `codex app-server`. All phone/web traffic is
// end-to-end encrypted; the broker only relays ciphertext.
//
// SECURITY: a client must complete a PAIRING-CODE handshake (SAS over both public
// keys) before the agent sends any data or runs any command; paired keys are pinned.
//
// Run:  node cloud/agent.mjs        (or the packaged CodexApp-Agent.exe)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { WebSocket } from "ws";
import { CodexBridge } from "../core/codexBridge.mjs";
import { persistModel } from "../core/modelSettings.mjs";
import { createSleepPrevention } from "../core/sleepPrevention.mjs";
import { loadOrCreateKeyPair, seal, open, fingerprint, sas } from "./e2e.mjs";

function appDir() {
  // Per-user, writable, stable config dir — independent of where the binary/script
  // lives (works for the node-pack, source run, SEA exe, and Electron alike).
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "CodexApp");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "CodexApp");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "codexapp");
}
// CODEXAPP_DIR lets a launcher (e.g. the Electron app) put config in a writable
// per-user folder instead of next to the binary.
const BASE = process.env.CODEXAPP_DIR || appDir();
try { fs.mkdirSync(BASE, { recursive: true }); } catch {}
const CONFIG_FILE = path.join(BASE, "agent.config.json");
const KEYS_FILE = path.join(BASE, "agent.keys.json");
const PAIRING_FILE = path.join(BASE, "agent.pairing.json");
const PAIRING_TXT = path.join(BASE, "pairing-code.txt");

// Cloud broker is FIXED for end users (they can only go through the server).
// Dev can override it via the CODEXAPP_BROKER env var. LAN mode is unaffected.
const CLOUD_BROKER = (process.env.CODEXAPP_BROKER || "https://broker.the5288.cn").replace(/\/+$/, "");

const DEFAULTS = {
  email: "", password: "", codexBin: "",
  defaultCwd: os.homedir(), approvalPolicy: "on-request", sandbox: "workspace-write", model: null,
  reasoningEffort: null,
  originator: "codex_vscode", panelPort: 7878,
  preventSleep: true,
  // "open" = 同账号免码直连(像 TeamViewer);"code" = 需要配对码(更安全,防中间人)
  pairingMode: "open",
};

function loadConfig() {
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(CONFIG_FILE)) cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  else fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  cfg.email = process.env.CODEXAPP_EMAIL || cfg.email;
  cfg.password = process.env.CODEXAPP_PASSWORD || cfg.password;
  return cfg;
}
function saveConfig() {
  const out = { ...config }; // persist current settings (incl. login) next to the exe
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
}

function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  const b = crypto.randomBytes(6);
  return Array.from(b).map((x) => A[x % A.length]).join("");
}
function loadPairing() {
  let p = null;
  if (fs.existsSync(PAIRING_FILE)) { try { p = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf8")); } catch {} }
  if (!p) p = { code: genCode() };
  if (!Array.isArray(p.pinnedPhones)) p.pinnedPhones = p.pinnedPhone ? [p.pinnedPhone] : [];
  delete p.pinnedPhone;
  if (!p.code) p.code = genCode();
  fs.writeFileSync(PAIRING_FILE, JSON.stringify(p, null, 2));
  return p;
}
function savePairing() { fs.writeFileSync(PAIRING_FILE, JSON.stringify(pairing, null, 2)); }

const config = loadConfig();
const sleepPrevention = createSleepPrevention(config);
const keys = loadOrCreateKeyPair(KEYS_FILE);
const pairing = loadPairing();
fs.writeFileSync(PAIRING_TXT, pairing.code + "\n");

// ---- live status (read by the control panel) ----
const status = {
  phase: "needLogin", // needLogin|startingCodex|loggingIn|connecting|waitingPeer|pairing|paired|membership|error
  brokerConnected: false,
  codexConnected: false,
  peerOnline: false,
  paired: false,
  pairingCode: pairing.code,
  pairingMode: config.pairingMode,
  fingerprint: fingerprint(keys.publicKey),
  pinnedCount: pairing.pinnedPhones.length,
  email: config.email || "",
  brokerUrl: CLOUD_BROKER,
  error: "",
};
function setStatus(p) { Object.assign(status, p); }

let ws = null;
let phonePubkey = null;
let trusted = false;
let backoff = 1000;
let membershipWait = false; // true after a membership_required rejection (slow retry)
let running = false;        // user has logged in / wants to be connected
let authToken = null;       // cached JWT — reuse across WS reconnects (avoid re-login storms)

const bridge = new CodexBridge(config, (msg) => {
  status.codexConnected = !!bridge.state.codexConnected;
  // CodexApp data only flows to a PAIRED phone.
  if (!trusted || !phonePubkey || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "e2e", ...seal(msg, phonePubkey, keys.secretKey) }));
}, (model, settings) => persistModel(CONFIG_FILE, model, settings));

function sendCtrl(obj) {
  if (!phonePubkey || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "e2e", ...seal(obj, phonePubkey, keys.secretKey) }));
}
function sendSnapshot() { if (trusted) sendCtrl(bridge.snapshot()); }

function onPhoneOnline(pubkey) {
  phonePubkey = pubkey;
  status.peerOnline = true;
  // "open" mode: trust any client on this account (broker already gates by account) — no code.
  if (config.pairingMode === "open" || (pubkey && pairing.pinnedPhones.includes(pubkey))) {
    trusted = true;
    setStatus({ phase: "paired", paired: true });
    console.log("[agent] phone trusted (" + (config.pairingMode === "open" ? "open mode" : "pinned") + ") " + fingerprint(pubkey));
    sendSnapshot();
  } else {
    trusted = false;
    setStatus({ phase: "pairing", paired: false });
    console.log("[agent] phone needs pairing " + fingerprint(pubkey) + "  code=" + pairing.code);
    sendCtrl({ type: "needPairing" });
  }
}

function handlePair(inner) {
  const expected = sas(pairing.code, keys.publicKey, phonePubkey);
  if (inner.tag && inner.tag === expected) {
    if (!pairing.pinnedPhones.includes(phonePubkey)) pairing.pinnedPhones.push(phonePubkey);
    savePairing();
    trusted = true;
    setStatus({ phase: "paired", paired: true, pinnedCount: pairing.pinnedPhones.length });
    console.log("[agent] PAIRED ✓ phone " + fingerprint(phonePubkey));
    sendCtrl({ type: "paired", ok: true });
    sendSnapshot();
  } else {
    console.warn("[agent] pairing REJECTED (code mismatch or MITM)");
    sendCtrl({ type: "paired", ok: false, reason: "配对码不匹配或存在中间人" });
  }
}

async function login() {
  const res = await fetch(CLOUD_BROKER + "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (!res.ok) throw new Error("login failed: " + res.status + " " + (await res.text()));
  return (await res.json()).token;
}

function connect(token) {
  ws = new WebSocket(CLOUD_BROKER.replace(/^http/, "ws") + "/link");
  ws.on("open", () => { backoff = 1000; ws.send(JSON.stringify({ type: "auth", token, role: "agent", pubkey: keys.publicKey })); });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "authed") {
      setStatus({ phase: m.peerOnline ? "connecting" : "waitingPeer", brokerConnected: true, error: "" });
      console.log("[agent] linked. peerOnline=" + m.peerOnline);
      if (m.peerOnline && m.peerPubkey) onPhoneOnline(m.peerPubkey);
      return;
    }
    if (m.type === "peer") {
      if (m.online) onPhoneOnline(m.pubkey);
      else { phonePubkey = null; trusted = false; setStatus({ phase: "waitingPeer", peerOnline: false, paired: false }); console.log("[agent] phone offline"); }
      return;
    }
    if (m.type === "e2e") {
      const inner = open(m, phonePubkey, keys.secretKey);
      if (!inner) { console.error("[agent] decrypt failed"); return; }
      if (!trusted) {
        if (inner.type === "pair") handlePair(inner);
        else sendCtrl({ type: "needPairing" }); // ignore commands until paired
        return;
      }
      bridge.dispatch(inner).catch((e) => sendCtrl({ type: "error", message: e.message, requestId: inner.requestId }));
      return;
    }
    if (m.type === "error") {
      if (m.code === "membership_required") {
        membershipWait = true;
        setStatus({ phase: "membership", error: "云端会员未开通或已过期" });
        console.error("[agent] 云端会员未开通或已过期。请在客户端用兑换码开通后会自动连上;局域网模式不受影响。");
      } else if (/token|invalid|auth/i.test(m.message || "")) {
        authToken = null; // token rejected -> re-login on the next reconnect
        setStatus({ error: "登录已失效，正在重新登录…" });
      } else { setStatus({ error: m.message || "broker error" }); console.error("[agent] broker error:", m.message); }
    }
  });
  ws.on("close", () => {
    phonePubkey = null; trusted = false;
    setStatus({ brokerConnected: false, peerOnline: false, paired: false });
    if (!running) { setStatus({ phase: "needLogin" }); return; }
    if (status.phase !== "membership") setStatus({ phase: "connecting" });
    const delay = membershipWait ? 60000 : backoff;
    membershipWait = false;
    setTimeout(startAgent, delay);
    backoff = Math.min(backoff * 1.6, 15000);
  });
  ws.on("error", () => { try { ws.close(); } catch {} });
}

async function startAgent() {
  if (!config.email || !config.password) { running = false; setStatus({ phase: "needLogin" }); return; }
  running = true;
  try {
    if (!authToken) { setStatus({ phase: "loggingIn", email: config.email, error: "" }); authToken = await login(); } // reuse token across reconnects
    setStatus({ phase: "startingCodex" });
    if (!bridge.state.codexConnected) await bridge.start();
    status.codexConnected = !!bridge.state.codexConnected;
    setStatus({ phase: "connecting" });
    connect(authToken);
  } catch (e) {
    const msg = String(e.message || e);
    console.error("[agent] start failed:", msg);
    // Auth problems won't fix themselves: drop back to the login form with a reason
    // (and don't retry — this is what caused the 401→retry→429 rate-limit loop).
    if (/login failed: 401/.test(msg)) { authToken = null; running = false; setStatus({ phase: "needLogin", error: "邮箱或密码错误，请重新登录" }); return; }
    if (/login failed: 403/.test(msg)) { authToken = null; running = false; setStatus({ phase: "needLogin", error: "邮箱未验证：请先点验证邮件里的链接，再登录" }); return; }
    // On 429 back off long enough for the broker's 15-min rate window to clear
    // (retrying too often just keeps it limited).
    const rate = /login failed: 429/.test(msg);
    setStatus({ phase: "error", error: rate ? "登录过于频繁，5 分钟后自动重试…" : ("连接失败：" + msg) });
    if (running) setTimeout(startAgent, rate ? 300000 : 3000);
  }
}

// ---- local control panel (login / register / status), 127.0.0.1 only ----
function readJson(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 8192) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

// Open the panel as a chromeless app window (Edge/Chrome --app). Falls back to the
// default browser if no Chromium browser is found.
function openAppWindow(url) {
  const size = "--window-size=460,780";
  try {
    if (process.platform === "win32") {
      const pf = process.env.ProgramFiles || "C:\\Program Files";
      const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const lad = process.env.LOCALAPPDATA || "";
      const candidates = [
        pf + "\\Microsoft\\Edge\\Application\\msedge.exe",
        pf86 + "\\Microsoft\\Edge\\Application\\msedge.exe",
        pf + "\\Google\\Chrome\\Application\\chrome.exe",
        pf86 + "\\Google\\Chrome\\Application\\chrome.exe",
        lad + "\\Google\\Chrome\\Application\\chrome.exe",
      ];
      const exe = candidates.find((p) => { try { return p && fs.existsSync(p); } catch { return false; } });
      if (exe) { exec(`"${exe}" --app="${url}" ${size}`); return; }
      exec(`start "" "${url}"`); // fallback: default browser tab
    } else if (process.platform === "darwin") {
      // Try Chrome/Edge app mode, else default browser.
      exec(`open -na "Google Chrome" --args --app="${url}" ${size} || open -na "Microsoft Edge" --args --app="${url}" ${size} || open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  } catch {}
}

function startPanel(port, tries = 0) {
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PANEL_HTML);
      }
      if (req.method === "GET" && req.url === "/api/status") return send(200, { ...status, sleepPrevention: sleepPrevention.status() });

      if (req.method === "POST" && req.url === "/api/register") {
        const b = await readJson(req);
        const url = CLOUD_BROKER;
        try {
          const r = await fetch(url + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: b.email, password: b.password }) });
          const j = await r.json().catch(() => ({}));
          return send(r.status, j);
        } catch (e) { return send(502, { error: "连不上 Broker：" + e.message }); }
      }
      if (req.method === "POST" && req.url === "/api/login") {
        const b = await readJson(req);
        config.email = (b.email || "").trim();
        config.password = b.password || "";
        authToken = null; // new credentials -> fresh login
        saveConfig();
        setStatus({ email: config.email, error: "" });
        running = true;
        if (ws && ws.readyState === WebSocket.OPEN) { try { ws.close(); } catch {} } // reconnect with new creds
        else startAgent();
        return send(200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/api/logout") {
        running = false; authToken = null; config.email = ""; config.password = ""; saveConfig();
        try { ws && ws.close(); } catch {}
        setStatus({ phase: "needLogin", brokerConnected: false, peerOnline: false, paired: false, email: "" });
        return send(200, { ok: true });
      }
      // Set a custom (memorable) pairing code, so you always know it even from afar.
      if (req.method === "POST" && req.url === "/api/paircode") {
        const b = await readJson(req);
        const code = String(b.code || "").trim().toUpperCase();
        if (code.length < 4 || code.length > 32 || !/^[A-Z0-9]+$/.test(code)) return send(400, { error: "配对码需 4-32 位字母或数字" });
        pairing.code = code; savePairing(); status.pairingCode = code;
        try { fs.writeFileSync(PAIRING_TXT, code + "\n"); } catch {}
        return send(200, { ok: true });
      }
      // Switch connection mode: "open" (same-account, no code) vs "code" (require pairing code).
      if (req.method === "POST" && req.url === "/api/pairmode") {
        const b = await readJson(req);
        const mode = b.mode === "code" ? "code" : "open";
        config.pairingMode = mode; saveConfig(); status.pairingMode = mode;
        return send(200, { ok: true, mode });
      }
      res.writeHead(404); res.end("not found");
    } catch (e) { send(500, { error: String(e.message || e) }); }
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && tries < 5) return startPanel(port + 1, tries + 1);
    console.error("[panel] cannot start:", e.message);
  });
  server.listen(port, "127.0.0.1", () => {
    void sleepPrevention.start();
    const url = "http://127.0.0.1:" + port;
    try { fs.writeFileSync(path.join(BASE, "panel.url"), url); } catch {} // so a launcher (Electron) knows the URL
    console.log("[panel] 控制面板: " + url);
    console.log("[agent] device fingerprint:", status.fingerprint, " PAIRING CODE:", pairing.code);
    // Open the panel as a standalone APP WINDOW (chromeless: no address bar/tabs),
    // so it looks like a desktop client, not a web page. The installer's autostart
    // launcher sets CODEXAPP_NO_OPEN=1 so the background agent stays silent.
    if (!process.env.CODEXAPP_NO_OPEN) openAppWindow(url);
  });
}

const PANEL_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CodexApp 电脑客户端</title>
<style>
:root{--bg:#0b1220;--card:#15203a;--bg2:#0f1830;--line:#243154;--text:#e6ecf7;--muted:#8a98b8;--accent:#35d07f;--accent2:#4aa8ff;--danger:#ff5c6c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;width:100%;max-width:420px}
h1{font-size:22px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin:0 0 16px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 5px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:var(--bg2);color:var(--text);font-size:15px}
.btn{width:100%;border:0;border-radius:10px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;margin-top:14px}
.primary{background:var(--accent);color:#042}.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:600}
.tabs{display:flex;background:var(--bg2);border-radius:10px;padding:4px;margin-bottom:6px}
.tab{flex:1;text-align:center;padding:9px;border-radius:8px;color:var(--muted);font-size:13px;font-weight:600;cursor:pointer}
.tab.on{background:var(--card);color:var(--text)}
.msg{color:var(--muted);font-size:13px;margin-top:12px;min-height:18px}
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}.k{color:var(--muted);font-size:13px}.v{font-size:13px;font-weight:600}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--danger);margin-right:6px}.dot.on{background:var(--accent)}
.code{font-size:30px;font-weight:800;letter-spacing:5px;color:var(--accent);text-align:center;margin:6px 0 2px}
.pill{display:inline-block;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:700}
.hidden{display:none}
.hint{color:var(--muted);font-size:12px;margin-top:10px;line-height:1.5}
</style></head><body>
<div class="card">
  <h1>CodexApp 电脑客户端</h1>
  <p class="sub">登录后自动连接，手机/网页即可远程控制本机 Codex</p>

  <div id="auth">
    <div class="tabs"><div id="tabLogin" class="tab on">登录</div><div id="tabReg" class="tab">注册</div></div>
    <p class="hint" style="margin:0 0 10px">服务器：<a href="${CLOUD_BROKER}" target="_blank" rel="noopener" style="color:var(--accent2)">${CLOUD_BROKER}</a></p>
    <label>邮箱</label><input id="email" placeholder="you@example.com" autocapitalize="off">
    <label>密码</label><input id="pass" type="password" placeholder="至少 8 位">
    <button id="loginBtn" class="btn primary">登录并启动</button>
    <button id="regBtn" class="btn ghost hidden">注册账号</button>
    <p id="msg" class="msg"></p>
  </div>

  <div id="panel" class="hidden">
    <div id="pill" class="pill" style="background:var(--bg2);color:var(--muted)">…</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg2)">
      <div><div style="font-weight:600;font-size:13px">连接方式</div><div class="k" id="modeDesc">…</div></div>
      <button id="modeBtn" type="button" style="padding:8px 12px;font-size:12px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:8px;cursor:pointer;white-space:nowrap">切换</button>
    </div>
    <div id="pairBox" class="hidden" style="margin-top:14px">
      <div class="k">在手机/网页客户端首次连接时输入配对码：</div>
      <div style="display:flex;align-items:center;justify-content:center;gap:10px">
        <div id="code" class="code">------</div>
        <button id="copyCode" type="button" style="padding:8px 14px;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer">复制</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:center">
        <input id="newCode" placeholder="设自定义配对码(4-32位)" maxlength="32" style="flex:1;max-width:210px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg2);color:var(--text);font-size:13px">
        <button id="setCode" type="button" style="padding:8px 14px;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--bg2);color:var(--text);border-radius:8px;cursor:pointer">设置</button>
      </div>
      <div id="codeMsg" class="k" style="text-align:center;margin-top:6px"></div>
    </div>
    <div style="margin-top:14px">
      <div class="row"><span class="k"><span id="d_broker" class="dot"></span>Broker 连接</span><span id="v_broker" class="v">—</span></div>
      <div class="row"><span class="k"><span id="d_codex" class="dot"></span>本地 Codex</span><span id="v_codex" class="v">—</span></div>
      <div class="row"><span class="k"><span id="d_peer" class="dot"></span>客户端在线</span><span id="v_peer" class="v">—</span></div>
      <div class="row"><span class="k">账号</span><span id="v_email" class="v">—</span></div>
      <div class="row"><span class="k">本机指纹</span><span id="v_fp" class="v">—</span></div>
      <div class="row"><span class="k">已配对设备</span><span id="v_pin" class="v">—</span></div>
    </div>
    <p id="perr" class="msg"></p>
    <button id="logoutBtn" class="btn ghost" style="border-color:var(--danger);color:var(--danger)">退出账号</button>
    <p class="hint">网页客户端：在浏览器打开 <a href="${CLOUD_BROKER}" target="_blank" rel="noopener" style="color:var(--accent2)">${CLOUD_BROKER}</a> ，用同一账号登录后即可连接。</p>
  </div>
  <p class="hint" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px;line-height:1.6">🔒 安全说明：全程端到端加密。服务器只转发加密数据，看不到你的账号内容、Codex 对话、代码与命令。</p>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var mode="login";
var curMode="open";
function setMode(m){mode=m;$("tabLogin").className="tab"+(m==="login"?" on":"");$("tabReg").className="tab"+(m==="reg"?" on":"");
  $("loginBtn").className="btn primary"+(m==="login"?"":" hidden");$("regBtn").className="btn ghost"+(m==="reg"?"":" hidden");$("msg").textContent="";}
$("tabLogin").onclick=function(){setMode("login")};$("tabReg").onclick=function(){setMode("reg")};
function body(){return{email:$("email").value.trim(),password:$("pass").value}}
$("loginBtn").onclick=function(){
  var b=body();if(!b.email||!b.password){$("msg").textContent="请填写邮箱和密码";return;}
  $("msg").textContent="登录中…";
  fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)})
   .then(function(r){return r.json()}).then(function(){poll()}).catch(function(e){$("msg").textContent="出错："+e.message});
};
$("regBtn").onclick=function(){
  var b=body();if(!b.email||!b.password){$("msg").textContent="请填写邮箱和密码";return;}
  $("msg").textContent="注册中…";
  fetch("/api/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)})
   .then(function(r){return r.json().then(function(j){return{s:r.status,j:j}})})
   .then(function(o){
     if(o.s===409){$("msg").textContent="账号已存在，请直接登录。";return;}
     if(o.s>=400){$("msg").textContent="注册失败："+(o.j.error||o.s);return;}
     $("msg").textContent=o.j.emailSent?"✅ 验证邮件已发送，请查收并点链接验证，然后登录。":"账号已创建。未配 SMTP：验证链接在 Broker 日志里。验证后登录。";
   }).catch(function(e){$("msg").textContent="出错："+e.message});
};
$("logoutBtn").onclick=function(){
  if(!confirm("确定退出账号吗？将清除本机保存的登录，并断开连接，需要重新登录。"))return;
  fetch("/api/logout",{method:"POST"}).then(function(){location.reload()});
};
$("copyCode").onclick=function(){
  var c=$("code").textContent.trim(); if(!c||c==="------")return;
  var done=function(){var b=$("copyCode");b.textContent="已复制";setTimeout(function(){b.textContent="复制";},1200);};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(c).then(done).catch(fallback);}else{fallback();}
  function fallback(){try{var r=document.createRange();r.selectNode($("code"));var s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand("copy");s.removeAllRanges();done();}catch(e){}}
};
$("modeBtn").onclick=function(){
  var next=(curMode==="code")?"open":"code";
  fetch("/api/pairmode",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode:next})})
   .then(function(r){return r.json()}).then(function(){poll();}).catch(function(){});
};
$("setCode").onclick=function(){
  var v=$("newCode").value.trim().toUpperCase();
  if(v.length<4){$("codeMsg").textContent="配对码至少 4 位";return;}
  $("codeMsg").textContent="设置中…";
  fetch("/api/paircode",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:v})})
   .then(function(r){return r.json()}).then(function(j){
     if(j&&j.ok){$("codeMsg").textContent="✅ 已设为自定义配对码";$("newCode").value="";}
     else $("codeMsg").textContent="失败："+((j&&j.error)||"");
   }).catch(function(e){$("codeMsg").textContent="出错："+e.message});
};

var LABEL={needLogin:"未登录",startingCodex:"正在启动本地 Codex…",loggingIn:"正在登录…",connecting:"连接中…",waitingPeer:"已连接，等待客户端…",pairing:"等待配对（请输入配对码）",paired:"已连接 ✓ 可远程控制",membership:"云端会员未开通/已过期",error:"出错"};
var COLOR={paired:"var(--accent)",waitingPeer:"var(--accent2)",pairing:"var(--accent2)",membership:"var(--danger)",error:"var(--danger)"};
function render(s){
  if(s.phase==="needLogin"){$("auth").className="";$("panel").className="hidden";
    if(s.email&&!$("email").value)$("email").value=s.email;
    if(s.error)$("msg").textContent="⚠ "+s.error;
    return;}
  $("auth").className="hidden";$("panel").className="";
  var pill=$("pill");pill.textContent=LABEL[s.phase]||s.phase;pill.style.color="#042";pill.style.background=COLOR[s.phase]||"var(--muted)";
  curMode=s.pairingMode||"open";
  var codeMode=(curMode==="code");
  $("modeDesc").textContent=codeMode?"新设备首次需输入配对码(更安全)":"同账号登录即可连接，免配对码";
  $("modeBtn").textContent=codeMode?"改为免码直连":"改为配对码";
  var showPair=codeMode&&(s.phase==="pairing"||s.phase==="waitingPeer"||s.phase==="paired");
  $("pairBox").className=showPair?"":"hidden";$("code").textContent=s.pairingCode||"------";
  $("d_broker").className="dot"+(s.brokerConnected?" on":"");$("v_broker").textContent=s.brokerConnected?"已连接":"未连接";
  $("d_codex").className="dot"+(s.codexConnected?" on":"");$("v_codex").textContent=s.codexConnected?"已就绪":"未就绪";
  $("d_peer").className="dot"+(s.peerOnline?" on":"");$("v_peer").textContent=s.peerOnline?(s.paired?"已配对":"待配对"):"离线";
  $("v_email").textContent=s.email||"—";$("v_fp").textContent=s.fingerprint||"—";$("v_pin").textContent=(s.pinnedCount||0)+" 台";
  $("perr").textContent=s.error?("⚠ "+s.error):"";
}
function poll(){fetch("/api/status").then(function(r){return r.json()}).then(render).catch(function(){});}
poll();setInterval(poll,1500);
</script></body></html>`;

// ---- boot ----
startPanel(config.panelPort);
if (config.email && config.password) startAgent();
else setStatus({ phase: "needLogin" });
