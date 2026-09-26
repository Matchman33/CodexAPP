import fs from "node:fs";
import readline from "node:readline";
if (process.argv[1]?.endsWith("app-server")) {
  const send = m => process.stdout.write(JSON.stringify(m) + "\n");
  const lines = readline.createInterface({ input: process.stdin });
  let active = null;
  lines.on("line", raw => {
    const m = JSON.parse(raw); if (m.id === undefined) return;
    fs.appendFileSync("calls.jsonl", JSON.stringify({ ...m, pid: process.pid }) + "\n");
    let result = {}, p = m.params || {};
    if (m.method === "initialize") result = { userAgent: "restart-fixture" };
    if (m.method === "config/read") result = { config: { model: "fixture" } };
    if (m.method === "model/list") result = { data: [{ model: "fixture", isDefault: true }] };
    if (["thread/start", "thread/read", "thread/resume"].includes(m.method)) result = { thread: { id: p.threadId || "one", cwd: process.cwd(), turns: [] } };
    if (m.method === "thread/turns/list") result = { data: [], nextCursor: null };
    if (m.method === "turn/start") { active = { threadId: p.threadId, turn: { id: "turn-" + Date.now(), status: "inProgress" } }; result = { turn: active.turn }; }
    send({ id: m.id, result });
  });
  const poll = setInterval(() => {
    if (active && fs.existsSync("finish-turn")) {
      fs.unlinkSync("finish-turn"); active.turn.status = "completed";
      send({ method: "turn/completed", params: active }); active = null;
    }
  }, 30);
  lines.on("close", () => { clearInterval(poll); process.exit(0); });
  await new Promise(() => {});
}
