// CodexApp web client. Two modes (the rest of the UI consumes the same protocol):
//   - cloud: email account -> broker (same origin) -> E2E + pairing -> PC agent
//   - lan:   direct WebSocket to a relay (url + token)
"use strict";

const $ = (id) => document.getElementById(id);
const LS = { profile: "codexapp.profile", keys: "codexapp.keys" };

let ws = null;
let backoff = 1000;
let liveAssistant = null;   // the streaming assistant bubble (or null)
const eventRows = new Map();
let appState = {};
let modelCatalog = [];
let defaultModel = null;
let modelsTimer = null;
let configTimer = null;
let pendingConfig = null;
let writerConflict = null;
let writerChoice = null;
let writerPending = null;
let writerTimer = null;
let lastDiff = "";          // latest unified diff for the current turn
let profile = loadProfile();
let keys = loadKeys();      // E2E keypair (cloud mode)
let agentPub = null;        // peer (agent) public key (cloud mode)
let paired = false;
let authToken = null;       // JWT from /api/login (used for /api/redeem)
let memberUntil = 0;        // cloud membership expiry (ms epoch; >=LIFETIME = 永久)
let membershipBlocked = false;
const LIFETIME_TS = 4102444800000;

// ---------------------------------------------------------------------------
// Profile + keys
// ---------------------------------------------------------------------------
function loadProfile() {
  try { return JSON.parse(localStorage.getItem(LS.profile)) || {}; } catch { return {}; }
}
function saveProfile(p) { profile = p; localStorage.setItem(LS.profile, JSON.stringify(p)); }
function loadKeys() {
  try { const k = JSON.parse(localStorage.getItem(LS.keys)); if (k && k.publicKey) return k; } catch {}
  const k = window.E2E.newKeyPair();
  localStorage.setItem(LS.keys, JSON.stringify(k));
  return k;
}
function profileReady(p) {
  if (!p) return false;
  if (p.mode === "lan") return !!(p.url && p.token);
  if (p.mode === "cloud") return !!(p.email && p.password);
  return false;
}

