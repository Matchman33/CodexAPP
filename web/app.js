// CodexApp web client. Two modes (the rest of the UI consumes the same protocol):
//   - cloud: email account -> broker (same origin) -> E2E + pairing -> PC agent
//   - lan:   direct WebSocket to a relay (url + token)
"use strict";

const $ = (id) => document.getElementById(id);
const LS = { profile: "codexapp.profile", keys: "codexapp.keys" };

// Request/display IDs must also work on ordinary HTTP IP origins.
function newClientId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

let ws = null;
let backoff = 1000;
let reconnectTimer = null;
let connectionTimer = null;
let loginAbort = null;
let connectionAttempt = 0;
let connectionWanted = false;
let sessionReady = false;
let connectionLabel = "连接中…";
let hostedRelay = false;
let setupModeChosen = false;
const CONNECT_TIMEOUT = 12000;
let liveAssistant = null;
const historyFeed = new window.HistoryFeed($("feed"), createEventRow, setEventText);
let pendingSelection = null;
let selectionTimer = null;
let pageRequest = null;
let pageTimer = null;
const itemRequests = new Map();
let historyPages = [];
const pageCache = new Map();
const recentOverlay = new Map();
let pagedHistory = false;
let oldestPage = 0;
let newestPage = 0;
const historyClientId = "history-" + Math.random().toString(36).slice(2);
let lastSelectionId = null;
let requestedPagedMode = false;
let promptQueueState = null;
let threadManagement = {};
let threadActionChoice = null;
let threadActionPending = null;
let threadActionTimer = null;
const deletedThreads = new Set();
let imageUploadSupported = false;
let pendingDirect = null;
let pendingPrompt = null;
let promptTimer = null;
let queueExpanded = true;
let appState = {};
let modelCatalog = [];
let defaultModel = null;
let defaultReasoningEffort = null;
let lastProjectTree = null;
let followLatest = true;
const effortNames = { none: "关闭思考", minimal: "极低", low: "低", medium: "中等", high: "高", xhigh: "特高", max: "最高", ultra: "极致" };
const effortName = (value) => effortNames[value] || value || "默认思考";
const colorScheme = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(value = localStorage.getItem("codexapp.theme") || "light") {
  document.documentElement.dataset.theme = value === "system" ? (colorScheme.matches ? "dark" : "light") : value;
  $("cfgTheme").value = value;
  document.querySelector('meta[name="theme-color"]').content = document.documentElement.dataset.theme === "dark" ? "#212121" : "#ffffff";
}
colorScheme.addEventListener("change", () => applyTheme());
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
  detectHost();
}
async function detectHost() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("/health", { signal: controller.signal, cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    hostedRelay = data.ok === true && typeof data.codexConnected === "boolean";
    $("usePageUrl").classList.toggle("hidden", !hostedRelay);
    if (hostedRelay && profile.mode === "cloud" && connectionWanted) {
      stopConnection(); showSetup(); switchTab("lan");
      $("setupUrl").value = location.origin;
      $("setupMsg").textContent = "当前是电脑中继入口，请使用访问 Token 连接，无需云账号登录";
      return;
    }
    if ((hostedRelay || data.ok === true && typeof data.rooms === "number") && !profileReady(profile) && !setupModeChosen && !$("setup").classList.contains("hidden")) {
      switchTab(hostedRelay ? "lan" : "cloud");
      if (hostedRelay && !$("setupUrl").value) $("setupUrl").value = location.origin;
    }
  } catch {} finally { clearTimeout(timer); }
}
function showSetup() {
  hideAllScreens();
  $("setup").classList.remove("hidden");
  if (profile.email) $("cEmail").value = profile.email;
  if (profile.url) $("setupUrl").value = profile.url;
  else if (hostedRelay) $("setupUrl").value = location.origin;
  switchTab(profile.mode || "lan");
}
function hideAllScreens() {
  document.body.classList.remove("app-ready");
  ["setup", "register", "pairing", "membership", "app"].forEach((id) => $(id).classList.add("hidden"));
}
function showApp() {
  hideAllScreens();
  $("app").classList.remove("hidden");
  document.body.classList.add("app-ready");
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
  if (el) el.textContent = profile.mode === "cloud" ? "会员：" + fmtMember(memberUntil) : "中继直连（免费）";
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
  stopConnection();
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
$("tabCloud").onclick = () => { setupModeChosen = true; switchTab("cloud"); };
$("tabLan").onclick = () => { setupModeChosen = true; switchTab("lan"); };
$("usePageUrl").onclick = () => { if (hostedRelay) $("setupUrl").value = location.origin; };

function doCloud() {
  const email = $("cEmail").value.trim();
  const password = $("cPass").value;
  if (!email || !password) { $("cMsg").textContent = "请填邮箱和密码"; return; }
  membershipBlocked = false; authToken = null;
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
  if (!url || !token) { $("setupMsg").textContent = "请填写中继地址和 Token"; return; }
  try { relaySocketUrl(url, token); }
  catch (error) { $("setupMsg").textContent = error.message; return; }
  saveProfile({ mode: "lan", url, token });
  showApp(); connect();
};

// ---------------------------------------------------------------------------
// Connection (dual transport)
// ---------------------------------------------------------------------------
function connect() {
  connectionWanted = true;
  disposeConnection();
  if (profile.mode === "lan") membershipBlocked = false;
  if (!profileReady(profile) || membershipBlocked) return;
  if (!navigator.onLine) { setConn(false, "网络已离线"); return; }
  const attempt = connectionAttempt;
  setConn(false, "连接中…");
  armConnectionTimeout(attempt);
  if (profile.mode === "cloud") connectCloud(attempt);
  else connectLan(attempt);
}

function disposeConnection() {
  clearTimeout(promptTimer);
  if (pendingPrompt) { pendingPrompt.waiting = false; $("promptStatus").textContent = "连接中断，消息受理状态待确认"; }
  requestedPagedMode = false;
  clearTimeout(selectionTimer); pendingSelection = null;
  clearTimeout(pageTimer); pageRequest = null;
  for (const request of itemRequests.values()) clearTimeout(request.timer);
  itemRequests.clear();
  connectionAttempt++;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  clearTimeout(connectionTimer); connectionTimer = null;
  if (loginAbort) { loginAbort.abort(); loginAbort = null; }
  const previous = ws;
  ws = null;
  sessionReady = false;
  agentPub = null; paired = false;
  if (previous) {
    previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
    try { previous.close(); } catch {}
  }
}
function stopConnection() {
  connectionWanted = false;
  disposeConnection();
  updateComposer();
}
function armConnectionTimeout(attempt) {
  clearTimeout(connectionTimer);
  connectionTimer = setTimeout(() => {
    if (attempt === connectionAttempt) scheduleReconnect("连接超时，正在重试");
  }, CONNECT_TIMEOUT);
}
function relaySocketUrl(url, token) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("中继地址必须是完整的 HTTP 或 HTTPS 地址"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("中继地址必须使用 HTTP 或 HTTPS，且不能包含账号密码");
  }
  if (location.protocol === "https:" && parsed.protocol !== "https:") {
    throw new Error("HTTPS 页面不能连接 HTTP 中继，请改用 Serve 的 HTTPS 地址");
  }
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") + "/ws";
  parsed.search = ""; parsed.hash = "";
  parsed.searchParams.set("token", token);
  parsed.searchParams.set("history", "paged");
  return parsed.href;
}
function connectLan(attempt) {
  let url;
  try { url = relaySocketUrl(profile.url, profile.token); }
  catch (error) {
    stopConnection(); showSetup(); $("setupMsg").textContent = error.message; return;
  }
  let socket;
  try { socket = ws = new WebSocket(url); }
  catch { scheduleReconnect("无法建立连接，正在重试"); return; }
  socket.onmessage = (ev) => {
    if (attempt !== connectionAttempt) return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
  socket.onclose = (ev) => {
    if (attempt !== connectionAttempt) return;
    if (ev.code === 4001) {
      stopConnection(); showSetup(); $("setupMsg").textContent = "Token 无效，请重新填写电脑终端中的 Token"; return;
    }
    scheduleReconnect();
  };
  socket.onerror = () => { if (attempt === connectionAttempt) scheduleReconnect("网络连接失败，正在重试"); };
}

async function connectCloud(attempt) {
  let token;
  const controller = new AbortController();
  loginAbort = controller;
  try {
    const r = await fetch("/api/login", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ email: profile.email, password: profile.password }) });
    if (attempt !== connectionAttempt) return;
    if (r.status === 401) { loginFailed("账号或密码错误"); return; }
    if (r.status === 403) { loginFailed("请先验证邮箱（注册后点邮件里的链接）", true); return; }
    if (!r.ok) { scheduleReconnect(); return; }
    const data = await r.json();
    if (attempt !== connectionAttempt) return;
    loginAbort = null;
    token = data.token; authToken = token; memberUntil = data.membershipUntil || 0;
    updateMemberStatus();
  } catch { if (attempt === connectionAttempt) scheduleReconnect(); return; }

  // Not a member → show the upgrade screen instead of (uselessly) hitting the gate.
  if (memberUntil <= Date.now()) { membershipBlocked = true; stopConnection(); showMembership("云端会员未开通或已过期，输入兑换码即可开通。"); return; }

  let socket;
  try { socket = ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/link"); }
  catch { scheduleReconnect(); return; }
  socket.onopen = () => { if (attempt === connectionAttempt) socket.send(JSON.stringify({ type: "auth", token, role: "phone", pubkey: keys.publicKey })); };
  socket.onmessage = (ev) => {
    if (attempt !== connectionAttempt) return;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "authed") {
      clearTimeout(connectionTimer); connectionTimer = null; backoff = 1000;
      setConn(false, "等待电脑 Agent…");
      if (m.peerOnline && m.peerPubkey) { agentPub = m.peerPubkey; armConnectionTimeout(attempt); }
      return;
    }
    if (m.type === "peer") {
      agentPub = m.online ? m.pubkey : null;
      if (!m.online) {
        clearTimeout(connectionTimer); connectionTimer = null;
        paired = false; sessionReady = false; appState.codexConnected = false;
        setConn(false, "等待电脑 Agent…");
        if (!$("pairing").classList.contains("hidden")) $("pStatus").textContent = "电脑端已离线，等待上线…";
      } else armConnectionTimeout(attempt);
      return;
    }
    if (m.type === "e2e") {
      const inner = window.E2E.open(m, agentPub, keys.secretKey);
      if (!inner) return;
      if (inner.type === "needPairing") {
        clearTimeout(connectionTimer); connectionTimer = null;
        // Agent online but this device isn't paired yet -> ask for the code (a step AFTER login).
        showPairing();
        $("pStatus").textContent = agentPub ? "✅ 电脑端在线，请输入配对码" : "等待电脑端上线…";
        return;
      }
      if (inner.type === "paired") {
        if (inner.ok) { paired = true; showApp(); armConnectionTimeout(attempt); }      // bound -> straight to app
        else { $("pMsg").textContent = "配对失败：" + (inner.reason || "配对码不对，请重试"); }
        return;
      }
      if (inner.type === "hello") { paired = true; if ($("app").classList.contains("hidden")) showApp(); } // already-paired device auto-connects
      handle(inner);
      return;
    }
    if (m.type === "error") {
      if (m.code === "membership_required") { membershipBlocked = true; stopConnection(); showMembership("云端会员未开通或已过期，输入兑换码即可开通。"); return; }
      if (/token|invalid/i.test(m.message || "")) loginFailed("登录失效，请重新登录");
      return;
    }
  };
  socket.onclose = () => { if (attempt === connectionAttempt && !membershipBlocked) scheduleReconnect(); };
  socket.onerror = () => { if (attempt === connectionAttempt) scheduleReconnect("网络连接失败，正在重试"); };
}

