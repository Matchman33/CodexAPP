import fs from "node:fs";
import readline from "node:readline";

// 仅在临时目录中的 app-server 子进程启用，不运行模型、命令或真实历史。
if (process.argv[1]?.endsWith("app-server")) {
  const stored = "threads.json";
  const initial = ["one", "two", "child", "busy"].map(id => ({ id, name: ({ one: "需要交接的会话", two: "待删除的会话", child: "派生子会话", busy: "外部运行中的会话" })[id], cwd: "/fixture", status: { type: id === "busy" ? "active" : "idle" }, turns: [], updatedAt: 100 }));
  if (!fs.existsSync(stored)) fs.writeFileSync(stored, JSON.stringify(initial));
  const threads = new Map(JSON.parse(fs.readFileSync(stored, "utf8")).map(t => [t.id, t]));
  const loaded = new Set();
  const send = message => process.stdout.write(JSON.stringify(message) + "\n");
  const save = () => fs.writeFileSync(stored, JSON.stringify([...threads.values()]));
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", raw => {
    const m = JSON.parse(raw); if (m.id === undefined) return;
    fs.appendFileSync("calls.jsonl", JSON.stringify({ ...m, pid: process.pid }) + "\n");
    const p = m.params || {}; let result = {};
    try {
      switch (m.method) {
        case "initialize": result = { userAgent: "lifecycle-fixture" }; break;
        case "config/read": result = { config: { model: "fixture-model" } }; break;
        case "model/list": result = { data: [{ model: "fixture-model", isDefault: true }], nextCursor: null }; break;
        case "thread/list": result = { data: [...threads.values()], nextCursor: null }; break;
        case "thread/read":
        case "thread/resume": {
          const thread = threads.get(p.threadId); if (!thread) throw new Error("not found");
          if (m.method === "thread/resume") loaded.add(p.threadId);
          result = { thread }; break;
        }
        case "thread/turns/list": result = { data: (threads.get(p.threadId)?.turns || []).slice().reverse(), nextCursor: null }; break;
        case "thread/items/list": result = { data: (threads.get(p.threadId)?.turns.find(t => t.id === p.turnId)?.items || []).slice().reverse(), nextCursor: null }; break;
        case "thread/loaded/list": result = { data: [...loaded], nextCursor: null }; break;
        case "thread/unsubscribe": result = { status: loaded.has(p.threadId) ? "unsubscribed" : "notLoaded" }; break;
        case "thread/delete": {
          if (fs.existsSync("fail-delete")) throw new Error("fixture delete failure");
          for (const id of p.threadId === "one" ? ["one", "child"] : [p.threadId]) {
            threads.delete(id); loaded.delete(id); send({ method: "thread/deleted", params: { threadId: id } });
          }
          save(); break;
        }
        case "turn/start": {
          const thread = threads.get(p.threadId);
          const turn = { id: "turn-" + thread.turns.length, status: "inProgress", items: [{ id: "user-" + thread.turns.length, type: "userMessage", content: p.input }], itemsView: "full", startedAt: 100 };
          thread.turns.push(turn); thread.status = { type: "active", activeFlags: [] }; save();
          result = { turn };
          send({ method: "turn/started", params: { threadId: thread.id, turn } });
          setTimeout(() => { turn.status = "completed"; thread.status = { type: "idle" }; save(); send({ method: "turn/completed", params: { threadId: thread.id, turn } }); }, 30);
          break;
        }
        default: throw new Error("Unexpected fixture RPC: " + m.method);
      }
      send({ id: m.id, result });
    } catch (error) { send({ id: m.id, error: { code: -32600, message: error.message } }); }
  });
  lines.on("close", () => process.exit(0));
  await new Promise(() => {});
}
