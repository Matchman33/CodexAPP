// CodexApp cloud broker (v1).
//
// A dumb, account-authenticated message router. The PC agent and the phone
// each connect OUTBOUND to this server (so it works behind any NAT, no port
// forwarding). The broker matches them by account and forwards their
// END-TO-END-ENCRYPTED envelopes — it never sees plaintext.
//
//   [phone] --WSS /link--> [BROKER] <--WSS /link-- [PC agent]
//                          (auth + route ciphertext)
//
// Run:  node cloud/broker.mjs
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as db from "./db.mjs";
import { sendVerifyEmail, sendResetEmail, emailConfigured, testSmtp, getSmtpConfig } from "./mailer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const SECRET_FILE = path.join(__dirname, "broker.secret");
const WEB_DIR = path.join(__dirname, "..", "web"); // broker hosts the web client
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || "0.0.0.0";
// TLS: set TLS_CERT + TLS_KEY (PEM paths) for wss/https; otherwise plain ws/http.
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // set to enable the /admin backend
// Dev convenience: auto-create an account on first login. Disable in prod.
// ---- accounts (SQLite) + signed tokens + email verification ----
const migrated = db.migrateFromJson(ACCOUNTS_FILE); // one-time import from legacy accounts.json
if (migrated) console.log(`[broker] migrated ${migrated} accounts from accounts.json -> SQLite`);
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000; // password-reset links expire in 1 hour
const newVerifyToken = () => crypto.randomBytes(24).toString("base64url");
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${req.headers.host}`;
}

// Server secret signs tokens; persisted so tokens survive broker restarts.
function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE); } catch {}
  const s = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, s);
  return s;
}
const SECRET = loadSecret();
const TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 days

function signToken(accountId) {
  const payload = Buffer.from(JSON.stringify({ sub: accountId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}
function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let p; try { p = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return null; }
  if (!p.sub || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
  return p.sub;
}

function hashPw(password, salt) { return crypto.scryptSync(password, salt, 32).toString("hex"); }
function validEmail(e) { return typeof e === "string" && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }
function validPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 200; }
function eq(a, b) { return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }

function register(email, password) {
  if (db.getByEmail(email)) return { error: "exists" };
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(16).toString("hex");
  const token = newVerifyToken();
  db.createAccount({ id, email, salt, hash: hashPw(password, salt), email_verified: 0, verify_token: token, verify_expires: Date.now() + VERIFY_TTL_MS, created_at: Date.now() });
  if (TRIAL_DAYS > 0) db.setMembership(id, Date.now() + TRIAL_DAYS * DAY_MS); // free trial
  return { accountId: id, verifyToken: token };
}
function login(email, password) {
  const acc = db.getByEmail(email);
  if (!acc || !eq(hashPw(password, acc.salt), acc.hash)) return { ok: false, code: "invalid" };
  if (!acc.email_verified) return { ok: false, code: "unverified" };
  return { ok: true, token: signToken(acc.id), accountId: acc.id, membershipUntil: acc.membership_until || 0 };
}
function issueVerify(email) {
  const acc = db.getByEmail(email);
  if (!acc || acc.email_verified) return null;
  const token = newVerifyToken();
  db.setVerifyToken(acc.id, token, Date.now() + VERIFY_TTL_MS);
  return token;
}
function issueReset(email) {
  const acc = db.getByEmail(email);
  if (!acc) return null; // any existing account; completing the reset also verifies it
  const token = newVerifyToken();
  db.setResetToken(acc.id, token, Date.now() + RESET_TTL_MS);
  return token;
}

// ---- membership (cloud only; LAN mode never touches the broker, so it's free) ----
const LIFETIME_TS = 4102444800000; // 2100-01-01: "lifetime" membership sentinel
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 7); // free trial on registration
const DAY_MS = 86400000;
const isMember = (acc) => !!acc && (acc.membership_until || 0) > Date.now();

// Human-friendly code, no ambiguous chars (0/O/1/I/L). e.g. CDX-ABCD-EFGH-JKMN
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode() {
  const b = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return `CDX-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
function redeem(accountId, codeRaw) {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!code) return { error: "请输入兑换码" };
  const c = db.getCode(code);
  if (!c) return { error: "兑换码无效" };
  if (c.redeemed_by) return { error: "兑换码已被使用" };
  if (c.expires_at && c.expires_at < Date.now()) return { error: "兑换码已过期" };
  if (!db.redeemCode(code, accountId, Date.now())) return { error: "兑换码已被使用" }; // lost the atomic race
  const acc = db.getById(accountId);
  const base = Math.max(Date.now(), acc.membership_until || 0); // stack onto remaining time
  const until = c.lifetime ? LIFETIME_TS : base + (c.days | 0) * DAY_MS;
  db.setMembership(accountId, until);
  return { ok: true, membershipUntil: until };
}