function scheduleReconnect(label = "连接已断开，正在重试") {
  if (!connectionWanted || membershipBlocked) return;
  disposeConnection();
  setConn(false, navigator.onLine ? label : "网络已离线");
  if (!navigator.onLine) return;
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 1.6, 15000);
}

function sendWs(obj) {
  if (["newThread", "getState"].includes(obj.type)) obj = { ...obj, historyMode: "paged" };
  if (!sessionReady || !ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    if (profile.mode === "cloud") {
      if (!agentPub || !paired) return false;
      ws.send(JSON.stringify({ type: "e2e", ...window.E2E.seal(obj, agentPub, keys.secretKey) }));
    } else {
      ws.send(JSON.stringify(obj));
    }
    return true;
  } catch { scheduleReconnect(); return false; }
}

function resumeConnection() {
  if (!connectionWanted || !profileReady(profile) || membershipBlocked) return;
  backoff = 1000;
  connect();
}
window.addEventListener("offline", () => {
  if (!connectionWanted) return;
  disposeConnection(); setConn(false, "网络已离线");
});
window.addEventListener("online", resumeConnection);
document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeConnection(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) resumeConnection(); });
$("reconnectBtn").onclick = resumeConnection;

// ---------------------------------------------------------------------------
// Inbound message handling
// ---------------------------------------------------------------------------
function handle(m) {
  switch (m.type) {
    case "hello":
      if (deletedThreads.has(m.state?.threadId)) break;
      if (m.requestId?.startsWith(historyClientId + "-select-") && m.requestId !== lastSelectionId) break;
      if (pendingSelection && (m.requestId ? m.requestId !== pendingSelection.requestId : m.state?.threadId !== pendingSelection.threadId)) break;
      clearTimeout(selectionTimer); pendingSelection = null;
      clearTimeout(pageTimer); pageRequest = null;
      for (const request of itemRequests.values()) clearTimeout(request.timer);
      itemRequests.clear();
      clearTimeout(connectionTimer); connectionTimer = null;
      backoff = 1000; sessionReady = true;
      connectionLabel = "电脑 Codex 未连接";
      followLatest = true;
      clearTimeout(writerTimer);
      writerPending = null; writerConflict = null;
      $("writerSheet").classList.add("hidden");
      appState = m.state || {};
      threadManagement = m.threadManagement || {};
      imageUploadSupported = !!m.imageUpload?.supported;
      promptQueueState = m.promptQueue?.supported ? m.promptQueue : null;
      if (pendingPrompt && promptQueueState?.acceptedRequestIds?.includes(pendingPrompt.requestId)) acceptPrompt(pendingPrompt.requestId);
      else if (pendingPrompt) pendingPrompt.waiting = false;
      applyState();
      renderPromptQueue();
      liveAssistant = null;
      pagedHistory = !!m.history?.paged;
      historyPages = [{ cursor: null, nextCursor: m.history?.nextCursor || null }];
      pageCache.clear(); recentOverlay.clear(); oldestPage = newestPage = 0;
      if (pagedHistory) {
        pageCache.set(0, m.recentEvents || []);
        if (!m.requestId) for (const e of m.recentEvents || []) recentOverlay.set(e.id, e);
      }
      historyFeed.replace(m.recentEvents || [], true);
      updateHistoryControls();
      $("approvals").innerHTML = "";
      (m.pendingApprovals || []).forEach(renderApproval);
      if (m.config) {
        $("cfgCwd").value = m.config.cwd || "";
        $("cfgApproval").value = m.config.approvalPolicy || "on-request";
        $("cfgSandbox").value = m.config.sandbox || "workspace-write";
      }
      setDiff(m.diff || "");
      scrollFeed();
      if (!lastProjectTree) loadSessions();
      if (pagedHistory && !m.requestId) requestHistoryPage(0, true);
      if (!pagedHistory && !requestedPagedMode) { requestedPagedMode = true; sendWs({ type: "getState", historyMode: "paged" }); }
      break;
    case "state":
      if (deletedThreads.has(m.state?.threadId)) break;
      if (pendingSelection) break;
      const completedTurn = appState.status === "running" && m.state?.status === "idle";
      appState = m.state || appState;
      applyState();
      if (completedTurn && pagedHistory && followLatest && recentOverlay.size >= 100) requestHistoryPage(0, true);
      break;
    case "models":
      clearTimeout(modelsTimer);
      modelCatalog = m.models || [];
      defaultModel = m.defaultModel || null;
      defaultReasoningEffort = m.defaultReasoningEffort || null;
      renderModelOptions();
      renderEffortOptions();
      applyState();
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
      if (m.onOpen) {
        if (!pendingSelection || m.requestId !== pendingSelection.requestId || m.threadId !== pendingSelection.threadId || deletedThreads.has(m.threadId)) break;
        clearTimeout(selectionTimer); pendingSelection = null;
        updateHistoryControls(); updateComposer();
      }
      clearTimeout(writerTimer);
      writerPending = null;
      writerConflict = m;
      renderWriterConflict();
      break;
    case "event":
      if (pendingSelection || (m.event.threadId && m.event.threadId !== appState.threadId)) break;
      if (m.event.kind?.startsWith("item:") && m.event.turnId && appState.turnId && m.event.turnId !== appState.turnId) break;
      if (m.event.kind === "user" && pendingDirect?.requestId === m.event.id) {
        if (input.value.trim() === pendingDirect.text) input.value = "";
        attachments.clear(pendingDirect.imageIds); pendingDirect = null; input.style.height = "auto"; updateComposer();
      }
      if (!promptQueueState?.supported && m.event.kind === "user" && (input.value.trim() === m.event.text || (m.event.truncated && input.value.trim().length === m.event.textLength && input.value.trim().startsWith(m.event.text)))) { input.value = ""; input.style.height = "auto"; updateComposer(); }
      renderEvent(m.event);
      scrollFeed();
      break;
    case "assistantDelta":
      if (pendingSelection || (m.threadId && m.threadId !== appState.threadId)) break;
      appendAssistant(m.text, m.itemId, m.turnId);
      break;
    case "outputDelta":
    case "itemDelta":
      if (pendingSelection || !m.itemId || (m.threadId && m.threadId !== appState.threadId)) break;
      appendStreamItem(m, m.type === "outputDelta" ? "item:commandExecution" : m.kind);
      break;
    case "promptQueue":
      receivePromptQueue(m.queue);
      break;
    case "promptAccepted":
      acceptPrompt(m.requestId);
      receivePromptQueue(m.queue);
      break;
    case "historyPage":
      if (!pageRequest || pageRequest.requestId !== m.requestId || m.threadId !== appState.threadId) break;
      receiveHistoryPage(m);
      break;
    case "historyItem": {
      const request = itemRequests.get(m.requestId);
      if (!request || m.threadId !== appState.threadId) break;
      clearTimeout(request.timer); itemRequests.delete(m.requestId);
      const event = historyFeed.events.find(e => e.id === request.eventId);
      if (event) {
        const updated = { ...event, text: m.text, textOffset: m.offset, textLength: m.textLength, truncated: true };
        replaceCachedEvent(updated); historyFeed.upsert(updated);
      }
      break;
    }
    case "approval":
      renderApproval(m.approval);
      notifyApproval(m.approval);
      break;
    case "approvalResolved":
      removeApproval(m.key);
      break;
    case "error":
      if (m.requestId && m.requestId === threadActionPending?.requestId) { finishThreadAction(m.message); break; }
      if (pendingPrompt && pendingPrompt.requestId === m.requestId) {
        clearTimeout(promptTimer); pendingPrompt = null; $("promptStatus").textContent = m.message; updateComposer(); break;
      }
      if (m.requestId?.startsWith("queue-action-")) { $("promptStatus").textContent = m.message; break; }
      if (m.requestId?.startsWith(historyClientId + "-select-") && m.requestId !== lastSelectionId) break;
      if (m.requestId?.startsWith(historyClientId + "-page-") && m.requestId !== pageRequest?.requestId) break;
      if (m.requestId?.startsWith(historyClientId + "-item-") && !itemRequests.has(m.requestId)) break;
      if (pageRequest?.requestId === m.requestId) {
        clearTimeout(pageTimer); pageRequest = null; updateHistoryControls(m.message); break;
      }
      if (itemRequests.has(m.requestId)) {
        clearTimeout(itemRequests.get(m.requestId).timer); itemRequests.delete(m.requestId);
        $("historyStatus").textContent = m.message; break;
      }
      if (pendingSelection?.requestId === m.requestId) {
        clearTimeout(selectionTimer); pendingSelection = null; updateComposer(); updateHistoryControls(m.message); break;
      }
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
    case "threadReleased":
      if (m.requestId === threadActionPending?.requestId) {
        $("threadActionStatus").textContent = m.writerReleased ? "当前中继已释放会话占用，可以在其他进程接续。" : "已取消订阅，正在等待会话卸载。";
        finishThreadAction();
      }
      break;
    case "threadDeleted":
      forgetDeletedThread(m.threadId);
      if (m.requestId === threadActionPending?.requestId) { $("threadActionStatus").textContent = "会话已删除"; finishThreadAction(); }
      break;
  }
}

