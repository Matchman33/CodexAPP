// Verify broker account validation, signed tokens and WebSocket authentication.
// Usage: node cloud/test-auth.mjs   (broker must run on $B, default :8790)
import fs from "node:fs";
import { WebSocket } from "ws";

const B = process.env.B || "http://127.0.0.1:8790";
const post = async (path, body) => {
  const r = await fetch(B + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const wsAuth = (token) => new Promise((resolve) => {
  const w = new WebSocket(B.replace(/^http/, "ws") + "/link");
  w.on("open", () => w.send(JSON.stringify({ type: "auth", token, role: "phone", pubkey: "x" })));
  w.on("message", (d) => { const m = JSON.parse(d); resolve(m.type === "authed" ? "authed" : "err:" + (m.message || "")); w.close(); });
  w.on("error", () => resolve("wserr"));
  setTimeout(() => resolve("timeout"), 3000);
});

const email = "hard" + Date.now() + "@example.com";
const r = (label, got, want) => console.log(`${got === want ? "OK ✓" : "FAIL"}  ${label}: ${got} (want ${want})`);

r("bad email -> 400", (await post("/api/login", { email: "nope", password: "longenough" })).status, 400);
r("short password -> 400", (await post("/api/login", { email, password: "short" })).status, 400);

const ok = await post("/api/login", { email, password: "password123" }); // autoregister
r("valid login -> 200", ok.status, 200);
const token = ok.body.token;
console.log(token && token.split(".").length === 2 ? "OK ✓  token shape payload.sig" : "FAIL token shape");

r("WS auth (valid token)", await wsAuth(token), "authed");
r("WS auth (tampered token)", await wsAuth(token.slice(0, -3) + "xxx"), "err:invalid token");
r("WS auth (garbage)", await wsAuth("garbage"), "err:invalid token");

fs.writeFileSync(new URL("./.last-token.txt", import.meta.url), token);
console.log("saved token -> cloud/.last-token.txt (for restart test)");
process.exit(0);