// ---- login/register rate limiting (per IP+email sliding window) ----
const attempts = new Map();
const RL_WINDOW = 15 * 60 * 1000, RL_MAX = 8;
function rateLimited(key) {
  const now = Date.now();
  const arr = (attempts.get(key) || []).filter((t) => now - t < RL_WINDOW);
  arr.push(now);
  attempts.set(key, arr);
  return arr.length > RL_MAX;
}

// ---- routing: accountId -> { agent, phone } (one of each for v1) ----
const rooms = new Map();
function room(id) { if (!rooms.has(id)) rooms.set(id, { agent: null, phone: null }); return rooms.get(id); }
const peerRole = (r) => (r === "agent" ? "phone" : "agent");

function verifyPage(title, msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CodexApp</title>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1220;color:#e6ecf7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="max-width:420px;padding:32px;text-align:center">
<h1 style="font-size:22px">${title}</h1><p style="color:#8a98b8">${msg}</p>
<a href="/" style="display:inline-block;margin-top:16px;background:#35d07f;color:#042;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">打开 CodexApp</a>
</div></body>`;
}

// Server-rendered "set a new password" page (reached from the reset email link).
function resetPage(token) {
  const t = String(token).replace(/[^A-Za-z0-9_-]/g, ""); // base64url charset; safe to embed
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>重置密码 · CodexApp</title>
<body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1220;color:#e6ecf7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="width:100%;max-width:380px;padding:32px">
<h1 style="font-size:22px;text-align:center">设置新密码</h1>
<label style="display:block;font-size:13px;color:#8a98b8;margin:16px 0 6px">新密码（至少 8 位）</label>
<input id="pw" type="password" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #26314d;border-radius:10px;background:#121a2c;color:#e6ecf7;font-size:15px">
<label style="display:block;font-size:13px;color:#8a98b8;margin:14px 0 6px">再次输入</label>
<input id="pw2" type="password" style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #26314d;border-radius:10px;background:#121a2c;color:#e6ecf7;font-size:15px">
<button id="go" style="width:100%;margin-top:18px;background:#35d07f;color:#042;padding:13px;border:0;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer">确认重置</button>
<p id="msg" style="color:#8a98b8;font-size:13px;min-height:18px;margin:12px 0 0;text-align:center"></p>
</div>
<script>
const $=id=>document.getElementById(id), TOKEN=${JSON.stringify(t)};
$("go").onclick=async()=>{
  const pw=$("pw").value, pw2=$("pw2").value, msg=$("msg");
  if(pw.length<8){msg.textContent="密码至少 8 位";return;}
  if(pw!==pw2){msg.textContent="两次输入不一致";return;}
  $("go").disabled=true; msg.textContent="提交中…";
  try{
    const r=await fetch("/api/reset-password",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:TOKEN,password:pw})});
    const j=await r.json().catch(()=>({}));
    if(r.ok){document.querySelector("div").innerHTML='<h1 style=\\"font-size:22px;text-align:center\\">✅ 密码已重置</h1><p style=\\"color:#8a98b8;text-align:center\\">现在可以用新密码登录了。</p><a href=\\"/\\" style=\\"display:block;margin-top:16px;background:#35d07f;color:#042;padding:12px;border-radius:10px;text-decoration:none;font-weight:700;text-align:center\\">去登录</a>';}
    else{msg.textContent="失败："+(j.error||r.status); $("go").disabled=false;}
  }catch(e){msg.textContent="网络错误："+e.message; $("go").disabled=false;}
};
</script></body>`;
}

// ---- admin backend (gated by ADMIN_TOKEN) ----
function readBody(req) {
  return new Promise((resolve) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 8192) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}