function setConn(ok, label) {
  if (label) connectionLabel = label;
  $("connDot").classList.toggle("on", !!ok);
  if (label) $("statusPill").textContent = label;
  $("statusPill").title = connectionLabel;
  $("reconnectBtn").classList.toggle("hidden", !!ok);
  updateComposer();
}

function applyState() {
  renderPermissions();
  const connected = sessionReady && !!(ws && ws.readyState === WebSocket.OPEN) && appState.codexConnected
    && (profile.mode !== "cloud" || (!!agentPub && paired));
  $("connDot").classList.toggle("on", connected);
  const running = appState.status === "running";
  const pill = $("statusPill");
  pill.textContent = !connected ? connectionLabel : appState.writerReleased ? "已释放" : appState.readOnly ? "历史" : running ? "运行中" : "已连接";
  pill.title = pill.textContent;
  $("reconnectBtn").classList.toggle("hidden", !!connected);
  pill.className = "pill " + (running ? "running" : "idle");
  $("runningBar").classList.toggle("hidden", !running);
  $("threadTitle").textContent = appState.threadName || "新对话";
  $("threadTitle").title = appState.threadName || "新对话";
  $("cwdLabel").textContent = appState.cwd || "";
  $("cwdLabel").title = appState.cwd || "";
  const activeModel = appState.model || defaultModel || appState.effectiveModel;
  $("headerModel").textContent = modelCatalog.find((m) => m.model === activeModel)?.displayName || activeModel || "默认模型";
  $("headerModel").title = activeModel || "Codex 默认";
  $("effortLabel").textContent = effortName(appState.reasoningEffort);
  $("effortBtn").title = "思考等级：" + effortName(appState.reasoningEffort) + (appState.effectiveReasoningEffort ? "；当前任务：" + effortName(appState.effectiveReasoningEffort) : "");
  document.querySelectorAll(".session-item").forEach((item) => item.classList.toggle("active", item.dataset.threadId === appState.threadId));
  updateComposer();
}

// ---------------------------------------------------------------------------
// Feed rendering
// ---------------------------------------------------------------------------
function selectHistoryThread(threadId, checkWriter = true) {
  if (threadActionPending || appState.threadAction || writerPending || deletedThreads.has(threadId)) return;
  const requestId = historyClientId + "-select-" + newClientId();
  if (!sendWs({ type: "readThread", threadId, historyMode: "paged", requestId, checkWriter })) return;
  writerConflict = null; writerChoice = null; $("writerSheet").classList.add("hidden");
  clearTimeout(pageTimer); pageRequest = null;
  clearTimeout(selectionTimer);
  pendingSelection = { requestId, threadId, checkWriter }; lastSelectionId = requestId;
  updateHistoryControls(); updateComposer();
  $("sessionsSheet").classList.add("hidden");
  selectionTimer = setTimeout(() => { pendingSelection = null; updateComposer(); updateHistoryControls("会话加载超时"); }, checkWriter ? 35000 : 20000);
}

