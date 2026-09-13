// Transport-agnostic Codex control core.
//
// Owns the local `codex app-server` (JSON-RPC over stdio) and exposes a clean
// interface used by BOTH transports:
//   - relay/  (LAN: inbound WebSocket from a browser/phone)
//   - cloud/  (outbound WebSocket to a cloud broker, end-to-end encrypted)
//
// You give it an `emit(msg)` callback; it calls that with every outbound
// CodexApp message (state/event/approval/diff/...). You call `dispatch(msg)`
// with inbound client commands (prompt/steer/approval/...). The messages are
// exactly the protocol in PROTOCOL.md — the transport never interprets them.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { ModelSettings } from "./modelSettings.mjs";
import { WriterControl, isWriterConflict } from "./writerControl.mjs";
import { listProjectTree, readThreadHistory, historyEvents } from "./threadDisplay.mjs";
import { HistoryPager, HISTORY_LIMITS, trimRecent, boundEvent } from "./historyPaging.mjs";
import { liveItemEvent, liveDeltaEvent, settleLiveEvents, completedTurnEvent } from "./liveEvents.mjs";
import { PromptQueue } from "./promptQueue.mjs";
import { SessionPermissions } from "./sessionPermissions.mjs";

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");


// Locate the `codex` binary across OSes. Codex (desktop app) bundles it under a
// hash-named dir that changes on update; CLI installs (npm -g / brew) put it on PATH.
export function resolveCodexBin(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const isWin = process.platform === "win32";
  const exe = isWin ? "codex.exe" : "codex";

  // 1) On PATH (npm -g / homebrew / manual installs)
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try { const p = path.join(dir, exe); if (fs.existsSync(p)) return p; } catch {}
  }

  // 2) Newest binary under a hash-named bin dir (the desktop app's bundled CLI)
  const newestUnder = (base) => {
    try {
      const found = fs.readdirSync(base)
        .map((d) => path.join(base, d, exe))
        .filter((p) => fs.existsSync(p))
        .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      return found.length ? found[0].p : null;
    } catch { return null; }
  };

  const home = os.homedir();
  if (isWin) {
    return newestUnder(path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin"));
  }
  // 3) macOS / Linux known locations (desktop app bundle + common bin dirs)
  const candidates = [];
  if (process.platform === "darwin") {
    const hit = newestUnder(path.join(home, "Library", "Application Support", "OpenAI", "Codex", "bin"));
    if (hit) return hit;
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/bin/codex",
      "/Applications/Codex.app/Contents/MacOS/codex",
      path.join(home, "Applications/Codex.app/Contents/Resources/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      path.join(home, ".codex/bin/codex"),
    );
  } else { // linux
    candidates.push(
      "/usr/local/bin/codex", "/usr/bin/codex",
      path.join(home, ".local/bin/codex"),
      path.join(home, ".codex/bin/codex"),
    );
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

// JSON-RPC over newline-delimited JSON on stdio.
class CodexClient {
  constructor(bin) {
    this.bin = bin;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.buf = "";
    this.onNotification = () => {};
    this.onServerRequest = () => {};
    this.onExit = () => {};
  }
  start() {
    this.child = spawn(this.bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (d) => this._onData(d));
    this.child.stderr.on("data", (d) => process.stderr.write("[codex stderr] " + d.toString("utf8")));
    this.child.on("exit", (code, sig) => this.onExit(code, sig));
    return this.child;
  }
  _onData(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._dispatch(msg);
    }
  }
  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      return;
    }
    if (msg.id !== undefined && msg.method) { this.onServerRequest(msg); return; }
    if (msg.method) this.onNotification(msg);
  }
  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }
  notify(method, params) {
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }
  respond(id, result) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
  respondError(id, code, message) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
}

const APPROVE_OPTS = [
  { id: "approve", label: "批准", style: "primary" },
  { id: "approveSession", label: "本会话都批准", style: "secondary" },
  { id: "deny", label: "拒绝", style: "danger" },
];

