import fs from "node:fs";
import path from "node:path";
import { atomicJson } from "./sessionHub.mjs";

export function enableServiceRestart(hub, restartHost) {
  const file = path.join(hub.dataDir, "restart-queue.json");
  let checking = false, previous = new Map();
  const requests = new Set();
  hub.restart.supported = typeof restartHost === "function";
  const changed = () => hub.emit({ type: "serviceRestart", ...hub.restart });
  hub.restartCommand = async (m, reply) => {
    if (!restartHost) throw new Error("当前启动方式不支持网页重启，请使用 npm start 或支持重启的桌面启动器");
    if (m.type === "cancelRestart") {
      if (hub.restart.phase !== "waiting") throw new Error("已开始重启，不能取消");
      hub.restart.phase = "idle";
      for (const [b, original] of previous) {
        if (original.paused) b.promptQueue.pause(b.state.threadId, original.reason);
        else b.promptQueue.resume(b.state.threadId);
      }
      previous.clear(); changed(); return;
    }
    if (m.confirmed !== true || typeof m.requestId !== "string" || !/^[\w:-]{1,160}$/.test(m.requestId)) throw new Error("请确认重启本项目");
    if (hub.terminals?.activeCount) throw new Error("仍有 " + hub.terminals.activeCount + " 个活动终端，请先在终端面板明确结束后再重启");
    if (requests.has(m.requestId)) return reply({ type: "serviceRestart", ...hub.restart });
    if (hub.restart.phase !== "idle") return reply({ type: "serviceRestart", ...hub.restart });
    hub.restart = { supported: true, phase: "waiting", error: null, requestId: m.requestId };
    previous = new Map([...hub.sessions.values()].map(b => [b, b.promptQueue.snapshot()]));
    for (const b of hub.sessions.values()) b.promptQueue.pause(b.state.threadId, "等待项目重启，队列已暂停");
    changed(); await check();
  };
  async function check() {
    if (checking || hub.restart.phase !== "waiting" || hub.busy() || hub.activeCommands) return;
    checking = true;
    try {
      const sessions = [...hub.sessions].map(([id, b]) => ({ id, cwd: b.state.cwd, projectless: b.state.projectless,
        items: b.promptQueue.threads.get(id)?.items || [], receipts: [...b.promptQueue.receipts] }));
      const accepted = [...requests, hub.restart.requestId].slice(-20);
      atomicJson(file, { version: 1, sessions, restartRequests: accepted });
      requests.clear(); for (const id of accepted) requests.add(id);
      hub.restart.phase = "restarting"; changed();
      await restartHost();
    } catch (error) {
      hub.restart.phase = "idle"; hub.restart.error = "重启失败：" + error.message;
      // Queues stay paused; resuming them after a failed restart is an explicit user action.
      changed();
    } finally { checking = false; }
  }
  hub.onActivity = () => { queueMicrotask(() => { void check(); }); };
  hub.restoreQueues = () => {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size > 40 * 1048576) throw new Error("重启恢复文件超出限制，未加载");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error("重启恢复记录格式无效");
    for (const id of (saved.restartRequests || []).slice(-20)) if (typeof id === "string") requests.add(id);
    for (const s of saved.sessions) {
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(s.id) || !Array.isArray(s.items) || !Array.isArray(s.receipts)) throw new Error("重启恢复会话格式无效");
      const b = hub.create();
      Object.assign(b.state, { threadId: s.id, cwd: s.cwd, projectless: !!s.projectless, readOnly: true });
      b.needsHistory = true;
      b.promptQueue.threads.set(s.id, { items: s.items, paused: true, reason: "项目已重启，请核对后继续队列" });
      b.promptQueue.receipts = new Map(s.receipts);
      hub.sessions.set(s.id, b);
    }
    fs.unlinkSync(file);
  };
}

export function hostRestart(stop) {
  if (typeof globalThis.codexappRestart === "function") return async () => { await stop(); globalThis.codexappRestart(); };
  if (!process.send || process.env.CODEXAPP_MANAGED !== "1") return undefined;
  return async () => {
    await stop();
    await new Promise((resolve, reject) => process.send({ type: "codexapp-restart" }, error => error ? reject(error) : resolve()));
    process.exit(0);
  };
}