function updateHistoryControls(message = "") {
  $("historyOlder").classList.toggle("hidden", !pagedHistory || !historyPages[oldestPage]?.nextCursor);
  $("historyNewer").classList.toggle("hidden", !pagedHistory || newestPage === 0);
  $("historyOlder").disabled = $("historyNewer").disabled = !!pageRequest || !!pendingSelection;
  $("historyStatus").textContent = message || (pendingSelection?.checkWriter ? "检查会话占用…" : pendingSelection || pageRequest ? "加载中…" : "");
  $("historyToolbar").classList.toggle("hidden", !message && !pendingSelection && !pageRequest && (!pagedHistory || (!historyPages[oldestPage]?.nextCursor && newestPage === 0)));
  $("scrollBottom").classList.toggle("hidden", followLatest && newestPage === 0);
  $("feed").setAttribute("aria-busy", String(!!pageRequest || !!pendingSelection));
}

function requestHistoryPage(index, reset = false) {
  if (pageRequest || pendingSelection || !appState.threadId) return;
  if (!reset && pageCache.has(index)) return;
  const cursor = index === 0 ? null : historyPages[index]?.cursor;
  if (index !== 0 && !cursor) { requestHistoryPage(0, true); return; }
  const requestId = historyClientId + "-page-" + newClientId();
  if (!sendWs({ type: "historyPage", threadId: appState.threadId, cursor, requestId })) return;
  pageRequest = { index, cursor, requestId, reset }; updateHistoryControls();
  pageTimer = setTimeout(() => { pageRequest = null; updateHistoryControls("历史加载超时，请重试"); }, 20000);
}

function receiveHistoryPage(m) {
  const request = pageRequest;
  clearTimeout(pageTimer); pageRequest = null;
  if (request.reset) { pageCache.clear(); historyPages = []; }
  historyPages[request.index] = { cursor: request.cursor, nextCursor: m.nextCursor };
  if (m.nextCursor) historyPages[request.index + 1] = { ...historyPages[request.index + 1], cursor: m.nextCursor };
  pageCache.set(request.index, m.events || []);
  while (pageCache.size > 3) {
    const farthest = [...pageCache.keys()].sort((a,b) => Math.abs(b - request.index) - Math.abs(a - request.index))[0];
    pageCache.delete(farthest);
  }
  // Only cursors survive eviction; very old navigation metadata is bounded too.
  for (const key of Object.keys(historyPages)) if (Math.abs(Number(key) - request.index) > 256) delete historyPages[key];
  newestPage = Math.min(...pageCache.keys()); oldestPage = Math.max(...pageCache.keys());
  followLatest = request.reset;
  showCachedHistory(request.reset); updateHistoryControls();
}

function showCachedHistory(bottom = followLatest) {
  const canonical = [...pageCache.keys()].sort((a,b) => b - a).flatMap(index => pageCache.get(index));
  const overlay = newestPage === 0 ? [...recentOverlay.values()] : [];
  const events = canonical.concat(overlay);
  const usersByTurn = new Map();
  for (const e of events) {
    if (e.kind !== "user" || !e.itemId || e.inputEcho || !e.turnId) continue;
    const key = JSON.stringify([e.threadId, e.turnId]);
    if (!usersByTurn.has(key)) usersByTurn.set(key, []);
    usersByTurn.get(key).push(e);
  }
  const replaced = new Map();
  for (const e of events) {
    if (!e.inputEcho || !e.turnId) continue;
    const candidates = usersByTurn.get(JSON.stringify([e.threadId, e.turnId])) || [];
    const saved = candidates.find(saved => (saved.textOffset || 0) === 0 && (saved.textLength ?? saved.text.length) === (e.textLength ?? e.text.length) && (saved.text.startsWith(e.text) || e.text.startsWith(saved.text)) && JSON.stringify((saved.images || []).map(i => i.id)) === JSON.stringify((e.images || []).map(i => i.id)));
    if (saved) replaced.set(e.id, saved);
  }
  // Replace the echo's identity in place so it remains an ordering anchor across page boundaries.
  if (replaced.size) {
    const anchored = [...recentOverlay.values()].map(e => replaced.get(e.id) || e);
    recentOverlay.clear();
    for (const e of anchored) recentOverlay.set(e.id, e);
  }
  for (const [index, page] of pageCache) pageCache.set(index, page.filter(e => !replaced.has(e.id)));
  historyFeed.replace(window.ChatUI.mergeMessageEvents(canonical.filter(e => !replaced.has(e.id)), overlay.map(e => replaced.get(e.id) || e)), bottom);
}

function replaceCachedEvent(event) {
  for (const events of pageCache.values()) {
    const index = events.findIndex(e => e.id === event.id);
    if (index >= 0) events[index] = event;
  }
  if (recentOverlay.has(event.id)) recentOverlay.set(event.id, event);
}

function loadOlderHistory() {
  const cursor = historyPages[oldestPage]?.nextCursor;
  if (!cursor) return;
  historyPages[oldestPage + 1] = { cursor };
  requestHistoryPage(oldestPage + 1);
}
$("historyOlder").onclick = loadOlderHistory;
$("historyNewer").onclick = () => requestHistoryPage(Math.max(0, newestPage - 1));

function addContentNavigation(div, e) {
  let nav = div.querySelector(".history-content-nav");
  const shownHead = !!e.live && div.dataset.previewMode === "head" && e.headText !== undefined;
  const offset = shownHead ? 0 : e.textOffset || 0, text = shownHead ? e.headText : e.text || "";
  const positions = { previous: Math.max(0, offset - 8192), next: offset + text.length, head: 0, tail: Math.max(0, e.textLength - 8192) };
  if (!nav) {
    nav = document.createElement("div"); nav.className = "history-content-nav";
    const label = document.createElement("span"); label.className = "content-range"; nav.append(label);
    for (const [mode, icon, title] of [["previous", "chevron-up", "上一段内容"], ["next", "chevron-down", "下一段内容"], ["head", "arrow-up", "查看开头"], ["tail", "arrow-down", "查看最新"]]) {
      const button = document.createElement("button"); button.className = "icon-btn"; button.title = title; button.setAttribute("aria-label", title); button.dataset.contentMode = mode;
      button.innerHTML = '<i data-lucide="' + icon + '"></i>';
      button.onclick = () => {
        const current = div._event;
        if (current.live && ["head", "tail"].includes(mode)) {
          div.dataset.previewMode = mode; setEventText(div, current); historyFeed.dirty.add(current.id); historyFeed.schedule(); return;
        }
        const start = current.textOffset || 0;
        const next = mode === "head" ? 0 : mode === "tail" ? Math.max(0, current.textLength - 8192) : mode === "previous" ? Math.max(0, start - 8192) : start + (current.text || "").length;
        const requestId = historyClientId + "-item-" + newClientId();
        if (!sendWs({ type: "readHistoryItem", threadId: appState.threadId, detailCursor: current.detailCursor, offset: next, requestId })) return;
        const timer = setTimeout(() => { itemRequests.delete(requestId); historyFeed.upsert({ ...current }); updateHistoryControls("内容加载超时，请重试"); }, 20000);
        itemRequests.set(requestId, { eventId: current.id, timer }); addContentNavigation(div, current);
      };
      nav.append(button);
    }
    div.append(nav); window.ChatUI.icons(nav);
  }
  nav.querySelector(".content-range").textContent = (e.live && !shownHead && e.preview === "tail" ? "最新 " : "内容 ") + (offset + 1) + "–" + (offset + text.length) + " / " + e.textLength;
  const busy = [...itemRequests.values()].some(r => r.eventId === e.id);
  for (const button of nav.querySelectorAll("button")) {
    const mode = button.dataset.contentMode, next = positions[mode];
    button.disabled = e.live ? !["head", "tail"].includes(mode) || e.headText === undefined || (mode === "head" ? shownHead : !shownHead) : !e.detailCursor || busy || next === offset || next >= e.textLength;
  }
}

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
  let photos = div.querySelector(".message-photos");
  if (e.kind === "user" && e.images?.length) {
    if (!photos) { photos = document.createElement("div"); photos.className = "message-photos"; body.before(photos); }
    if (photos._images !== e.images) { window.ImageAttachments.gallery(photos, e.images); photos._images = e.images; }
  } else photos?.remove();
  div._event = e;
  if (!e.live) delete div.dataset.previewMode;
  const head = !!e.live && div.dataset.previewMode === "head" && e.headText !== undefined;
  let text = (head ? e.headText : e.text) || "";
  if (e.kind === "item:reasoning" && !e.truncated && !text.trim()) text = e.live ? "等待可展示的思考内容" : "未收到可展示的思考内容";
  if (e.kind === "item:commandExecution" && e.outputStart !== undefined) text = text.slice(Math.max(0, e.outputStart - (head ? 0 : e.textOffset || 0)));
  div._copyText = text;
  if (body) {
    if (div.classList.contains("assistant")) {
      body.classList.add("markdown");
      if (e.live || e.truncated) {
        if (body.firstChild?.nodeType === Node.TEXT_NODE && body.childNodes.length === 1 && text.startsWith(body._source || "")) body.firstChild.appendData(text.slice((body._source || "").length));
        else body.textContent = text;
      } else {
        body.innerHTML = window.ChatUI.markdown(text);
        body.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
      }
    } else body.textContent = text;
    body._source = text;
    if (e.live && !div.classList.contains("assistant") && body._followOutput !== false) body.scrollTop = body.scrollHeight;
  }
  const summary = div.querySelector("summary");
  if (summary) {
    const titles = { "item:commandExecution": "命令", "item:fileChange": "文件变更", "item:reasoning": "思考", "item:webSearch": "搜索", "item:contextCompaction": "上下文压缩", "item:mcpToolCall": "工具", "item:dynamicToolCall": "工具", "item:collabAgentToolCall": "子任务" };
    const title = (titles[e.kind] || "执行记录") + (e.tool ? " · " + [e.server, e.tool].filter(Boolean).join("/") : "");
    summary.querySelector(".tool-title").textContent = title; summary.title = title;
    const status = summary.querySelector(".item-status");
    status.textContent = ({ running: "执行中", completed: "已完成", failed: "失败", interrupted: "已停止", ended: "已结束" })[e.status] || "";
    if (e.exitCode != null) status.textContent += " · exit " + e.exitCode;
    status.dataset.status = e.status || "";
  }
  const command = div.querySelector(".tool-command");
  if (command) { command.textContent = e.command || ""; command.classList.toggle("hidden", !e.command); }
  const fields = div.querySelector(".tool-fields");
  if (fields && fields._changes !== e.changes) {
    fields.replaceChildren(); fields._changes = e.changes;
    for (const change of e.changes || []) {
      const row = document.createElement("div"); row.className = "changed-file";
      const kind = document.createElement("span"); kind.textContent = change.changeKind || "修改";
      const name = document.createElement("span"); name.textContent = change.path; row.append(kind, name); fields.append(row);
    }
    if (e.changeCount > (e.changes?.length || 0)) { const more = document.createElement("div"); more.textContent = "共 " + e.changeCount + " 个文件"; fields.append(more); }
  }
  const error = div.querySelector(".tool-error");
  if (error) { error.textContent = e.error || ""; error.classList.toggle("hidden", !e.error); }
  if (e.truncated) addContentNavigation(div, e);
  else div.querySelector(".history-content-nav")?.remove();
  const copy = div.querySelector(".message-actions button");
  if (copy) { copy.title = e.truncated ? "复制当前段" : "复制回复"; copy.setAttribute("aria-label", copy.title); }
}