// ---------------------------------------------------------------------------
// Boot: setup gate vs app
// ---------------------------------------------------------------------------
function start() {
  if (profileReady(profile)) { showApp(); connect(); }
  else { showSetup(); }
}
function showSetup() {
  hideAllScreens();
  $("setup").classList.remove("hidden");
  if (profile.email) $("cEmail").value = profile.email;
  if (profile.url) $("setupUrl").value = profile.url;
}
function hideAllScreens() {
  ["setup", "register", "pairing", "membership", "app"].forEach((id) => $(id).classList.add("hidden"));
}
function showApp() {
  hideAllScreens();
  $("app").classList.remove("hidden");
  $("redeemBtn").classList.toggle("hidden", profile.mode !== "cloud");
  updateMemberStatus();
}
function showRegister() {
  hideAllScreens();
  $("register").classList.remove("hidden");
  $("rMsg").textContent = "";
  if (profile.email) $("rEmail").value = profile.email;
}
function showPairing() {
  hideAllScreens();
  $("pairing").classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Membership (cloud only; LAN is free)
// ---------------------------------------------------------------------------
function fmtMember(until) {
  if (!until) return "未开通";
  if (until >= LIFETIME_TS) return "永久会员";
  if (until < Date.now()) return "已过期（" + new Date(until).toLocaleDateString() + "）";
  return "有效期至 " + new Date(until).toLocaleDateString();
}
function updateMemberStatus() {
  const el = $("memberStatus");
  if (el) el.textContent = profile.mode === "cloud" ? "会员：" + fmtMember(memberUntil) : "局域网模式（免费）";
}
function showMembership(msg) {
  hideAllScreens();
  $("membership").classList.remove("hidden");
  $("mStatus").textContent = "当前：" + fmtMember(memberUntil);
  $("mMsg").textContent = msg || "";
}
function hideMembership() { $("membership").classList.add("hidden"); }

$("mRedeem").onclick = async () => {
  const code = $("mCode").value.trim().toUpperCase();
  if (!code) { $("mMsg").textContent = "请输入兑换码"; return; }
  if (!authToken) { $("mMsg").textContent = "请先登录后再兑换"; return; }
  $("mMsg").textContent = "兑换中…";
  try {
    const r = await fetch("/api/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: authToken, code }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $("mMsg").textContent = "兑换失败：" + (j.error || r.status); return; }
    memberUntil = j.membershipUntil || 0;
    updateMemberStatus();
    $("mCode").value = "";
    hideMembership();
    if (membershipBlocked) { membershipBlocked = false; showApp(); connect(); }
    else { showApp(); }
  } catch (e) { $("mMsg").textContent = "网络错误：" + e.message; }
};
$("mLan").onclick = () => { hideMembership(); showSetup(); switchTab("lan"); };
$("mClose").onclick = () => { hideMembership(); if (membershipBlocked) showSetup(); else showApp(); };
$("redeemBtn").onclick = () => { $("sheet").classList.add("hidden"); showMembership(); };
function loginFailed(msg, resend) {
  showSetup();
  switchTab("cloud");
  $("cMsg").textContent = msg;
  if (resend) $("cResend").classList.remove("hidden");
}

function switchTab(m) {
  $("tabCloud").classList.toggle("on", m === "cloud");
  $("tabLan").classList.toggle("on", m === "lan");
  $("cloudForm").classList.toggle("hidden", m !== "cloud");
  $("lanForm").classList.toggle("hidden", m !== "lan");
}
$("tabCloud").onclick = () => switchTab("cloud");
$("tabLan").onclick = () => switchTab("lan");

function doCloud() {
  const email = $("cEmail").value.trim();
  const password = $("cPass").value;
  if (!email || !password) { $("cMsg").textContent = "请填邮箱和密码"; return; }
  saveProfile({ mode: "cloud", email, password });
  showApp(); connect(); // pairing (if needed) is a step AFTER login, driven by the WS
}
$("cLogin").onclick = () => doCloud();
$("cRegister").onclick = () => showRegister();
$("cResend").onclick = async () => {
  const email = $("cEmail").value.trim();
  if (!email) { $("cMsg").textContent = "请填邮箱"; return; }
  try { await fetch("/api/resend-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); } catch {}
  $("cMsg").textContent = "若该邮箱已注册，验证邮件已重新发送，请查收。";
};
$("cForgot").onclick = async () => {
  const email = $("cEmail").value.trim();
  if (!email) { $("cMsg").textContent = "请先填上面的邮箱，再点忘记密码。"; return; }
  try { await fetch("/api/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); } catch {}
  $("cMsg").textContent = "若该邮箱已注册，重置链接已发送，请查收邮件并按提示设置新密码。";
};

// ---- Register screen ----
$("rBack").onclick = () => showSetup();
$("rSubmit").onclick = async () => {
  const email = $("rEmail").value.trim(), p1 = $("rPass").value, p2 = $("rPass2").value;
  if (!email || !p1) { $("rMsg").textContent = "请填邮箱和密码"; return; }
  if (p1.length < 8) { $("rMsg").textContent = "密码至少 8 位"; return; }
  if (p1 !== p2) { $("rMsg").textContent = "两次密码不一致"; return; }
  $("rMsg").textContent = "注册中…";
  try {
    const r = await fetch("/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: p1 }) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) { $("rMsg").textContent = "账号已存在，请返回登录。"; return; }
    if (!r.ok) { $("rMsg").textContent = "注册失败：" + (j.error || r.status); return; }
    $("rMsg").textContent = j.emailSent
      ? "✅ 验证邮件已发送，请查收点链接验证，然后返回登录。"
      : "账号已创建。未配 SMTP：验证链接在服务器日志里，打开后再登录。";
    $("rResend").classList.remove("hidden");
  } catch (e) { $("rMsg").textContent = "网络错误：" + e.message; }
};
$("rResend").onclick = async () => {
  const email = $("rEmail").value.trim();
  if (!email) { $("rMsg").textContent = "请填邮箱"; return; }
  try { await fetch("/api/resend-verification", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); } catch {}
  $("rMsg").textContent = "若该邮箱已注册，验证邮件已重新发送。";
};

// ---- Pairing screen ----
$("pSubmit").onclick = () => {
  const code = $("pCode").value.trim().toUpperCase();
  if (!code) { $("pMsg").textContent = "请输入配对码"; return; }
  if (!ws || ws.readyState !== WebSocket.OPEN || !agentPub) { $("pMsg").textContent = "电脑端还没上线，请先在电脑端登录"; return; }
  $("pMsg").textContent = "配对中…";
  ws.send(JSON.stringify({ type: "e2e", ...window.E2E.seal({ type: "pair", tag: window.E2E.sas(code, agentPub, keys.publicKey) }, agentPub, keys.secretKey) }));
};
$("pLogout").onclick = () => forget();

$("setupSave").onclick = () => {
  const url = $("setupUrl").value.trim().replace(/\/+$/, "");
  const token = $("setupToken").value.trim();
  if (!url || !token) return;
  saveProfile({ mode: "lan", url, token });
  showApp(); connect();
};

// ---------------------------------------------------------------------------
// Connection (dual transport)
// ---------------------------------------------------------------------------
function connect() {
  setConn(false, "连接中…");
  if (profile.mode === "cloud") connectCloud();
  else connectLan();
}

function connectLan() {
  try {
    ws = new WebSocket(profile.url.replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(profile.token));
  } catch { scheduleReconnect(); return; }
  ws.onopen = () => { backoff = 1000; };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  ws.onclose = (ev) => { setConn(false, ev.code === 4001 ? "Token 无效" : "已断开"); if (ev.code === 4001) { forget(); return; } scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

async function connectCloud() {
  agentPub = null; paired = false;
  let token;
  try {
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: profile.email, password: profile.password }) });
    if (r.status === 401) { loginFailed("账号或密码错误"); return; }
    if (r.status === 403) { loginFailed("请先验证邮箱（注册后点邮件里的链接）", true); return; }
    if (!r.ok) { scheduleReconnect(); return; }
    const data = await r.json();
    token = data.token; authToken = token; memberUntil = data.membershipUntil || 0;
    updateMemberStatus();
  } catch { scheduleReconnect(); return; }

  // Not a member → show the upgrade screen instead of (uselessly) hitting the gate.
  if (memberUntil <= Date.now()) { membershipBlocked = true; showMembership("云端会员未开通或已过期，输入兑换码即可开通。"); return; }

  try { ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/link"); }
  catch { scheduleReconnect(); return; }
  ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify({ type: "auth", token, role: "phone", pubkey: keys.publicKey })); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "authed") { setConn(false, "等待电脑 Agent…"); if (m.peerOnline && m.peerPubkey) agentPub = m.peerPubkey; return; }
    if (m.type === "peer") {
      agentPub = m.online ? m.pubkey : null;
      if (!m.online) {
        paired = false; appState.codexConnected = false; applyState();
        if (!$("pairing").classList.contains("hidden")) $("pStatus").textContent = "电脑端已离线，等待上线…";
      }
      return;
    }
    if (m.type === "e2e") {
      const inner = window.E2E.open(m, agentPub, keys.secretKey);
      if (!inner) return;
      if (inner.type === "needPairing") {
        // Agent online but this device isn't paired yet -> ask for the code (a step AFTER login).
        showPairing();
        $("pStatus").textContent = agentPub ? "✅ 电脑端在线，请输入配对码" : "等待电脑端上线…";
        return;
      }
      if (inner.type === "paired") {
        if (inner.ok) { paired = true; showApp(); }      // bound -> straight to app
        else { $("pMsg").textContent = "配对失败：" + (inner.reason || "配对码不对，请重试"); }
        return;
      }
      if (inner.type === "hello") { paired = true; if ($("app").classList.contains("hidden")) showApp(); } // already-paired device auto-connects
      handle(inner);
      return;
    }
    if (m.type === "error") {
      if (m.code === "membership_required") { membershipBlocked = true; try { ws.close(); } catch {} showMembership("云端会员未开通或已过期，输入兑换码即可开通。"); return; }
      if (/token|invalid/i.test(m.message || "")) setConn(false, "登录失效");
      return;
    }
  };
  ws.onclose = () => { setConn(false, "已断开"); if (!membershipBlocked) scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 1.6, 15000);
}

function sendWs(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (profile.mode === "cloud") {
    if (!agentPub || !paired) return false;
    ws.send(JSON.stringify({ type: "e2e", ...window.E2E.seal(obj, agentPub, keys.secretKey) }));
  } else {
    ws.send(JSON.stringify(obj));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inbound message handling
// ---------------------------------------------------------------------------
function handle(m) {
  switch (m.type) {
    case "hello":
      clearTimeout(writerTimer);
      writerPending = null; writerConflict = null;
      $("writerSheet").classList.add("hidden");
      appState = m.state || {};
      applyState();
      $("feed").innerHTML = "";
      eventRows.clear();
      liveAssistant = null;
      (m.recentEvents || []).forEach(renderEvent);
      $("approvals").innerHTML = "";
      (m.pendingApprovals || []).forEach(renderApproval);
      if (m.config) {
        $("cfgCwd").value = m.config.cwd || "";
        $("cfgApproval").value = m.config.approvalPolicy || "on-request";
        $("cfgSandbox").value = m.config.sandbox || "workspace-write";
      }
      setDiff(m.diff || "");
      scrollFeed();
      break;
    case "state":
      appState = m.state || appState;
      applyState();
      break;
    case "models":
      clearTimeout(modelsTimer);
      modelCatalog = m.models || [];
      defaultModel = m.defaultModel || null;
      renderModelOptions();
      $("modelsStatus").textContent = m.error ? "模型列表加载不完整：" + m.error : (modelCatalog.length ? "" : "暂无可选模型");
      $("modelsRefresh").disabled = false;
      break;
    case "configSaved":
      if (pendingConfig && pendingConfig.requestId === m.requestId) {
        const create = pendingConfig.newThread;
        clearTimeout(configTimer);
        pendingConfig = null;
        if (create) sendWs({ type: "newThread", cwd: $("cfgCwd").value.trim() || undefined });
        $("sheet").classList.add("hidden");
        updateSettingsButtons();
      }
      break;
    case "writerConflict":
      clearTimeout(writerTimer);
      writerPending = null;
      writerConflict = m;
      renderWriterConflict();
      break;
    case "event":
      if (m.event.kind === "user" && input.value.trim() === m.event.text) input.value = "";
      renderEvent(m.event);
      scrollFeed();
      break;
    case "assistantDelta":
      appendAssistant(m.text, m.itemId);
      break;
    case "approval":
      renderApproval(m.approval);
      notifyApproval(m.approval);
      break;
    case "approvalResolved":
      removeApproval(m.key);
      break;
    case "error":
      if (writerPending && writerPending === m.requestId) {
        clearTimeout(writerTimer); writerPending = null;
        $("writerStatus").textContent = m.message;
        updateWriterButtons();
      }
      if (pendingConfig && pendingConfig.requestId === m.requestId) configError(m.message);
      renderEvent({ kind: "error", text: m.message, ts: Date.now() });
      scrollFeed();
      break;
    case "diff":
      setDiff(m.diff || "");
      break;
    case "projectTree":
      renderProjectTree(m);
      break;
  }
}

function setConn(ok, label) {
  $("connDot").classList.toggle("on", !!ok);
  if (label) $("statusPill").textContent = label;
}

function applyState() {
  const connected = !!(ws && ws.readyState === WebSocket.OPEN) && appState.codexConnected
    && (profile.mode !== "cloud" || (!!agentPub && paired));
  $("connDot").classList.toggle("on", connected);
  const running = appState.status === "running";
  const pill = $("statusPill");
  pill.textContent = appState.readOnly ? "历史" : running ? "运行中" : "空闲";
  pill.className = "pill " + (running ? "running" : "idle");
  $("runningBar").classList.toggle("hidden", !running);
  const name = appState.threadName ? "「" + appState.threadName + "」 " : "";
  $("cwdLabel").textContent =
    name + (appState.cwd || "—") +
    ((appState.effectiveModel || appState.model) ? "  ·  " + (appState.effectiveModel || appState.model) : "") +
    "  ·  " + (appState.approvalPolicy || "");
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------
function cls(kind) {
  if (kind === "user") return "user";
  if (kind === "item:agentMessage") return "assistant";
  if (kind && kind.startsWith("item:commandExecution")) return "cmd";
  if (kind && kind.startsWith("item:fileChange")) return "file";
  if (kind && kind.startsWith("item:")) return "tool";
  if (kind === "error") return "error";
  if (kind === "thread" || kind === "turn") return kind;
  if (kind === "approval-requested" || kind === "approval-resolved") return "tool";
  return "tool";
}
function labelFor(kind) {
  if (kind === "user") return "你";
  if (kind === "item:agentMessage") return "Codex";
  return null;
}

function setEventText(div, e) {
  const body = div.querySelector(".body");
  if (body) body.textContent = e.text || "";
  const summary = div.querySelector("summary");
  if (summary) { summary.textContent = (e.text || "").split("\n")[0]; summary.title = summary.textContent; }
}

function renderEvent(e) {
  const existing = e.id && eventRows.get(e.id);
  if (existing) {
    setEventText(existing, e);
    if (existing === liveAssistant && !e.live) liveAssistant = null;
    return;
  }
  if (e.kind === "item:agentMessage" && liveAssistant && (!e.itemId || liveAssistant.dataset.itemId === e.itemId)) {
    liveAssistant.querySelector(".body").textContent = e.text;
    liveAssistant.dataset.eventId = e.id || "";
    if (e.id) eventRows.set(e.id, liveAssistant);
    liveAssistant = null;
    return;
  }
  const div = document.createElement("div");
  div.className = "entry " + cls(e.kind);
  div.dataset.eventId = e.id || "";
  div.dataset.itemId = e.itemId || "";
  const lab = labelFor(e.kind);
  const collapsible = e.kind?.startsWith("item:") && !["item:agentMessage", "item:plan"].includes(e.kind) && (e.text || "").includes("\n");
  div.innerHTML = (lab ? '<div class="label">' + lab + '</div>' : "") + (collapsible ? '<details><summary></summary><div class="body"></div></details>' : '<div class="body"></div>');
  setEventText(div, e);
  $("feed").appendChild(div);
  if (e.id) eventRows.set(e.id, div);
  if (e.live) liveAssistant = div;
}

function appendAssistant(text, itemId) {
  if (liveAssistant && itemId && liveAssistant.dataset.itemId !== itemId) liveAssistant = null;
  if (!liveAssistant) {
    const div = document.createElement("div");
    div.className = "entry assistant";
    div.dataset.itemId = itemId || "";
    div.innerHTML = `<div class="label">Codex</div><div class="body"></div>`;
    $("feed").appendChild(div);
    liveAssistant = div;
  }
  liveAssistant.querySelector(".body").textContent += text;
  scrollFeed();
}

function scrollFeed() {
  const f = $("feed");
  f.scrollTop = f.scrollHeight;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
function renderApproval(a) {
  if (document.querySelector(`[data-key="${a.key}"]`)) return;
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.key = a.key;
  const meta = [];
  if (a.cwd) meta.push("📁 " + a.cwd);
  if (a.reason) meta.push("💬 " + a.reason);
  if (a.note) meta.push("⚠ " + a.note);
  card.innerHTML =
    `<div class="ac-title">⚠ ${a.title}</div>` +
    `<div class="ac-cmd">${escapeHtml(a.command || "")}</div>` +
    (meta.length ? `<div class="ac-meta">${escapeHtml(meta.join("\n"))}</div>` : "") +
    `<div class="ac-actions"></div>`;
  const actions = card.querySelector(".ac-actions");
  (a.options || []).forEach((opt) => {
    const b = document.createElement("button");
    b.className = "btn " + (opt.style === "danger" ? "danger" : opt.style === "primary" ? "primary" : "secondary");
    b.textContent = opt.label;
    b.onclick = () => {
      sendWs({ type: "approval", key: a.key, optionId: opt.id });
      removeApproval(a.key);
    };
    actions.appendChild(b);
  });
  $("approvals").prepend(card);
}

function removeApproval(key) {
  const el = document.querySelector(`[data-key="${key}"]`);
  if (el) el.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Notifications (local) when an approval arrives
// ---------------------------------------------------------------------------
function notifyApproval(a) {
  try { navigator.vibrate && navigator.vibrate([80, 40, 80]); } catch {}
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const body = (a.command || "").slice(0, 120);
  navigator.serviceWorker?.ready
    .then((reg) => reg.showNotification("Codex 需要审批：" + a.title, { body, tag: a.key, requireInteraction: true }))
    .catch(() => { try { new Notification("Codex 需要审批：" + a.title, { body }); } catch {} });
}

$("enableNotif").onclick = async () => {
  if (typeof Notification === "undefined") { alert("此浏览器不支持通知"); return; }
  const p = await Notification.requestPermission();
  alert(p === "granted" ? "通知已开启" : "通知未开启：" + p);
};

// ---------------------------------------------------------------------------
// Composer: send / steer / interrupt
// ---------------------------------------------------------------------------
const input = $("input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
});

function sendPrompt() {
  const text = input.value.trim();
  if (!text) return;
  const steer = $("steerMode").checked;
  if (!sendWs(steer ? { type: "steer", text } : { type: "prompt", text })) return;
  if (!appState.readOnly) input.value = "";
  input.style.height = "auto";
}

$("sendBtn").onclick = sendPrompt;
input.addEventListener("keydown", (e) => {
  // Enter to send on hardware keyboards; Shift+Enter = newline.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt();
  }
});
$("interruptBtn").onclick = () => sendWs({ type: "interrupt" });

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
function renderModelOptions(selected = $("cfgModel").value) {
  const select = $("cfgModel");
  select.replaceChildren(new Option(defaultModel ? "Codex 默认（" + defaultModel + "）" : "Codex 默认", "default"));
  modelCatalog.forEach((m) => select.add(new Option(m.displayName === m.model ? m.model : m.displayName + " · " + m.model, "model:" + m.model)));
  select.add(new Option("自定义模型", "custom"));
  if (selected.startsWith("model:") && !modelCatalog.some((m) => "model:" + m.model === selected)) {
    $("cfgCustomModel").value = selected.slice(6);
    selected = "custom";
  }
  select.value = selected || "default";
  $("customModelRow").classList.toggle("hidden", select.value !== "custom");
}
function requestModels() {
  clearTimeout(modelsTimer);
  $("modelsStatus").textContent = "加载中…";
  $("modelsRefresh").disabled = true;
  if (!sendWs({ type: "listModels", cwd: $("cfgCwd").value.trim() || undefined })) {
    $("modelsStatus").textContent = "连接已断开";
    $("modelsRefresh").disabled = false;
    return;
  }
  modelsTimer = setTimeout(() => {
    $("modelsStatus").textContent = "模型列表加载超时";
    $("modelsRefresh").disabled = false;
  }, 20000);
}
function updateSettingsButtons() {
  $("cfgApply").disabled = !!pendingConfig;
  $("newThreadBtn").disabled = !!pendingConfig;
}
function configError(message) {
  clearTimeout(configTimer);
  pendingConfig = null;
  $("cfgError").textContent = message;
  $("cfgError").classList.remove("hidden");
  updateSettingsButtons();
}
$("menuBtn").onclick = () => {
  $("cfgCwd").value = appState.cwd || "";
  $("cfgApproval").value = appState.approvalPolicy || "on-request";
  $("cfgSandbox").value = appState.sandbox || "workspace-write";
  $("cfgCustomModel").value = appState.model || "";
  renderModelOptions(appState.model ? "model:" + appState.model : "default");
  $("cfgError").classList.add("hidden");
  $("sheet").classList.remove("hidden");
  requestModels();
};
$("cfgModel").onchange = () => {
  $("customModelRow").classList.toggle("hidden", $("cfgModel").value !== "custom");
  $("cfgError").classList.add("hidden");
};
$("cfgCustomModel").oninput = () => $("cfgError").classList.add("hidden");
$("modelsRefresh").onclick = requestModels;
$("sheetClose").onclick = () => $("sheet").classList.add("hidden");
function saveSettings(newThread = false) {
  if (pendingConfig) return;
  const selected = $("cfgModel").value;
  const model = selected === "default" ? null : selected === "custom" ? $("cfgCustomModel").value.trim() : selected.slice(6);
  if (selected === "custom" && (!model || /\s|[\x00-\x1f\x7f]/.test(model))) {
    configError("请输入有效的模型 ID");
    return;
  }
  pendingConfig = { requestId: "settings-" + Date.now(), newThread };
  $("cfgError").classList.add("hidden");
  updateSettingsButtons();
  if (!sendWs({
    type: "setConfig",
    requestId: pendingConfig.requestId,
    model,
    cwd: $("cfgCwd").value.trim() || undefined,
    approvalPolicy: $("cfgApproval").value,
    sandbox: $("cfgSandbox").value,
  })) { configError("连接已断开，设置未保存"); return; }
  configTimer = setTimeout(() => configError("保存确认超时，请重新连接后检查设置"), 12000);
}
$("cfgApply").onclick = () => saveSettings();
$("newThreadBtn").onclick = () => saveSettings(true);
function forget() {
  localStorage.removeItem(LS.profile); // keep keys so the device stays paired
  location.reload();
}
$("forget").onclick = forget;

// ---------------------------------------------------------------------------
// Diff bar + sheet (see the code Codex wrote)
// ---------------------------------------------------------------------------
function setDiff(diff) {
  lastDiff = diff || "";
  $("diffBar").classList.toggle("hidden", !lastDiff);
  if (!$("diffSheet").classList.contains("hidden")) {
    $("diffContent").textContent = lastDiff || "(无改动)";
  }
}
$("diffBar").onclick = () => {
  $("diffContent").textContent = lastDiff || "(无改动)";
  $("diffSheet").classList.remove("hidden");
};
$("diffClose").onclick = () => $("diffSheet").classList.add("hidden");

// ---------------------------------------------------------------------------
// Sessions / projects sheet (pick a real project, resume a conversation)
// ---------------------------------------------------------------------------
function loadSessions() {
  $("sessionsList").innerHTML = '<p class="muted small">加载中…</p>';
  if (!sendWs({ type: "listThreads" })) $("sessionsList").textContent = "连接已断开，无法加载会话";
}
$("sessionsBtn").onclick = () => { $("sessionsSheet").classList.remove("hidden"); loadSessions(); };
$("sessionsRefresh").onclick = loadSessions;
$("sessionsClose").onclick = () => $("sessionsSheet").classList.add("hidden");

// Render the EXACT Codex desktop tree: projects (with labels, in order, empty
// ones show 暂无对话) + the flat 对话 group. Data comes from the relay, which
// reads Codex's own .codex-global-state.json.
function sessionItem(t) {
  const item = document.createElement("button");
  item.className = "session-item nested";
  const when = t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : "";
  item.innerHTML =
    `<div class="s-name">${escapeHtml(t.name || "(无标题)")}</div>` +
    `<div class="s-meta">${escapeHtml(when)}</div>`;
  item.onclick = () => {
    sendWs({ type: "readThread", threadId: t.id });
    $("sessionsSheet").classList.add("hidden");
  };
  return item;
}

function renderProjectTree(tree) {
  const list = $("sessionsList");
  list.innerHTML = "";
  const projects = tree.projects || [];
  const projectless = tree.projectless || [];
  if (!projects.length && !projectless.length) { list.innerHTML = '<p class="muted small">没有会话</p>'; return; }

  projects.forEach((p) => {
    const header = document.createElement("div");
    header.className = "session-group";
    header.innerHTML =
      `<div class="sg-name">📁 ${escapeHtml(p.label)} <span class="sg-count">${p.threads.length}</span></div>` +
      `<div class="sg-path mono">${escapeHtml(p.root)}</div>`;
    list.appendChild(header);
    if (!p.threads.length) {
      const empty = document.createElement("div");
      empty.className = "muted small"; empty.style.margin = "0 0 8px 14px";
      empty.textContent = "暂无对话";
      list.appendChild(empty);
    }
    p.threads.forEach((t) => list.appendChild(sessionItem(t)));
  });

  if (projectless.length) {
    const header = document.createElement("div");
    header.className = "session-group";
    header.innerHTML = `<div class="sg-name">💬 对话 <span class="sg-count">${projectless.length}</span></div>`;
    list.appendChild(header);
    projectless.forEach((t) => list.appendChild(sessionItem(t)));
  }
}

function updateWriterButtons() {
  $("writerSheet").querySelectorAll("button").forEach((button) => { button.disabled = !!writerPending; });
}
function writerAction(type, extra = {}) {
  if (!writerConflict || writerPending) return;
  writerPending = "writer-" + Date.now();
  $("writerStatus").textContent = type === "takeoverThread" ? "正在结束占用进程并尝试接续…" : "处理中…";
  updateWriterButtons();
  if (!sendWs({ type, threadId: writerConflict.threadId, requestId: writerPending, ...extra })) {
    writerPending = null;
    $("writerStatus").textContent = "连接已断开，操作未发送";
    updateWriterButtons();
    return;
  }
  writerTimer = setTimeout(() => {
    writerPending = null;
    $("writerStatus").textContent = "操作确认超时，请重新检查占用状态";
    updateWriterButtons();
  }, 30000);
}
function renderWriterConflict() {
  writerChoice = null;
  $("writerConfirm").classList.add("hidden");
  $("writerStatus").textContent = "";
  $("writerMessage").textContent = writerConflict.message;
  const list = $("writerOwners");
  list.replaceChildren();
  (writerConflict.owners || []).forEach((owner) => {
    const row = document.createElement("div"); row.className = "writer-owner";
    const title = document.createElement("strong"); title.textContent = owner.name + " · PID " + owner.pid;
    row.appendChild(title);
    const affected = document.createElement("ul"); affected.className = "writer-threads mono";
    (owner.affectedThreads || []).forEach((id) => { const li = document.createElement("li"); li.textContent = id; affected.appendChild(li); });
    row.appendChild(affected);
    if (owner.canTerminate && owner.token) {
      const button = document.createElement("button"); button.className = "btn danger full";
      button.textContent = "结束进程并尝试接续";
      button.onclick = () => {
        writerChoice = owner;
        $("writerConfirmText").textContent = "确认强制结束 PID " + owner.pid + "？将中止该进程持有的 " + owner.affectedThreads.length + " 个会话，已产生的文件改动不会回滚。";
        $("writerConfirm").classList.remove("hidden");
        $("writerCancelBtn").focus();
      };
      row.appendChild(button);
    } else {
      const note = document.createElement("p"); note.className = "muted small";
      note.textContent = "无法安全结束此进程，请在电脑端关闭对应会话。";
      row.appendChild(note);
    }
    list.appendChild(row);
  });
  $("writerSheet").classList.remove("hidden");
  updateWriterButtons();
  $("writerRetry").focus();
}
$("writerRetry").onclick = () => writerAction("resumeThread");
$("writerInspect").onclick = () => writerAction("inspectWriter");
$("writerConfirmBtn").onclick = () => { if (writerChoice) writerAction("takeoverThread", { token: writerChoice.token, confirmed: true }); };
$("writerCancelBtn").onclick = () => { writerChoice = null; $("writerConfirm").classList.add("hidden"); };
$("writerClose").onclick = () => $("writerSheet").classList.add("hidden");

// ---------------------------------------------------------------------------
// Service worker + boot
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
start();