function buildApproval(msg) {
  const { method, params, id } = msg;
  const key = crypto.randomUUID();
  let approval;
  switch (method) {
    case "item/commandExecution/requestApproval":
      approval = { key, kind: "command", title: "运行命令", command: params.command || "(unknown)", cwd: params.cwd || null, reason: params.reason || null, network: params.networkApprovalContext || null, options: APPROVE_OPTS };
      break;
    case "item/fileChange/requestApproval":
      approval = { key, kind: "file", title: "修改文件", command: params.grantRoot ? `授予写权限: ${params.grantRoot}` : "(文件改动)", cwd: null, reason: params.reason || null, options: APPROVE_OPTS };
      break;
    case "execCommandApproval":
      approval = { key, kind: "exec-legacy", title: "运行命令", command: Array.isArray(params.command) ? params.command.join(" ") : String(params.command), cwd: params.cwd || null, reason: params.reason || null, options: APPROVE_OPTS };
      break;
    case "applyPatchApproval":
      approval = { key, kind: "patch-legacy", title: "应用补丁", command: "修改: " + Object.keys(params.fileChanges || {}).join(", "), cwd: null, reason: params.reason || null, options: APPROVE_OPTS };
      break;
    case "item/permissions/requestApproval":
      approval = { key, kind: "permission", title: "权限请求", command: "(请求额外权限)", cwd: null, reason: params.reason || null, options: [{ id: "deny", label: "拒绝", style: "danger" }], note: "v1 暂不支持远程授予权限，只能拒绝。" };
      break;
    default:
      return null;
  }
  return { key, serverReqId: id, method, approval };
}

function approvalResult(method, optionId) {
  const v2 = { approve: "accept", approveSession: "acceptForSession", deny: "decline" };
  const legacy = { approve: "approved", approveSession: "approved_for_session", deny: "denied" };
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: v2[optionId] || "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: legacy[optionId] || "denied" };
    case "item/permissions/requestApproval":
      return null;
    default:
      return { decision: "decline" };
  }
}



export class CodexBridge {
  constructor(config, emit, saveModel) {
    this.config = config;
    if (!this.config.defaultCwd) this.config.defaultCwd = os.homedir(); // empty/missing -> home
    this.emit = emit; // (msg) => void  — outbound CodexApp message
    this.state = {
      codexConnected: false, codexVersion: null, threadId: null, turnId: null,
      cwd: config.defaultCwd, status: "idle", model: config.model || null,
      effectiveModel: null,
      reasoningEffort: config.reasoningEffort || null, effectiveReasoningEffort: null,
      approvalPolicy: config.approvalPolicy, sandbox: config.sandbox,
      threadName: null, lastDiff: "", readOnly: false,
    };
    this.eventLog = [];
    this.pendingApprovals = new Map();
    this.commandQueue = Promise.resolve();
    this.codex = new CodexClient(config.codexBin);
    this.permissions = new SessionPermissions(this.state, (method, params) => this.codex.request(method, params), () => this._broadcastState(), (threadId, error) => this.promptQueue.pause(threadId, error));
    this.historyPager = new HistoryPager(this.codex);
    this.history = null;
    this.models = new ModelSettings(this.codex, config, saveModel);
    this.writers = new WriterControl({ protectedPids: () => [process.pid, this.codex.child?.pid] });
    this.promptQueue = new PromptQueue({
      getState: () => this.state,
      schedule: run => { const task = this.commandQueue.catch(() => {}).then(run); this.commandQueue = task; return task; },
      execute: async item => {
        const result = await this._prompt(item.text, item.cwd, item.id);
        if (this.state.readOnly) throw new Error("会话被占用，消息保留在队列中");
        return result;
      },
      onChange: queue => this.emit({ type: "promptQueue", queue }),
      onSettled: turn => { if (this.state.turnId === turn.turnId) { this.state.status = "idle"; this._broadcastState(); } },
    });
    this.codex.onNotification = (m) => this._onNotification(m);
    this.codex.onServerRequest = (m) => this._onServerRequest(m);
    this.codex.onExit = (code, sig) => {
      console.error(`[codex] exited code=${code} sig=${sig}`);
      this.state.codexConnected = false;
      this.state.status = "idle"; this.state.turnId = null; this.state.readOnly = !!this.state.threadId;
      this.permissions.reset();
      this.promptQueue.disconnect();
      this._broadcastState();
      setTimeout(() => this._restart(), 1500);
    };
  }