function createEventRow(e) {
  const div = document.createElement("div");
  div.className = "entry " + cls(e.kind);
  div.dataset.eventId = e.id || "";
  div.dataset.itemId = e.itemId || "";
  const lab = labelFor(e.kind);
  const collapsible = e.kind?.startsWith("item:") && !["item:agentMessage", "item:plan"].includes(e.kind);
  div.innerHTML = (lab ? '<div class="label">' + lab + '</div>' : "") + (collapsible ? '<details><summary><span class="tool-title"></span><span class="item-status"></span></summary><pre class="tool-command hidden"></pre><div class="tool-fields"></div><p class="tool-error hidden"></p><div class="body"></div></details>' : '<div class="body"></div>');
  if (collapsible) {
    const icon = document.createElement("i"); icon.dataset.lucide = "chevron-down"; icon.className = "tool-chevron";
    div.querySelector("summary").prepend(icon); window.ChatUI.icons(div.querySelector("summary"));
  }
  setEventText(div, e);
  div.querySelector(".body").addEventListener("scroll", event => {
    const body = event.currentTarget; body._followOutput = body.scrollHeight - body.scrollTop - body.clientHeight <= 2;
  }, { passive: true });
  if (cls(e.kind) === "assistant") addMessageActions(div);
  return div;
}

function renderEvent(e) {
  e = { ...e, id: e.id || newClientId() };
  const previous = historyFeed.events.find(event => event.live && e.kind === "item:agentMessage" && (!e.turnId || !event.turnId || e.turnId === event.turnId) && (!e.itemId || event.itemId === e.itemId));
  if (previous && previous.id !== e.id) {
    historyFeed.events = historyFeed.events.filter(event => event.id !== previous.id);
    recentOverlay.delete(previous.id);
  }
  if (!e.live && liveAssistant && (!e.itemId || liveAssistant.itemId === e.itemId)) liveAssistant = null;
  replaceCachedEvent(e);
  if (pagedHistory) {
    recentOverlay.set(e.id, e);
    const evicted = recentOverlay.size > 100;
    if (evicted) recentOverlay.delete(recentOverlay.keys().next().value);
    if (newestPage !== 0) return;
    if (e.live) {
      if (evicted) {
        const cached = new Set([...pageCache.values()].flatMap(page => page.map(event => event.id)));
        historyFeed.events = historyFeed.events.filter(event => cached.has(event.id) || recentOverlay.has(event.id));
      }
      historyFeed.upsert(e);
    } else showCachedHistory();
  } else historyFeed.upsert(e);
}

function appendAssistant(text, itemId, turnId) {
  liveAssistant = appendStreamItem({ text, itemId: itemId || "legacy-assistant", turnId }, "item:agentMessage");
}

function appendStreamItem(message, kind) {
  if (!message.itemId || typeof message.text !== "string" || !kind?.startsWith("item:")) return null;
  if (message.turnId && appState.turnId && message.turnId !== appState.turnId) return null;
  const turnId = message.turnId || appState.turnId, id = [appState.threadId, turnId, message.itemId].join(":");
  const previous = recentOverlay.get(id) || historyFeed.events.find(e => e.id === id);
  if (previous && (previous.live === false || ["completed", "failed", "interrupted", "ended"].includes(previous.status) || previous.kind !== kind)) return null;
  const base = previous || { id, kind, itemId: message.itemId, threadId: appState.threadId, turnId, text: "" };
  const event = kind === "item:reasoning" ? window.ChatUI.appendReasoningPreview(base, message.text, message.reasoningSource || "summary", pagedHistory ? 8192 : null) : window.ChatUI.appendTextPreview(base, message.text, pagedHistory ? 8192 : null);
  if (!event) return null;
  if (kind === "item:commandExecution") {
    event.output = event.text.slice(Math.max(0, (event.outputStart || 0) - (event.textOffset || 0))).slice(-8192);
    event.outputLength = (previous?.outputLength || 0) + message.text.length;
  }
  renderEvent(event);
  scrollFeed();
  return event;
}

function scrollFeed(force = false) {
  const f = $("feed");
  historyFeed.follow = followLatest || force;
  if (followLatest || force) { if (force) f.scrollTop = f.scrollHeight; followLatest = true; historyFeed.schedule(); }
  $("scrollBottom").classList.toggle("hidden", followLatest && newestPage === 0);
  $("emptyState").classList.toggle("hidden", historyFeed.events.length > 0);
}

