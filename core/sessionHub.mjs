import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { CodexBridge } from "./codexBridge.mjs";
import { listProjectTree } from "./threadDisplay.mjs";
import { restartIdleCodex } from "./threadLifecycle.mjs";
import { QUEUE_LIMITS } from "./promptQueue.mjs";
import { IMAGE_LIMITS } from "./imageInput.mjs";
import { TerminalManager } from "./terminalManager.mjs";

export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const validId = id => typeof id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(id);

// Each bridge owns one conversation; only the RPC transport is shared.
export class SessionHub {
  constructor(config, emit, saveModel, options = {}) {
    Object.assign(this, { config, emit, saveModel });
    this.dataDir = options.dataDir || process.env.CODEXAPP_DATA_DIR || path.join(os.homedir(), ".codexapp", "sessions");
    this.metadataFile = path.join(this.dataDir, "sessions.json");
    this.metadata = fs.existsSync(this.metadataFile) ? JSON.parse(fs.readFileSync(this.metadataFile, "utf8")) : {};
    this.sessions = new Map(); this.selected = new Map(); this.clientQueues = new Map(); this.drafts = new Map();
    this.pagedClients = new Set();
    this.historyWatches = new WeakMap();
    this.context = new AsyncLocalStorage(); this.creation = Promise.resolve();
    this.control = new CodexBridge({ ...config }, m => this.controlMessage(m));
    this.control.codex.onNotification = m => this.notification(m);
    this.control.codex.onServerRequest = m => this.serverRequest(m);
    this.restart = { supported: false, phase: "idle", error: null };
    this.terminals = new TerminalManager(emit, { enabled: config.terminalEnabled !== false, ...options.terminal });
  }
  get state() { return this.control.state; }
  async start() { if (!this.starting) this.starting = this.control.start().finally(() => { this.starting = null; }); return this.starting; }
  controlMessage(m) {
    if (m.type !== "state") return;
    for (const bridge of this.sessions.values()) {
      this.historyWatches.delete(bridge);
      bridge.state.codexConnected = m.state.codexConnected;
      bridge.state.codexVersion = m.state.codexVersion;
      if (!m.state.codexConnected) {
        bridge.state.status = "idle"; bridge.state.readOnly = true;
        bridge.permissions.reset(); bridge.promptQueue.disconnect();
      }
      bridge._broadcastState();
    }
    this.emit({ type: "connectionState", codexConnected: m.state.codexConnected });
  }
  notification(m) {
    const id = m.params?.threadId || m.params?.thread?.id;
    if (m.method === "thread/deleted" && id && !this.sessions.has(id)) {
      delete this.metadata[id]; atomicJson(this.metadataFile, this.metadata); this.control.files.forget(id);
      this.emit({ type: "threadDeleted", threadId: id }); return;
    }
    if (id) {
      const bridge = this.sessions.get(id);
      if (bridge) this.historyWatches.delete(bridge);
      bridge?.codex.onNotification(m);
    }
    else if (m.method === "serverRequest/resolved") for (const b of this.sessions.values()) b.codex.onNotification(m);
  }
  serverRequest(m) {
    const b = this.sessions.get(m.params?.threadId || m.params?.conversationId);
    if (b) b.codex.onServerRequest(m);
    else this.control.codex.respondError(m.id, -32600, "Unknown conversation for approval");
  }
  create(paged = true) {
    const shared = this.control.codex;
    const client = {
      request: (method, params) => shared.request(method, params),
      respond: (...args) => shared.respond(...args), respondError: (...args) => shared.respondError(...args),
      get child() { return shared.child; },
    };
    const b = new CodexBridge({ ...this.config }, m => this.message(b, m), (model, settings) => {
      this.saveModel?.(model, settings); Object.assign(this.config, settings, { model });
    }, { client, recycle: async () => {
      if (this.busy()) throw new Error("其他会话仍在运行，不能重连共享控制进程；请稍后释放");
      await restartIdleCodex(shared, () => this.control._bootstrap());
      for (const s of this.sessions.values()) { s.state.readOnly = true; s.permissions.reset(); s._broadcastState(); }
    } });
    b.state.codexConnected = this.state.codexConnected;
    b.files = this.control.files;
    b.viewId = crypto.randomUUID();
    b.state.codexVersion = this.state.codexVersion;
    b.history = paged ? { paged: true, nextCursor: null } : null;
    return b;
  }
  capabilities() { return { multiSession: { supported: true }, serviceRestart: { ...this.restart }, terminal: this.terminals.capabilities() }; }
  snapshot(clientId = "legacy") {
    const b = this.sessions.get(this.selected.get(clientId)) || this.drafts.get(clientId);
    return { ...(b || this.control).snapshot(), ...this.capabilities(), historyEpoch: b?.viewId || null, sessions: this.summaries() };
  }
  summaries() {
    return [...this.sessions.entries()].map(([id, b]) => ({ threadId: id, name: b.state.threadName || "新会话", cwd: b.state.cwd, projectless: !!b.state.projectless, status: b.state.status, approvals: b.pendingApprovals.size, queued: b.promptQueue.snapshot().items.length, revision: b.updateSeq || 0 }));
  }
  broadcastSessions() { this.emit({ type: "sessions", sessions: this.summaries() }); }
  message(b, m) {
    if (["event", "assistantDelta", "outputDelta", "itemDelta"].includes(m.type)) b.updateSeq = (b.updateSeq || 0) + 1;
    const id = b.state.threadId;
    if (id && !this.sessions.has(id)) this.sessions.set(id, b);
    const scope = this.context.getStore();
    if (m.type === "hello" && scope?.loading) return;
    if (m.type === "hello") {
      for (const [clientId, selected] of this.selected) if (selected === id) this.emit({ ...m, ...this.capabilities(), historyEpoch: b.viewId, threadId: id, clientId });
      return;
    }
    // Commands reply to their requester; background events reach every viewer of that thread.
    const direct = ["hello", "configSaved", "models", "projectTree", "historyPage", "historyItem", "historyUpdate", "attachmentChunk", "promptAccepted", "writerConflict", "threadReleased"].includes(m.type);
    if (m.type === "threadDeleted") {
      this.sessions.delete(m.threadId); delete this.metadata[m.threadId]; atomicJson(this.metadataFile, this.metadata);
      for (const [clientId, selected] of this.selected) if (selected === m.threadId) this.selected.delete(clientId);
      this.emit(m); this.broadcastSessions(); return;
    }
    if (direct && scope?.clientId) this.emit({ ...m, ...(m.type === "hello" ? { ...this.capabilities(), historyEpoch: b.viewId } : {}), clientId: scope.clientId, threadId: m.threadId || id });
    else for (const [clientId, selected] of this.selected) if (selected === id) this.emit({ ...m, clientId, threadId: m.threadId || id });
    if (["state", "promptQueue", "approval", "approvalResolved", "event"].includes(m.type)) {
      if (m.type !== "event" || !m.event?.kind?.startsWith("item:")) this.broadcastSessions();
      this.onActivity?.();
    }
  }
  busy() { return [...this.sessions.values()].some(b => b.state.status === "running" || b.promptQueue.active?.starting || b.pendingApprovals.size); }
  async stop() {
    if (this.terminals.activeCount) throw new Error("仍有活动终端，请先明确结束终端再重启项目");
    const child = this.control.codex.child;
    this.control.codex.onExit = () => {};
    this.control.state.codexConnected = false; this.controlMessage({ type: "state", state: this.control.state });
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("控制进程尚未正常退出")), 10000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
  disconnect(clientId) { this.terminals.detach(clientId); this.selected.delete(clientId); this.clientQueues.delete(clientId); this.drafts.delete(clientId); this.pagedClients.delete(clientId); }
  dispatch(m, clientId = m.clientId || "legacy") {
    if (!validId(clientId)) return Promise.reject(new Error("客户端标识无效"));
    if (m.historyMode === "paged") this.pagedClients.add(clientId);
    const read = ["historyPage", "readHistoryItem", "readAttachment", "watchThread"].includes(m.type) || m.type.startsWith("terminal");
    const execute = () => this.context.run({ clientId }, async () => {
      const counted = !read && !["restartService", "cancelRestart"].includes(m.type);
      if (counted) this.activeCommands = (this.activeCommands || 0) + 1;
      try { return await this.command(m, clientId); }
      finally { if (counted) this.activeCommands--; this.onActivity?.(); }
    });
    if (read) return execute();
    const task = (this.clientQueues.get(clientId) || Promise.resolve()).catch(() => {}).then(execute);
    this.clientQueues.set(clientId, task);
    return task;
  }
  async open(id, paged = true) {
    if (!validId(id)) throw new Error("会话标识无效");
    if (this.sessions.has(id)) {
      const b = this.sessions.get(id);
      if (b.needsHistory && !b.loading) {
        b.loading = this.context.run({ ...this.context.getStore(), loading: true }, () => b.dispatch({ type: "readThread", threadId: id, historyMode: "paged" }));
        try { await b.loading; b.needsHistory = false; } finally { b.loading = null; }
      }
      await b.loading; return b;
    }
    this.reserveSession();
    const b = this.create(paged); b.state.threadId = id; b.state.readOnly = true;
    b.state.projectless = !!this.metadata[id]?.projectless;
    this.sessions.set(id, b);
    b.loading = this.context.run({ ...this.context.getStore(), loading: true }, () => b.dispatch({ type: "readThread", threadId: id, historyMode: paged ? "paged" : undefined }));
    try { await b.loading; }
    catch (e) { this.sessions.delete(id); throw e; }
    return b;
  }
  reserveSession() {
    if (this.sessions.size < 32) return;
    const candidate = [...this.sessions].find(([key, b]) => b.state.readOnly && b.state.status === "idle" && !b.loading && !b.promptQueue.snapshot().items.length && ![...this.selected.values()].includes(key));
    if (candidate) this.sessions.delete(candidate[0]);
    else throw new Error("已打开会话过多，请先关闭不使用的会话");
  }
  async watchPage(id, bridge) {
    let cached = this.historyWatches.get(bridge);
    if (!cached || (!cached.pending && cached.expires <= Date.now())) {
      cached = { expires: 0 };
      this.historyWatches.set(bridge, cached);
      cached.pending = bridge.historyPager.open(id).then(page => {
        cached.page = page; cached.expires = Date.now() + 2000; return page;
      }).catch(error => {
        if (this.historyWatches.get(bridge) === cached) this.historyWatches.delete(bridge);
        throw error;
      }).finally(() => { cached.pending = null; });
    }
    const page = cached.pending ? await cached.pending : cached.page;
    if (this.historyWatches.get(bridge) !== cached || this.sessions.get(id) !== bridge || !bridge.state.readOnly) return null;
    return { page, syncedAt: cached.expires - 2000 };
  }
  async command(m, clientId) {
    const reply = msg => this.emit({ ...msg, clientId });
    if (m.type.startsWith("terminal")) {
      const respond = result => reply({ ...result, requestId: m.requestId });
      switch (m.type) {
        case "terminalList": return respond({ type: "terminalList", terminals: this.terminals.list(), activeCount: this.terminals.activeCount });
        case "terminalOpen": {
          if (this.restart.phase !== "idle") throw new Error("项目正在等待重启，不能新建终端");
          const threadId = m.threadId || this.selected.get(clientId);
          const b = threadId ? await this.open(threadId, this.pagedClients.has(clientId)) : this.drafts.get(clientId);
          if (this.restart.phase !== "idle") throw new Error("项目正在重启");
          return respond(await this.terminals.open({ cwd: b?.state.cwd || this.config.defaultCwd, threadId, cols: m.cols, rows: m.rows }, clientId));
        }
        case "terminalAttach": return respond(await this.terminals.attach(m, clientId));
        case "terminalInput": this.terminals.input(m, clientId); return;
        case "terminalResize": this.terminals.resize(m, clientId); return;
        case "terminalAck": this.terminals.ack(m, clientId); return;
        case "terminalDetach": this.terminals.detach(clientId, m.terminalId); return;
        case "terminalClose": return respond(await this.terminals.close(m, clientId));
        default: throw new Error("未知终端操作");
      }
    }
    if (["restartService", "cancelRestart"].includes(m.type)) return this.restartCommand(m, reply);
    if (m.type === "listThreads") {
      const tree = await listProjectTree(this.control.codex, process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
      for (const p of tree.projects) {
        const moved = p.threads.filter(t => this.metadata[t.id]?.projectless);
        p.threads = p.threads.filter(t => !this.metadata[t.id]?.projectless);
        tree.projectless.push(...moved);
      }
      return reply({ type: "projectTree", ...tree });
    }
    if (m.type === "getState" && !this.selected.has(clientId) && !m.threadId) return reply(this.snapshot(clientId));
    if (m.type === "closeThread") {
      if (this.selected.get(clientId) === m.threadId) this.selected.delete(clientId);
      const b = this.sessions.get(m.threadId);
      if (b && b.state.status !== "running" && !b.pendingApprovals.size && !b.promptQueue.snapshot().items.length && ![...this.selected.values()].includes(m.threadId)) {
        if (!b.state.readOnly) await b.lifecycle.release(m.threadId, { verify: false });
        this.sessions.delete(m.threadId);
      }
      this.broadcastSessions(); return;
    }
    if (this.restart.phase !== "idle" && ["newThread", "prompt", "enqueuePrompt", "resumeQueue", "resumeThread", "takeoverThread"].includes(m.type)) throw new Error("项目正在等待重启，请先取消重启再发送");
    if (m.type === "newThread" || (!this.selected.get(clientId) && !m.threadId && ["prompt", "enqueuePrompt"].includes(m.type))) {
      let b;
      const create = async () => {
        this.reserveSession();
        b = this.create(this.pagedClients.has(clientId));
        if (m.scope && !["temporary", "project"].includes(m.scope)) throw new Error("新会话范围无效");
        const previous = this.sessions.get(this.selected.get(clientId)) || this.drafts.get(clientId);
        let cwd = m.cwd || previous?.state.cwd || this.config.defaultCwd;
        if (m.scope === "temporary") {
          cwd = path.join(this.dataDir, "temporary", crypto.randomUUID()); fs.mkdirSync(cwd, { recursive: true });
          b.state.projectless = true;
        }
        await this.context.run({ ...this.context.getStore(), loading: true }, () => b.dispatch({ type: "newThread", cwd, historyMode: this.pagedClients.has(clientId) ? "paged" : undefined }));
        const id = b.state.threadId;
        this.sessions.set(id, b); this.selected.set(clientId, id);
        if (b.state.projectless) { this.metadata[id] = { projectless: true, cwd }; atomicJson(this.metadataFile, this.metadata); }
        reply({ ...this.snapshot(clientId), requestId: m.requestId }); this.broadcastSessions();
      };
      this.creation = this.creation.catch(() => {}).then(create); await this.creation;
      if (m.type === "newThread") return;
    }
    const id = m.threadId || this.selected.get(clientId);
    if (!id) {
      if (["listModels", "setConfig"].includes(m.type)) {
        let b = this.drafts.get(clientId);
        if (!b) { b = this.create(); this.drafts.set(clientId, b); this.selected.set(clientId, null); }
        return b.dispatch(m);
      }
      return reply(this.snapshot(clientId));
    }
    const b = await this.open(id, this.pagedClients.has(clientId));
    if (m.type === "readThread" || m.type === "getState") {
      this.selected.set(clientId, id);
      reply({ ...this.snapshot(clientId), requestId: m.requestId }); this.broadcastSessions(); return;
    }
    if (!this.selected.get(clientId)) this.selected.set(clientId, id);
    if (m.type === "watchThread") {
      if (!b.state.readOnly) return reply({ type: "historyUpdate", threadId: id, requestId: m.requestId, skipped: true });
      const result = await this.watchPage(id, b);
      if (!result) return reply({ type: "historyUpdate", threadId: id, requestId: m.requestId, skipped: true });
      const { page, syncedAt } = result;
      b.eventLog = page.events; b.history = { paged: true, nextCursor: page.nextCursor };
      return reply(b.files.decorate({ type: "historyUpdate", ...page, requestId: m.requestId, syncedAt }, b.state));
    }
    if (m.type === "enqueuePrompt") {
      const items = [...this.sessions.values()].flatMap(s => [...s.promptQueue.threads.values()].flatMap(q => q.items));
      if (!b.promptQueue.receipts.has(m.requestId) && (items.length >= QUEUE_LIMITS.items || items.reduce((n, i) => n + i.text.length, 0) + String(m.text || "").length > QUEUE_LIMITS.totalChars || JSON.stringify(items.map(i => i.images || [])).length + JSON.stringify(m.images || []).length > IMAGE_LIMITS.queueChars)) throw new Error("待执行队列已满");
    }
    const readOnly = ["historyPage", "readHistoryItem", "readAttachment", "listModels"].includes(m.type);
    if (!readOnly) this.historyWatches.delete(b);
    try { await b.dispatch({ ...m, threadId: id, checkWriter: false }); }
    finally { if (!readOnly) this.historyWatches.delete(b); }
  }
}