  async start() {
    const bin = resolveCodexBin(this.config.codexBin);
    if (!bin) throw new Error("未找到 codex 可执行文件,请在配置里设置 codexBin(或确保 codex 在 PATH 上)");
    this.config.codexBin = bin;
    this.codex.bin = bin;
    this.codex.start();
    await this._bootstrap();
  }

  async _restart() {
    try {
      this.codex.pending.forEach((p) => p.reject(new Error("restarting")));
      this.codex.pending.clear();
      this.codex.buf = "";
      this.codex.start();
      await this._bootstrap();
    } catch (e) { setTimeout(() => this._restart(), 3000); }
  }

  async _bootstrap() {
    const res = await this.codex.request("initialize", {
      clientInfo: { name: this.config.originator || "codex_vscode", title: "CodexApp Agent", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.codex.notify("initialized");
    this.state.codexConnected = true;
    this.state.codexVersion = (res?.userAgent || "").split(" ")[0] || null;
    this._broadcastState();
  }

  // ---- outbound helpers ----
  _pushEvent(entry) {
    const raw = { id: crypto.randomUUID(), ts: Date.now(), threadId: this.state.threadId, ...entry };
    const e = this.history ? boundEvent(raw, this.historyPager) : raw;
    const index = this.eventLog.findIndex((old) => old.id === e.id);
    if (index < 0) this.eventLog.push(e);
    else this.eventLog[index] = e;
    if (this.history) trimRecent(this.eventLog);
    this.emit({ type: "event", event: e });
    return e;
  }
  _broadcastState() { this.emit({ type: "state", state: this.state }); }

  _schedulePermissions() {
    if (!this.state.permissions.pending) return;
    this.commandQueue = this.commandQueue.catch(() => {}).then(() => this.permissions.apply());
  }

  snapshot() {
    return {
      type: "hello",
      state: this.state,
      config: { approvalPolicy: this.state.approvalPolicy, sandbox: this.state.sandbox, cwd: this.state.cwd, model: this.state.model, reasoningEffort: this.state.reasoningEffort },
      pendingApprovals: [...this.pendingApprovals.values()].map((v) => v.approval),
      recentEvents: this.eventLog,
      history: this.history,
      promptQueue: this.promptQueue.snapshot(),
      diff: this.state.lastDiff,
    };
  }

  // ---- codex -> client ----
  _onServerRequest(msg) {
    const built = buildApproval(msg);
    if (!built) { this.codex.respondError(msg.id, -32601, "unhandled: " + msg.method); return; }
    this.pendingApprovals.set(built.key, built);
    this._pushEvent({ kind: "approval-requested", text: `${built.approval.title}: ${built.approval.command}` });
    this.emit({ type: "approval", approval: built.approval });
  }

  _onNotification(msg) {
    const { method, params } = msg;
    const st = this.state;
    if (params?.threadId && (st.readOnly || (st.threadId && params.threadId !== st.threadId))) return;
    if (method.startsWith("item/") && params?.turnId && st.turnId && params.turnId !== st.turnId) return;
    switch (method) {
      case "thread/started":
        if (params?.thread?.id) st.threadId = params.thread.id;
        this._pushEvent({ kind: "thread", text: "会话已开始" });
        this._broadcastState();
        break;
      case "turn/started":
        st.turnId = params?.turn?.id || st.turnId;
        this.promptQueue.started({ threadId: st.threadId, turnId: st.turnId });
        st.status = "running"; st.lastDiff = "";
        this.emit({ type: "diff", diff: "" });
        this._pushEvent({ kind: "turn", text: "开始执行…" });
        this._broadcastState();
        break;
      case "turn/diff/updated":
        st.lastDiff = params?.diff || "";
        this.emit({ type: "diff", diff: st.lastDiff });
        break;
      case "model/rerouted":
        if (params?.threadId === st.threadId && params?.toModel) {
          st.effectiveModel = params.toModel;
          this._broadcastState();
        }
        break;
      case "thread/settings/updated":
        if (params?.threadId === st.threadId && params?.threadSettings) {
          if (params.threadSettings.model) st.effectiveModel = params.threadSettings.model;
          if (Object.hasOwn(params.threadSettings, "effort")) st.effectiveReasoningEffort = params.threadSettings.effort;
          if (params.threadSettings.sandboxPolicy && params.threadSettings.approvalPolicy) this.permissions.observe(params.threadSettings);
          this._broadcastState();
        }
        break;
      case "turn/completed": {
        if (params?.turn?.id && st.turnId && params.turn.id !== st.turnId) break;
        st.status = "idle";
        const usage = params?.turn?.usage || params?.turn?.tokenUsage;
        const tok = usage ? ` (tokens: ${usage.totalTokens ?? usage.total_tokens ?? "?"})` : "";
        for (const event of settleLiveEvents(this.eventLog, st.threadId, st.turnId, params?.turn?.status)) this._pushEvent(event);
        this._pushEvent(completedTurnEvent(params?.turn, tok));
        this._broadcastState();
        this._schedulePermissions();
        this.promptQueue.complete({ threadId: st.threadId, turnId: params?.turn?.id || st.turnId, status: params?.turn?.status, reason: params?.turn?.error?.message });
        break;
      }
      case "item/started": this._describeItem(params?.item, "started", params); break;
      case "item/completed": this._describeItem(params?.item, "completed", params); break;
      case "item/agentMessage/delta": {
        this._streamDelta(params, "item:agentMessage", "assistantDelta");
        break;
      }
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta": {
        this._streamDelta(params, "item:commandExecution", "outputDelta");
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        this._streamDelta(params, "item:reasoning", "itemDelta", "summary");
        break;
      }
      case "item/reasoning/textDelta": {
        this._streamDelta(params, "item:reasoning", "itemDelta", "content");
        break;
      }
      case "serverRequest/resolved": {
        const reqId = params?.requestId ?? params?.id;
        for (const [k, v] of this.pendingApprovals) {
          if (v.serverReqId === reqId) { this.pendingApprovals.delete(k); this.emit({ type: "approvalResolved", key: k, by: "server" }); }
        }
        break;
      }
      case "error": {
        const err = params?.error || {};
        let text = err.message || params?.message || "Codex 错误";
        if (err.additionalDetails) text += "\n" + String(err.additionalDetails).slice(0, 400);
        this._pushEvent({ kind: "error", text });
        break;
      }
      default: break;
    }
  }

  _describeItem(item, phase, params = {}) {
    const context = { threadId: this.state.threadId, turnId: params.turnId || this.state.turnId };
    if (this.state.readOnly || !context.threadId || !context.turnId) return;
    const previous = this.eventLog.find(e => e.id === [context.threadId, context.turnId, item?.id].join(":"));
    const event = liveItemEvent(item, phase, context, previous, this.history ? HISTORY_LIMITS.itemChars : null);
    if (event) this._pushEvent(event);
  }

  _streamDelta(params, kind, type, reasoningSource) {
    const text = params?.delta ?? params?.chunk ?? params?.output, itemId = params?.itemId || params?.callId;
    if (typeof text !== "string" || !text || !itemId || this.state.readOnly || !this.state.threadId) return;
    if (params.turnId && this.state.turnId && params.turnId !== this.state.turnId) return;
    const context = { threadId: this.state.threadId, turnId: params.turnId || this.state.turnId, itemId, ...(reasoningSource ? { reasoningSource } : {}) };
    const previous = this.eventLog.find(e => e.id === [context.threadId, context.turnId, itemId].join(":"));
    if (previous?.live === false || ["completed", "failed", "interrupted", "ended"].includes(previous?.status)) return;
    let event = liveDeltaEvent(previous, context, text, kind, this.history ? HISTORY_LIMITS.itemChars : null);
    if (!event) return;
    if (this.history) event = boundEvent(event, this.historyPager);
    const index = this.eventLog.findIndex(e => e.id === event.id);
    if (index < 0) this.eventLog.push(event); else this.eventLog[index] = event;
    if (this.history) trimRecent(this.eventLog);
    this.emit({ type, ...context, kind, text });
  }

  // ---- client -> codex (actions) ----
  async _ensureThread(cwd, model) {
    if (this.state.threadId) {
      if (this.state.readOnly && !await this._resumeThread(this.state.threadId)) return null;
      return this.state.threadId;
    }
    const params = { cwd: cwd || this.state.cwd, approvalPolicy: this.state.approvalPolicy, sandbox: this.state.sandbox };
    params.model = model || await this.models.resolve(params.cwd);
    const res = await this.codex.request("thread/start", params);
    this.state.threadId = res?.thread?.id || res?.threadId || this.state.threadId;
    this.state.cwd = params.cwd;
    this.state.effectiveModel = res?.model || params.model;
    this.permissions.confirm(res, params, true);
    this._broadcastState();
    return this.state.threadId;
  }

  dispatch(m) {
    if (m.type === "historyPage" || m.type === "readHistoryItem") return this._dispatchCommand(m);
    const task = this.commandQueue.catch(() => {}).then(() => this._dispatchCommand(m));
    this.commandQueue = task;
    return task;
  }

  async _dispatchCommand(m) {
    switch (m.type) {
      case "enqueuePrompt": {
        if (!this.state.codexConnected) throw new Error("Codex 未连接");
        if (!this.state.threadId && !m.threadId) await this._ensureThread(m.cwd);
        const receipt = this.promptQueue.enqueue({ requestId: m.requestId, threadId: m.threadId || this.state.threadId, text: String(m.text || "").trim(), cwd: m.cwd });
        this.emit({ type: "promptAccepted", ...receipt, queue: this.promptQueue.snapshot() });
        return;
      }
      case "cancelQueuedPrompt": return this.promptQueue.cancel(m.threadId, m.id);
      case "pauseQueue": return this.promptQueue.pause(m.threadId);
      case "resumeQueue": return this.promptQueue.resume(m.threadId);
      case "prompt": return this._prompt(String(m.text || "").trim(), m.cwd);
      case "steer": return this._steer(String(m.text || "").trim());
      case "interrupt": return this._interrupt(m.threadId, m.turnId);
      case "approval": return this._resolveApproval(m.key, m.optionId);
      case "newThread": return this._newThread(m.cwd, m.historyMode === "paged" || !!this.history);
      case "listThreads": return this._listThreads();
      case "readThread": return this._readThread(m.threadId, m.historyMode === "paged", m.requestId);
      case "historyPage":
        return this.emit({ type: "historyPage", ...(await this.historyPager.page(m.threadId, m.cursor)), requestId: m.requestId });
      case "readHistoryItem":
        return this.emit({ type: "historyItem", ...(await this.historyPager.item(m.threadId, m.detailCursor, m.offset)), requestId: m.requestId });
      case "resumeThread": return this._resumeThread(m.threadId);
      case "inspectWriter": return this.emit(await this.writers.inspect(m.threadId));
      case "takeoverThread":
        await this.writers.terminate(m.threadId, m.token, m.confirmed === true);
        this._pushEvent({ kind: "thread", text: "占用进程已退出，正在尝试接续会话" });
        return this._resumeThread(m.threadId);
      case "listModels": return this.emit(await this.models.list(m.cwd || this.state.cwd));
      case "setConfig":
        this.models.update(m);
        this.state.model = this.config.model || null;
        this.state.reasoningEffort = this.config.reasoningEffort || null;
        this.state.approvalPolicy = this.config.approvalPolicy;
        this.state.sandbox = this.config.sandbox;
        if (m.cwd) this.state.cwd = m.cwd;
        this.permissions.selected();
        this._broadcastState();
        this.emit({ type: "configSaved", requestId: m.requestId });
        await this.permissions.apply();
        return;
      case "getState":
        if (m.historyMode === "paged") {
          this.history ||= { paged: true, nextCursor: null };
          this.eventLog = this.eventLog.map(e => boundEvent(e, this.historyPager)); trimRecent(this.eventLog);
        }
        return this.emit(this.snapshot());
      default: return;
    }
  }

  async _prompt(text, cwd, echoId) {
    if (!text) return;
    if (this.state.status === "running") throw new Error("当前任务未完成，请使用消息队列或纠偏");
    const model = await this.models.resolve(cwd || this.state.cwd);
    if (!await this._ensureThread(cwd, model)) return;
    if (this.state.status === "running") throw new Error("会话仍有运行中的任务，请等待完成后继续队列");
    const effort = await this.models.resolveEffort(cwd || this.state.cwd, model, this.state.effectiveReasoningEffort);
    const requested = this.permissions.selection();
    const policy = this.permissions.turnPolicy();
    const params = { threadId: this.state.threadId, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: requested.approvalPolicy, sandboxPolicy: policy };
    if (cwd) params.cwd = cwd;
    params.model = model;
    params.effort = effort;
    const echo = this._pushEvent({ kind: "user", text, inputEcho: true, ...(echoId ? { id: echoId } : {}) });
    const permissionRevision = this.permissions.revision;
    const res = await this.codex.request("turn/start", params);
    this.permissions.acceptedTurn(requested, policy, permissionRevision);
    const turnId = res?.turn?.id || res?.id || this.state.turnId;
    if (turnId) this._pushEvent({ ...echo, turnId });
    this.state.effectiveModel = model;
    this.state.effectiveReasoningEffort = effort;
    this.state.turnId = res?.turn?.id || res?.id || this.state.turnId;
    this.state.status = "running";
    this._broadcastState();
    return { threadId: this.state.threadId, turnId: res?.turn?.id || res?.id || null };
  }
  async _steer(text) {
    if (!this.state.threadId || !this.state.turnId) throw new Error("没有进行中的任务可纠偏");
    this._pushEvent({ kind: "user", text: "↪ " + text });
    await this.codex.request("turn/steer", { threadId: this.state.threadId, expectedTurnId: this.state.turnId, input: [{ type: "text", text, text_elements: [] }] });
  }
  async _interrupt(threadId = this.state.threadId, turnId = this.state.turnId) {
    this.promptQueue.pause(threadId, "任务已请求停止，队列暂停");
    if (!threadId || !turnId) throw new Error("没有可停止的任务；请先接续会话。");
    await this.codex.request("turn/interrupt", { threadId, turnId });
    this._pushEvent({ kind: "turn", text: "已请求中断" });
  }
  async _resolveApproval(key, optionId) {
    const item = this.pendingApprovals.get(key);
    if (!item) throw new Error("审批已失效");
    this.pendingApprovals.delete(key);
    const result = approvalResult(item.method, optionId);
    if (result === null) this.codex.respondError(item.serverReqId, -32000, "denied");
    else this.codex.respond(item.serverReqId, result);
    this._pushEvent({ kind: "approval-resolved", text: `${item.approval.title}: ${optionId === "deny" ? "已拒绝" : "已批准"}` });
    this.emit({ type: "approvalResolved", key, by: "user" });
  }
  async _newThread(cwd, paged = false) {
    if (this.state.status !== "running") this.promptQueue.select(null);
    if (this.state.status === "running") throw new Error("请先停止当前任务再新建会话");
    this.state.threadId = null; this.state.turnId = null; this.state.status = "idle";
    this.permissions.reset();
    this.state.threadName = null; this.state.lastDiff = ""; this.state.readOnly = false;
    this.state.effectiveReasoningEffort = null;
    this.state.effectiveModel = null;
    this.eventLog = [];
    this.history = paged ? { paged: true, nextCursor: null } : null;
    this.emit(this.snapshot());
    if (cwd) this.state.cwd = cwd;
    await this._ensureThread(cwd);
    this._pushEvent({ kind: "thread", text: "新建会话 @ " + this.state.cwd });
  }
  async _listThreads() {
    this.emit({ type: "projectTree", ...await listProjectTree(this.codex, CODEX_HOME) });
  }
  async _readThread(threadId, paged = false, requestId) {
    if (this.state.status === "running") throw new Error("请先停止当前任务再切换会话");
    const page = paged ? await this.historyPager.open(threadId) : null;
    const t = page?.thread || await readThreadHistory(this.codex, threadId);
    this.promptQueue.select(t.id);
    this.state.threadId = t.id;
    this.state.cwd = t.cwd || this.state.cwd;
    this.state.threadName = t.name || t.preview || null;
    this.state.turnId = null;
    this.state.status = "idle";
    this.state.readOnly = true;
    this.permissions.reset();
    this.state.effectiveModel = null;
    this.state.effectiveReasoningEffort = null;
    this.state.lastDiff = "";
    this.eventLog = page?.events || historyEvents(t);
    this.history = page ? { paged: true, nextCursor: page.nextCursor } : null;
    this.emit({ ...this.snapshot(), requestId });
  }
  async _resumeThread(threadId) {
    if (this.state.status === "running" && this.state.threadId !== threadId) throw new Error("请先停止当前任务再切换会话");
    let res;
    const requested = this.permissions.selection();
    try {
      res = await this.codex.request("thread/resume", { threadId, ...requested, ...(this.history ? { excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" } } : {}) });
    } catch (error) {
      if (!isWriterConflict(error)) throw error;
      this.emit(await this.writers.inspect(threadId));
      return;
    }
    const t = res?.thread || {};
    this.promptQueue.select(t.id || threadId);
    this.state.threadId = t.id || threadId;
    this.state.cwd = t.cwd || this.state.cwd;
    const activeTurn = (res.initialTurnsPage?.data || t.turns || []).findLast((turn) => turn.status === "inProgress");
    this.state.turnId = activeTurn?.id || null;
    this.state.status = activeTurn ? "running" : "idle";
    this.state.lastDiff = "";
    this.state.threadName = t.name || t.preview || null;
    this.state.effectiveModel = res?.model || null;
    this.state.effectiveReasoningEffort = res?.reasoningEffort || null;
    this.state.readOnly = false;
    this.permissions.confirm(res, requested);
    const beforePage = new Map(this.eventLog.map(e => [e.id, e]));
    const page = this.history ? await this.historyPager.page(this.state.threadId) : null;
    if (page) {
      const changes = this.eventLog.filter(e => (e.live && e.threadId === this.state.threadId) || beforePage.get(e.id) !== e);
      this.eventLog = [...new Map([...page.events, ...changes].map(e => [e.id, e])).values()];
      trimRecent(this.eventLog);
      const pagedActive = page.turns.find(t => t.status === "inProgress");
      if (!activeTurn && pagedActive && !changes.some(e => e.kind === "turn")) { this.state.turnId = pagedActive.id; this.state.status = "running"; }
      this.history = { paged: true, nextCursor: page.nextCursor };
    } else {
      const history = await readThreadHistory(this.codex, this.state.threadId, t);
      this.eventLog = historyEvents(history);
    }
    this.emit(this.snapshot());
    return true;
  }
}