function addMessageActions(div) {
  const actions = document.createElement("div"); actions.className = "message-actions";
  const copy = document.createElement("button"); copy.className = "icon-btn"; copy.title = div._event?.truncated ? "复制当前段" : "复制回复"; copy.setAttribute("aria-label", copy.title);
  copy.innerHTML = '<i data-lucide="copy"></i>';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(div._copyText ?? div._event?.text ?? "");
      copy.innerHTML = '<i data-lucide="check"></i>'; window.ChatUI.icons(copy); copy.title = "已复制";
      setTimeout(() => { copy.innerHTML = '<i data-lucide="copy"></i>'; window.ChatUI.icons(copy); copy.title = div._event?.truncated ? "复制当前段" : "复制回复"; }, 1800);
    } catch { copy.title = "复制失败，请选择文字复制"; }
  };
  actions.append(copy); div.append(actions); window.ChatUI.icons(actions);
}
$("feed").addEventListener("scroll", () => {
  // Near-bottom tracking would undo small upward wheel/touch movements.
  const f = $("feed"); followLatest = f.scrollHeight - f.scrollTop - f.clientHeight <= 1;
  historyFeed.follow = followLatest;
  if (pagedHistory && !pageRequest && !pendingSelection && f.scrollTop < 60 && historyFeed.events.length) loadOlderHistory();
  $("scrollBottom").classList.toggle("hidden", followLatest && newestPage === 0);
}, { passive: true });
$("scrollBottom").onclick = () => { if (pagedHistory && (newestPage > 0 || recentOverlay.size >= 100)) requestHistoryPage(0, true); else scrollFeed(true); };

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
function renderApproval(a) {
  if (document.querySelector(`[data-key="${a.key}"]`)) return;
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.key = a.key;
  const meta = [];
  if (a.cwd) meta.push(a.cwd);
  if (a.reason) meta.push(a.reason);
  if (a.note) meta.push(a.note);
  card.innerHTML =
    `<div class="ac-title">${escapeHtml(a.title)}</div>` +
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
const attachments = new window.ImageAttachments(() => updateComposer());
async function addImages(files) {
  if (attachments.locked || attachments.busy) return;
  if (!imageUploadSupported) { $("promptStatus").textContent = "当前中继不支持图片，请更新并重启电脑端服务"; return; }
  try { await attachments.add(files); $("promptStatus").textContent = ""; }
  catch (error) { $("promptStatus").textContent = error.message; }
}
$("attachImageBtn").onclick = () => $("imageInput").click();
$("imageInput").onchange = async () => { const files = Array.from($("imageInput").files); $("imageInput").value = ""; await addImages(files); };
input.addEventListener("paste", event => {
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addImages(files); }
});
const dropZone = document.querySelector(".composer-box");
dropZone.addEventListener("dragover", event => { if (Array.from(event.dataTransfer?.types || []).includes("Files")) { event.preventDefault(); dropZone.classList.add("drag-over"); } });
dropZone.addEventListener("dragleave", event => { if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("drag-over"); });
dropZone.addEventListener("drop", event => { event.preventDefault(); dropZone.classList.remove("drag-over"); addImages(event.dataTransfer.files); });
$("imageDialog").querySelector("button").onclick = () => $("imageDialog").close();
$("imageDialog").addEventListener("close", () => $("imageDialog").querySelector("img").removeAttribute("src"));
$("imageDialog").addEventListener("click", event => { if (event.target === $("imageDialog")) $("imageDialog").close(); });
function updateComposer() {
  const connected = sessionReady && !!(ws && ws.readyState === WebSocket.OPEN && appState.codexConnected) && (profile.mode !== "cloud" || (!!agentPub && paired));
  const managing = !!threadActionPending || !!appState.threadAction;
  const blocked = managing || (appState.status === "running" && !$("steerMode").checked && !promptQueueState?.supported);
  $("sendBtn").disabled = !connected || (!$("input").value.trim() && !attachments.items.length) || blocked || !!pendingSelection || !!pendingPrompt || attachments.busy || (attachments.items.length > 0 && !imageUploadSupported);
  const locked = !!pendingPrompt || !!pendingSelection || managing;
  if (attachments.locked !== locked) { attachments.locked = locked; attachments.render(); }
  $("attachImageBtn").disabled = !imageUploadSupported || locked || attachments.busy || attachments.items.length >= 4;
  $("steerMode").disabled = !!pendingPrompt;
  const queueSend = promptQueueState?.supported && !$("steerMode").checked && (appState.status === "running" || promptQueueState.paused || promptQueueState.items.length > 0);
  const sendLabel = queueSend ? "加入队列" : "发送消息";
  $("sendBtn").title = sendLabel; $("sendBtn").setAttribute("aria-label", sendLabel);
  const sendIcon = queueSend ? "list-plus" : "arrow-up";
  if ($("sendBtn").dataset.icon !== sendIcon) { $("sendBtn").dataset.icon = sendIcon; $("sendBtn").innerHTML = '<i data-lucide="' + sendIcon + '"></i>'; window.ChatUI.icons($("sendBtn")); }
  $("input").placeholder = $("steerMode").checked ? "补充当前任务" : queueSend ? "加入待执行队列" : "发送消息";
  $("retryPrompt").classList.toggle("hidden", !pendingPrompt || pendingPrompt.waiting);
  $("retryPrompt").disabled = !connected || !!pendingSelection || managing;
  $("queuePause").disabled = !connected || !!pendingSelection || managing;
  $("quickNewThread").disabled = $("sidebarNewThread").disabled = appState.status === "running" || !connected || managing;
  $("releaseThreadBtn").disabled = !threadManagement.release || !appState.threadId || !connected || appState.status === "running" || !!pendingSelection || !!pendingPrompt || managing || appState.writerReleased === true;
  document.querySelectorAll(".session-delete").forEach(button => { button.disabled = !threadManagement.delete || !connected || appState.status === "running" || !!pendingSelection || !!pendingPrompt || managing; });
  $("threadActionConfirm").disabled = !connected || managing || appState.status === "running" || !!pendingPrompt || !!pendingSelection;
  updateSettingsButtons();
}
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  updateComposer();
});

function sendPrompt() {
  const text = input.value.trim();
  if (!text && !attachments.items.length) return;
  if ($("sendBtn").disabled) return;
  const steer = $("steerMode").checked;
  const images = attachments.take(), imageIds = attachments.items.map(item => item.id);
  if (!steer && promptQueueState?.supported) {
    pendingPrompt = { type: "enqueuePrompt", text, ...(images.length ? { images } : {}), imageIds, threadId: appState.threadId || null, requestId: "prompt-" + newClientId(), waiting: true };
    submitQueuedPrompt(); return;
  }
  const requestId = "prompt-direct-" + newClientId();
  if (!sendWs({ type: steer ? "steer" : "prompt", text, requestId, ...(images.length ? { images } : {}) })) return;
  pendingDirect = { requestId, text, imageIds };
  if (!appState.readOnly) { input.value = ""; attachments.clear(imageIds); }
  input.style.height = "auto";
  updateComposer();
}