function adminOk(req) {
  const t = String(req.headers["x-admin-token"] || "");
  return !!ADMIN_TOKEN && t.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN));
}
async function handleAdmin(req, res) {
  res.setHeader("content-type", "application/json");
  if (!ADMIN_TOKEN) { res.writeHead(503); return res.end(JSON.stringify({ error: "admin 未启用：请在 broker.env 设置 ADMIN_TOKEN 后重启" })); }
  if (!adminOk(req)) { res.writeHead(401); return res.end(JSON.stringify({ error: "无效管理员令牌" })); }
  const p = new URL(req.url, "http://localhost").pathname;
  const G = req.method === "GET", P = req.method === "POST";

  if (P && p === "/api/admin/login") return res.end(JSON.stringify({ ok: true }));

  if (G && p === "/api/admin/smtp") {
    const c = getSmtpConfig();
    return res.end(JSON.stringify({ host: c.host, port: c.port, user: c.user, from: c.from, fromName: c.fromName, secure: c.secure, hasPass: !!c.pass }));
  }
  if (P && p === "/api/admin/smtp") {
    const b = await readBody(req);
    db.setSetting("smtp_host", b.host || "");
    db.setSetting("smtp_port", String(b.port || 587));
    db.setSetting("smtp_user", b.user || "");
    if (b.pass) db.setSetting("smtp_pass", b.pass); // blank = keep current
    db.setSetting("smtp_from", b.from || "");
    db.setSetting("smtp_from_name", b.fromName || "");
    db.setSetting("smtp_secure", b.secure ? "1" : "0");
    return res.end(JSON.stringify({ ok: true }));
  }
  if (P && p === "/api/admin/smtp/test") {
    const b = await readBody(req);
    return res.end(JSON.stringify(await testSmtp(b.to || "")));
  }

  if (G && p === "/api/admin/overview") {
    const online = [];
    for (const [aid, r] of rooms) {
      if (!r.agent && !r.phone) continue;
      const acc = db.getById(aid);
      online.push({ email: acc ? acc.email : aid.slice(0, 8), agent: !!r.agent, phone: !!r.phone });
    }
    const users = db.listAccounts(200).map((u) => ({ id: u.id, email: u.email, verified: !!u.email_verified, membershipUntil: u.membership_until || 0, createdAt: u.created_at }));
    return res.end(JSON.stringify({ counts: db.counts(), online, users, lifetimeTs: LIFETIME_TS }));
  }
  if (P && p === "/api/admin/user/verify") { const b = await readBody(req); if (b.id) db.setVerified(b.id); return res.end(JSON.stringify({ ok: true })); }
  if (P && p === "/api/admin/user/resend") {
    const b = await readBody(req);
    const token = b.email && issueVerify(b.email);
    if (token) { try { await sendVerifyEmail(b.email, baseUrl(req) + "/verify?token=" + token); } catch (e) { console.error(e.message); } }
    return res.end(JSON.stringify({ ok: true }));
  }
  if (P && p === "/api/admin/user/delete") {
    const b = await readBody(req);
    if (b.id) {
      const r = rooms.get(b.id);
      if (r) { try { r.agent && r.agent.close(); r.phone && r.phone.close(); } catch {} }
      db.deleteAccount(b.id);
    }
    return res.end(JSON.stringify({ ok: true }));
  }

  // Set/extend/revoke a user's membership.
  if (P && p === "/api/admin/user/membership") {
    const b = await readBody(req);
    const acc = b.id && db.getById(b.id);
    if (!acc) { res.writeHead(404); return res.end(JSON.stringify({ error: "账号不存在" })); }
    let until;
    if (b.revoke) until = 0;
    else if (b.lifetime) until = LIFETIME_TS;
    else { const base = Math.max(Date.now(), acc.membership_until || 0); until = base + (Number(b.addDays) || 0) * DAY_MS; }
    db.setMembership(acc.id, until);
    return res.end(JSON.stringify({ ok: true, membershipUntil: until }));
  }

  // Generate redemption codes.
  if (P && p === "/api/admin/codes/generate") {
    const b = await readBody(req);
    const count = Math.max(1, Math.min(500, Number(b.count) || 1));
    const lifetime = !!b.lifetime;
    const days = lifetime ? 0 : Math.max(1, Math.min(36500, Number(b.days) || 30));
    const expiresAt = Number(b.expiresAt) > 0 ? Number(b.expiresAt) : null; // code redemption deadline; null = never
    const note = (b.note || "").toString().slice(0, 120);
    const out = [];
    for (let i = 0; i < count; i++) {
      let code, tries = 0;
      do { code = genCode(); tries++; } while (db.getCode(code) && tries < 5);
      try { db.createCode({ code, days, lifetime, note, created_at: Date.now(), expires_at: expiresAt }); out.push(code); } catch {}
    }
    return res.end(JSON.stringify({ ok: true, codes: out, days, lifetime, expiresAt }));
  }
  // List recent codes + stats.
  if (G && p === "/api/admin/codes") {
    const codes = db.listCodes(300).map((c) => ({
      code: c.code, days: c.days, lifetime: !!c.lifetime, note: c.note || "",
      createdAt: c.created_at, expiresAt: c.expires_at || 0, used: !!c.redeemed_by, redeemedAt: c.redeemed_at || 0,
    }));
    return res.end(JSON.stringify({ stats: db.codeStats(), codes }));
  }

  res.writeHead(404); res.end(JSON.stringify({ error: "未知接口" }));
}

// ---- HTTP(S) (auth + verification + web hosting) ----
function requestHandler(req, res) {
  if (req.url.startsWith("/api/admin")) return handleAdmin(req, res);
  if (req.method === "POST" && (req.url === "/api/login" || req.url === "/api/register" || req.url === "/api/resend-verification" || req.url === "/api/forgot-password")) {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0].trim();
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", async () => {
      let p; try { p = JSON.parse(body || "{}"); } catch { p = {}; }
      res.setHeader("content-type", "application/json");
      if (!validEmail(p.email)) { res.writeHead(400); return res.end(JSON.stringify({ error: "无效邮箱" })); }
      if (rateLimited(ip + "|" + p.email)) { res.writeHead(429); return res.end(JSON.stringify({ error: "尝试过于频繁，请稍后再试" })); }

      if (req.url === "/api/resend-verification") {
        const token = issueVerify(p.email);
        if (token) { try { await sendVerifyEmail(p.email, baseUrl(req) + "/verify?token=" + token); } catch (e) { console.error("[mail]", e.message); } }
        return res.end(JSON.stringify({ ok: true })); // don't reveal whether the account exists
      }

      if (req.url === "/api/forgot-password") {
        const token = issueReset(p.email);
        if (token) { try { await sendResetEmail(p.email, baseUrl(req) + "/reset?token=" + token); } catch (e) { console.error("[mail]", e.message); } }
        return res.end(JSON.stringify({ ok: true })); // don't reveal whether the account exists
      }

      if (!validPassword(p.password)) { res.writeHead(400); return res.end(JSON.stringify({ error: "密码至少 8 位" })); }

      if (req.url === "/api/register") {
        const r = register(p.email, p.password);
        if (r.error === "exists") { res.writeHead(409); return res.end(JSON.stringify({ error: "账号已存在" })); }
        try { await sendVerifyEmail(p.email, baseUrl(req) + "/verify?token=" + r.verifyToken); } catch (e) { console.error("[mail]", e.message); }
        return res.end(JSON.stringify({ ok: true, needVerify: true, emailSent: emailConfigured() }));
      }

      const r = login(p.email, p.password);
      if (!r.ok && r.code === "unverified") { res.writeHead(403); return res.end(JSON.stringify({ error: "请先验证邮箱（查收验证邮件）", code: "unverified" })); }
      if (!r.ok) { res.writeHead(401); return res.end(JSON.stringify({ error: "邮箱或密码错误" })); }
      res.end(JSON.stringify({ token: r.token, accountId: r.accountId, membershipUntil: r.membershipUntil }));
    });
    return;
  }

  // Set a new password using a valid reset token (from the email link).
  if (req.method === "POST" && req.url === "/api/reset-password") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0].trim();
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let p; try { p = JSON.parse(body || "{}"); } catch { p = {}; }
      res.setHeader("content-type", "application/json");
      if (rateLimited("reset|" + ip)) { res.writeHead(429); return res.end(JSON.stringify({ error: "尝试过于频繁，请稍后再试" })); }
      const acc = p.token && db.getByResetToken(p.token);
      if (!acc || !acc.reset_expires || acc.reset_expires < Date.now()) { res.writeHead(400); return res.end(JSON.stringify({ error: "重置链接无效或已过期" })); }
      if (!validPassword(p.password)) { res.writeHead(400); return res.end(JSON.stringify({ error: "密码至少 8 位" })); }
      const salt = crypto.randomBytes(16).toString("hex");
      db.updatePassword(acc.id, salt, hashPw(p.password, salt));
      return res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Redeem a membership code (auth via the JWT issued at login).
  if (req.method === "POST" && req.url === "/api/redeem") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0].trim();
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let p; try { p = JSON.parse(body || "{}"); } catch { p = {}; }
      res.setHeader("content-type", "application/json");
      if (rateLimited("redeem|" + ip)) { res.writeHead(429); return res.end(JSON.stringify({ error: "尝试过于频繁，请稍后再试" })); }
      const accountId = verifyToken(p.token);
      if (!accountId) { res.writeHead(401); return res.end(JSON.stringify({ error: "登录已失效，请重新登录" })); }
      const r = redeem(accountId, p.code);
      if (r.error) { res.writeHead(400); return res.end(JSON.stringify({ error: r.error })); }
      return res.end(JSON.stringify({ ok: true, membershipUntil: r.membershipUntil }));
    });
    return;
  }

  // Password-reset link → render the "set new password" page.
  if (req.method === "GET" && req.url.startsWith("/reset")) {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token") || "";
    const acc = token && db.getByResetToken(token);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!acc || !acc.reset_expires || acc.reset_expires < Date.now()) {
      res.writeHead(400);
      return res.end(verifyPage("⚠ 链接无效或已过期", "重置链接有效期为 1 小时。请回到登录页重新点「忘记密码」。"));
    }
    return res.end(resetPage(token));
  }

  // Email verification link.
  if (req.method === "GET" && req.url.startsWith("/verify")) {
    const url = new URL(req.url, "http://localhost");
    const acc = url.searchParams.get("token") && db.getByVerifyToken(url.searchParams.get("token"));
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (acc && (!acc.verify_expires || acc.verify_expires > Date.now())) {
      db.setVerified(acc.id);
      return res.end(verifyPage("✅ 邮箱验证成功", "账号已激活，现在可以在网页或 App 登录了。"));
    }
    res.writeHead(400);
    return res.end(verifyPage("⚠ 链接无效或已过期", "请回到登录页重新发送验证邮件。"));
  }

  if (req.url === "/health") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
  // Host the web client (so users just open https://<broker>/ and log in).
  if (req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
    const filePath = path.join(WEB_DIR, path.normalize(p).replace(/^(\.\.[\\/])+/, ""));
    if (filePath.startsWith(WEB_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
      return fs.createReadStream(filePath).pipe(res);
    }
  }
  res.writeHead(404); res.end("not found");
}