$("sendBtn").onclick = sendPrompt;
function submitQueuedPrompt() {
  if (!pendingPrompt) return;
  pendingPrompt.waiting = true;
  const { waiting, imageIds, ...message } = pendingPrompt;
  if (!sendWs(message)) { pendingPrompt.waiting = false; updateComposer(); return; }
  $("promptStatus").textContent = "等待受理…";
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => { if (pendingPrompt?.requestId !== message.requestId) return; pendingPrompt.waiting = false; $("promptStatus").textContent = "受理确认超时，消息可能已入队"; updateComposer(); }, 12000);
  updateComposer();
}
function acceptPrompt(requestId) {
  if (!pendingPrompt || pendingPrompt.requestId !== requestId) return;
  clearTimeout(promptTimer);
  if (input.value.trim() === pendingPrompt.text) { input.value = ""; input.style.height = "auto"; }
  attachments.clear(pendingPrompt.imageIds || []);
  pendingPrompt = null; $("promptStatus").textContent = ""; updateComposer();
}
function receivePromptQueue(queue) {
  if (!queue?.supported) return;
  if (pendingPrompt && queue.acceptedRequestIds?.includes(pendingPrompt.requestId)) acceptPrompt(pendingPrompt.requestId);
  if (queue.threadId !== appState.threadId) return;
  promptQueueState = queue; renderPromptQueue(); updateComposer();
}
function renderPromptQueue() {
  const queue = promptQueueState?.threadId === appState.threadId ? promptQueueState : null;
  $("queuePanel").classList.toggle("hidden", !queue || (!queue.items.length && !queue.paused));
  $("queueLabel").textContent = queue ? "待执行 " + queue.items.length + " 条" + (queue.paused ? " · 已暂停" : "") : "";
  $("queueReason").textContent = queue?.paused ? queue.reason : "";
  $("queueReason").classList.toggle("hidden", !queue?.paused || !queue.reason);
  const label = queue?.paused ? "继续队列" : "暂停队列";
  $("queuePause").title = label; $("queuePause").setAttribute("aria-label", label);
  $("queuePause").innerHTML = '<i data-lucide="' + (queue?.paused ? "play" : "pause") + '"></i>';
  $("queueToggle").setAttribute("aria-expanded", String(queueExpanded));
  $("queueToggle").title = queueExpanded ? "折叠待执行消息" : "展开待执行消息";
  $("queueToggle").setAttribute("aria-label", $("queueToggle").title);
  $("queueList").classList.toggle("hidden", !queueExpanded);
  $("queueList").replaceChildren();
  for (const [index, item] of (queue?.items || []).entries()) {
    const row = document.createElement("li"); row.dataset.queueId = item.id;
    const position = document.createElement("span"); position.className = "queue-position"; position.textContent = String(index + 1);
    const text = document.createElement("span"); text.className = "queue-message"; text.textContent = (item.status === "starting" ? "启动中 · " : "") + (item.text || "图片消息") + (item.images?.length ? " · " + item.images.length + " 张图片" : "");
    if (item.status === "starting") text.classList.add("queue-starting");
    const cancel = document.createElement("button"); cancel.className = "icon-btn"; cancel.title = "取消排队消息"; cancel.setAttribute("aria-label", cancel.title); cancel.innerHTML = '<i data-lucide="x"></i>';
    cancel.disabled = item.status !== "queued" || !sessionReady;
    cancel.onclick = () => queueAction("cancelQueuedPrompt", { id: item.id });
    row.append(position, text, cancel); $("queueList").append(row);
  }
  window.ChatUI.icons($("queuePanel"));
}
function queueAction(type, fields = {}) { sendWs({ type, threadId: appState.threadId, requestId: "queue-action-" + newClientId(), ...fields }); }
$("queuePause").onclick = () => queueAction(promptQueueState?.paused ? "resumeQueue" : "pauseQueue");
$("queueToggle").onclick = () => { queueExpanded = !queueExpanded; renderPromptQueue(); };
$("retryPrompt").onclick = submitQueuedPrompt;
input.addEventListener("keydown", (e) => {
  // Enter to send on hardware keyboards; Shift+Enter = newline.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt();
  }
});
$("interruptBtn").onclick = () => sendWs({ type: "interrupt" });
$("steerMode").onchange = () => { input.placeholder = $("steerMode").checked ? "补充当前任务" : "发送消息"; updateComposer(); };

// ---------------------------------------------------------------------------
// Settings sheet
// ---------------------------------------------------------------------------
function renderModelOptions(selected = $("cfgModel").value) {
  if (selected === "custom" && modelCatalog.some((m) => m.model === $("cfgCustomModel").value.trim())) selected = "model:" + $("cfgCustomModel").value.trim();
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
function selectedModelId() {
  const selected = $("cfgModel").value;
  return selected === "default" ? defaultModel : selected === "custom" ? $("cfgCustomModel").value.trim() : selected.slice(6);
}
function selectedEffort() { return $("cfgEffort").value === "custom" ? $("cfgCustomEffort").value.trim() : $("cfgEffort").value || null; }
function renderEffortOptions(selected = selectedEffort()) {
  const entry = modelCatalog.find((m) => m.model === selectedModelId());
  const known = Array.isArray(entry?.supportedReasoningEfforts);
  const levels = known ? entry.supportedReasoningEfforts.map((o) => o.reasoningEffort)
    : [...new Set([...Object.keys(effortNames), ...modelCatalog.flatMap((m) => (m.supportedReasoningEfforts || []).map((o) => o.reasoningEffort))])];
  const base = ($("cfgModel").value === "default" ? defaultReasoningEffort : null) || entry?.defaultReasoningEffort;
  const select = $("cfgEffort");
  select.replaceChildren(new Option(base ? "Codex 默认（" + effortName(base) + "）" : "Codex 默认", ""));
  levels.forEach((level) => select.add(new Option(effortName(level), level)));
  if (!known) select.add(new Option("自定义等级", "custom"));
  if (selected && !levels.includes(selected)) {
    if (!known) { $("cfgCustomEffort").value = selected; select.value = "custom"; }
    else select.value = "";
  } else select.value = selected || "";
  $("customEffortRow").classList.toggle("hidden", select.value !== "custom");
}
function updateSettingsButtons() {
  $("cfgApply").disabled = !!pendingConfig || !!threadActionPending || !!appState.threadAction;
  $("newThreadBtn").disabled = !!pendingConfig || !!threadActionPending || !!appState.threadAction || appState.status === "running";
}

function renderPermissions() {
  const permissions = appState.permissions;
  for (const id of ["permissionStatus", "cfgPermissionStatus"]) $(id).classList.toggle("hidden", !permissions?.supported);
  if (!permissions?.supported) return;
  const describe = value => value.sandbox + " · " + value.approvalPolicy;
  const selected = { sandbox: appState.sandbox || "workspace-write", approvalPolicy: appState.approvalPolicy || "on-request" };
  const current = permissions.applied ? "当前权限：" + describe(permissions.applied) : appState.threadId ? "当前权限：未确认" : "新任务权限：" + describe(selected);
  let status = current;
  if (permissions.applying) status += "\n正在同步权限";
  else if (permissions.error) status += "\n权限同步失败：" + permissions.error;
  else if (permissions.pending) status += "\n待生效：" + describe(selected) + (appState.status === "running" ? "（本轮结束后）" : appState.readOnly ? "（接续会话后）" : "");
  $("permissionStatus").textContent = permissions.error ? current + "\n权限同步失败：" + permissions.error.slice(0, 120) : status;
  $("cfgPermissionStatus").textContent = status;
}
function configError(message) {
  clearTimeout(configTimer);
  pendingConfig = null;
  $("cfgError").textContent = message;
  $("cfgError").classList.remove("hidden");
  updateSettingsButtons();
}
function openSettings(focus = "cfgModel") {
  renderPermissions();
  $("cfgCwd").value = appState.cwd || "";
  $("cfgApproval").value = appState.approvalPolicy || "on-request";
  $("cfgSandbox").value = appState.sandbox || "workspace-write";
  $("cfgCustomModel").value = appState.model || "";
  renderModelOptions(appState.model ? "model:" + appState.model : "default");
  renderEffortOptions(appState.reasoningEffort || null);
  $("cfgError").classList.add("hidden");
  $("sheet").classList.remove("hidden");
  $(focus).focus();
  requestModels();
}
$("menuBtn").onclick = () => openSettings();
$("modelBtn").onclick = () => openSettings("cfgModel");
$("effortBtn").onclick = () => openSettings("cfgEffort");
$("sidebarSettings").onclick = () => { $("sessionsSheet").classList.add("hidden"); openSettings(); };
$("cfgModel").onchange = () => {
  $("customModelRow").classList.toggle("hidden", $("cfgModel").value !== "custom");
  $("cfgError").classList.add("hidden");
  renderEffortOptions();
};
$("cfgCustomModel").oninput = () => { $("cfgError").classList.add("hidden"); renderEffortOptions(); };
$("cfgEffort").onchange = () => { $("customEffortRow").classList.toggle("hidden", $("cfgEffort").value !== "custom"); $("cfgError").classList.add("hidden"); };
$("cfgTheme").onchange = () => { localStorage.setItem("codexapp.theme", $("cfgTheme").value); applyTheme(); };
$("modelsRefresh").onclick = requestModels;
$("sheetClose").onclick = () => $("sheet").classList.add("hidden");
function saveSettings(newThread = false) {
  if (pendingConfig) return;
  const selected = $("cfgModel").value;
  const model = selected === "default" ? null : selected === "custom" ? $("cfgCustomModel").value.trim() : selected.slice(6);
  const reasoningEffort = selectedEffort();
  if (reasoningEffort && !/^[a-z][a-z0-9_-]{0,63}$/.test(reasoningEffort)) { configError("请输入有效的思考等级"); return; }
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
    reasoningEffort,
    cwd: $("cfgCwd").value.trim() || undefined,
    approvalPolicy: $("cfgApproval").value,
    sandbox: $("cfgSandbox").value,
  })) { configError("连接已断开，设置未保存"); return; }
  configTimer = setTimeout(() => configError("保存确认超时，请重新连接后检查设置"), 12000);
}
$("cfgApply").onclick = () => saveSettings();
$("newThreadBtn").onclick = () => saveSettings(true);
function quickNewThread() {
  if (appState.status === "running" || threadActionPending || appState.threadAction) return;
  if (sendWs({ type: "newThread" })) $("sessionsSheet").classList.add("hidden");
}
$("quickNewThread").onclick = $("sidebarNewThread").onclick = quickNewThread;
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
  const row = document.createElement("div"); row.className = "session-row";
  const item = document.createElement("button");
  item.className = "session-item nested";
  item.dataset.threadId = t.id;
  item.classList.toggle("active", t.id === appState.threadId);
  item.title = t.name || "无标题";
  const when = t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "";
  item.innerHTML =
    `<div class="s-name">${escapeHtml(t.name || "(无标题)")}</div>` +
    `<div class="s-meta">${escapeHtml(when)}</div>`;
  item.onclick = () => {
    selectHistoryThread(t.id);
  };
  const remove = document.createElement("button"); remove.className = "icon-btn session-delete";
  remove.title = "删除会话"; remove.setAttribute("aria-label", "删除会话：" + (t.name || "无标题")); remove.innerHTML = '<i data-lucide="trash-2"></i>';
  remove.onclick = () => openThreadAction("deleteThread", t.id, t.name);
  row.append(item, remove); return row;
}