const useTls = TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);
const scheme = useTls ? "https/wss" : "http/ws";
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, requestHandler)
  : http.createServer(requestHandler);

// ---- WebSocket link ----
const wss = new WebSocketServer({ server, path: "/link", maxPayload: 12 * 1048576 });

function sendJson(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }

wss.on("connection", (ws) => {
  ws.on("error", () => {});
  ws.accountId = null; ws.role = null;

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }

    // First message must authenticate.
    if (!ws.accountId) {
      if (m.type !== "auth") { sendJson(ws, { type: "error", message: "auth required" }); return ws.close(4001); }
      const accountId = verifyToken(m.token);
      if (!accountId) { sendJson(ws, { type: "error", message: "invalid token" }); return ws.close(4001); }
      if (m.role !== "agent" && m.role !== "phone") { sendJson(ws, { type: "error", message: "bad role" }); return ws.close(4002); }
      // Membership gate: cloud relay requires an active membership. LAN mode does
      // not go through the broker, so it stays free regardless.
      const acct = db.getById(accountId);
      if (!isMember(acct)) {
        sendJson(ws, { type: "error", code: "membership_required", message: "云端会员未开通或已过期，请用兑换码开通后使用（局域网模式免费）。" });
        return ws.close(4003);
      }
      ws.accountId = accountId; ws.role = m.role; ws.pubkey = m.pubkey || null;
      const rm = room(accountId);
      rm[m.role] = ws;
      const peer = rm[peerRole(m.role)];
      sendJson(ws, { type: "authed", role: m.role, peerOnline: !!peer, peerPubkey: peer?.pubkey || null });
      // Tell the peer we're online + our pubkey (for E2E key exchange).
      if (peer) sendJson(peer, { type: "peer", online: true, pubkey: ws.pubkey });
      console.log(`[broker] ${m.role} online for ${accountId.slice(0, 8)} (peer ${peer ? "online" : "offline"})`);
      return;
    }

    // After auth: only forward E2E envelopes to the peer. Broker can't read them.
    if (m.type === "e2e") {
      const rm = rooms.get(ws.accountId);
      const peer = rm && rm[peerRole(ws.role)];
      if (peer) sendJson(peer, { type: "e2e", from: ws.role, nonce: m.nonce, box: m.box });
      else sendJson(ws, { type: "peer", online: false });
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.accountId) return;
    const rm = rooms.get(ws.accountId);
    if (rm && rm[ws.role] === ws) {
      rm[ws.role] = null;
      const peer = rm[peerRole(ws.role)];
      if (peer) sendJson(peer, { type: "peer", online: false });
      if (!rm.agent && !rm.phone) rooms.delete(ws.accountId);
      console.log(`[broker] ${ws.role} offline for ${ws.accountId.slice(0, 8)}`);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`CodexApp broker [${scheme}] on ${HOST}:${PORT}  email=${emailConfigured() ? "SMTP" : "console-log (dev)"}  admin=${ADMIN_TOKEN ? "on" : "off (set ADMIN_TOKEN)"}`);
});