function renderProjectTree(tree) {
  tree = { ...tree, projects: (tree.projects || []).map(project => ({ ...project, threads: project.threads.filter(t => !deletedThreads.has(t.id)) })), projectless: (tree.projectless || []).filter(t => !deletedThreads.has(t.id)) };
  lastProjectTree = tree;
  const query = $("sessionSearch").value.trim().toLowerCase();
  const list = $("sessionsList");
  list.innerHTML = "";
  const matches = (t) => !query || (t.name || "").toLowerCase().includes(query);
  const projects = (tree.projects || []).map((p) => ({ ...p, threads: p.label.toLowerCase().includes(query) ? p.threads : p.threads.filter(matches) })).filter((p) => !query || p.threads.length);
  const projectless = (tree.projectless || []).filter(matches);
  if (!projects.length && !projectless.length) { list.innerHTML = '<p class="muted small">' + (query ? "没有匹配的对话" : "没有会话") + '</p>'; return; }

  projects.forEach((p) => {
    const header = document.createElement("div");
    header.className = "session-group";
    header.innerHTML =
      `<div class="sg-name"><i data-lucide="folder"></i>${escapeHtml(p.label)} <span class="sg-count">${p.threads.length}</span></div>` +
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
    header.innerHTML = `<div class="sg-name"><i data-lucide="message-square"></i>对话 <span class="sg-count">${projectless.length}</span></div>`;
    list.appendChild(header);
    projectless.forEach((t) => list.appendChild(sessionItem(t)));
  }
  window.ChatUI.icons(list);
  updateComposer();
}
$("sessionSearch").oninput = () => { if (lastProjectTree) renderProjectTree(lastProjectTree); };

function openThreadAction(type, threadId, name) {
  if (threadActionPending || appState.threadAction) return;
  threadActionChoice = { type, threadId };
  const deleting = type === "deleteThread";
  $("threadActionTitle").textContent = deleting ? "删除会话" : "解除会话占用";
  $("threadActionName").textContent = name || "无标题会话";
  $("threadActionMessage").textContent = deleting
    ? "将永久删除此会话及其派生的子会话记录，同时取消相关待执行消息。删除后无法恢复，已修改的项目文件不会回滚。"
    : "暂停此会话的等待队列并释放当前中继的占用。必要时会重连中继自己的空闲控制进程，聊天记录和草稿保留。";
  $("threadActionError").textContent = "";
  $("threadActionConfirm").textContent = deleting ? "确认删除" : "确认解除";
  $("threadActionConfirm").className = "btn " + (deleting ? "danger" : "primary");
  updateComposer(); $("threadActionDialog").showModal(); $("threadActionCancel").focus();
}
$("releaseThreadBtn").onclick = () => openThreadAction("releaseThread", appState.threadId, appState.threadName);
$("threadActionCancel").onclick = () => $("threadActionDialog").close();
$("threadActionDialog").addEventListener("cancel", event => { if (threadActionPending) event.preventDefault(); });
$("threadActionConfirm").onclick = () => {
  if (!threadActionChoice || threadActionPending || $("threadActionConfirm").disabled) return;
  const message = { ...threadActionChoice, confirmed: true, requestId: "thread-action-" + newClientId() };
  if (!sendWs(message)) { $("threadActionError").textContent = "连接已断开，请重连后重试"; return; }
  threadActionPending = message; $("threadActionCancel").disabled = true;
  $("threadActionError").textContent = "处理中…";
  threadActionTimer = setTimeout(() => finishThreadAction("确认超时，操作结果尚未确定。请刷新会话列表核对，不会自动重试。"), 30000);
  updateComposer();
};
function finishThreadAction(error) {
  clearTimeout(threadActionTimer); threadActionPending = null; $("threadActionCancel").disabled = false;
  if (error) { $("threadActionError").textContent = error; $("threadActionStatus").textContent = error; }
  else { $("threadActionDialog").close(); threadActionChoice = null; }
  updateComposer();
}
function forgetDeletedThread(threadId) {
  deletedThreads.add(threadId);
  if (deletedThreads.size > 500) deletedThreads.delete(deletedThreads.values().next().value);
  if (pendingSelection?.threadId === threadId) { clearTimeout(selectionTimer); pendingSelection = null; lastSelectionId = null; }
  if (appState.threadId === threadId) {
    clearTimeout(pageTimer); pageRequest = null;
    for (const request of itemRequests.values()) clearTimeout(request.timer);
    itemRequests.clear(); pageCache.clear(); recentOverlay.clear(); historyPages = [];
    historyFeed.replace([], true); liveAssistant = null; pagedHistory = false;
    appState = { ...appState, threadId: null, turnId: null, threadName: null, status: "idle", readOnly: false, writerReleased: false };
    promptQueueState = null; setDiff(""); $("approvals").replaceChildren();
    applyState(); renderPromptQueue(); updateHistoryControls();
  }
  if (pendingPrompt?.threadId === threadId) { clearTimeout(promptTimer); pendingPrompt = null; }
  if (lastProjectTree) renderProjectTree(lastProjectTree);
  updateComposer();
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
  $("writerTitle").textContent = writerConflict.inspectionFailed ? "占用检查失败" : "会话被其他进程占用";
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
$("writerReadOnly").onclick = () => { if (writerConflict && !writerPending) selectHistoryThread(writerConflict.threadId, false); };

// ---------------------------------------------------------------------------
// Service worker + boot
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.querySelectorAll(".sheet").forEach((sheet) => sheet.addEventListener("click", (e) => { if (e.target === sheet && !writerPending) sheet.classList.add("hidden"); }));
document.addEventListener("keydown", (e) => {
  const sheets = [...document.querySelectorAll(".sheet:not(.hidden)")];
  const sheet = sheets.at(-1);
  if (!sheet) return;
  if (e.key === "Escape" && !writerPending) { sheet.classList.add("hidden"); $("menuBtn").focus(); }
  if (e.key === "Tab") {
    const controls = [...sheet.querySelectorAll("button:not(:disabled), input, select, textarea, [tabindex='0']")].filter((el) => el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
function syncViewport() { document.documentElement.style.setProperty("--app-height", (window.visualViewport?.height || window.innerHeight) + "px"); }
window.visualViewport?.addEventListener("resize", syncViewport);
syncViewport(); applyTheme(); window.ChatUI.icons(); updateComposer(); start();
