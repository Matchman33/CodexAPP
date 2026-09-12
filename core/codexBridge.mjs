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
import { listProjectTree, readThreadHistory, historyEvents, itemToEvent } from "./threadDisplay.mjs";

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
      approvalPolicy: config.approvalPolicy, sandbox: config.sandbox,
      threadName: null, lastDiff: "", readOnly: false,
    };
    this.eventLog = [];
    this.pendingApprovals = new Map();
    this.commandQueue = Promise.resolve();
    this.codex = new CodexClient(config.codexBin);
    this.models = new ModelSettings(this.codex, config, saveModel);
    this.writers = new WriterControl({ protectedPids: () => [process.pid, this.codex.child?.pid] });
    this.codex.onNotification = (m) => this._onNotification(m);
    this.codex.onServerRequest = (m) => this._onServerRequest(m);
    this.codex.onExit = (code, sig) => {
      console.error(`[codex] exited code=${code} sig=${sig}`);
      this.state.codexConnected = false;
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
      capabilities: null,
    });
    this.codex.notify("initialized");
    this.state.codexConnected = true;
    this.state.codexVersion = (res?.userAgent || "").split(" ")[0] || null;
    this._broadcastState();
  }

  // ---- outbound helpers ----
  _pushEvent(entry) {
    const e = { id: crypto.randomUUID(), ts: Date.now(), ...entry };
    const index = this.eventLog.findIndex((old) => old.id === e.id);
    if (index < 0) this.eventLog.push(e);
    else this.eventLog[index] = e;
    this.emit({ type: "event", event: e });
    return e;
  }
  _broadcastState() { this.emit({ type: "state", state: this.state }); }

  snapshot() {
    return {
      type: "hello",
      state: this.state,
      config: { approvalPolicy: this.state.approvalPolicy, sandbox: this.state.sandbox, cwd: this.state.cwd, model: this.state.model },
      pendingApprovals: [...this.pendingApprovals.values()].map((v) => v.approval),
      recentEvents: this.eventLog,
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
    switch (method) {
      case "thread/started":
        if (params?.thread?.id) st.threadId = params.thread.id;
        this._pushEvent({ kind: "thread", text: "会话已开始" });
        this._broadcastState();
        break;
      case "turn/started":
        st.turnId = params?.turn?.id || st.turnId;
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
        if (params?.threadId === st.threadId && params?.threadSettings?.model) {
          st.effectiveModel = params.threadSettings.model;
          this._broadcastState();
        }
        break;
      case "turn/completed": {
        st.status = "idle";
        const usage = params?.turn?.usage || params?.turn?.tokenUsage;
        const tok = usage ? ` (tokens: ${usage.totalTokens ?? usage.total_tokens ?? "?"})` : "";
        this._pushEvent({ kind: "turn", text: "执行完成" + tok });
        this._broadcastState();
        break;
      }
      case "item/started": this._describeItem(params?.item, "started"); break;
      case "item/completed": this._describeItem(params?.item, "completed"); break;
      case "item/agentMessage/delta": {
        if (!params?.delta) break;
        const id = [st.threadId, params.turnId || st.turnId, params.itemId].join(":");
        const index = this.eventLog.findIndex((e) => e.id === id);
        const previous = index < 0 ? null : this.eventLog[index];
        const event = { id, ts: previous?.ts || Date.now(), kind: "item:agentMessage", itemId: params.itemId, text: (previous?.text || "") + params.delta, live: true };
        if (index < 0) this.eventLog.push(event); else this.eventLog[index] = event;
        this.emit({ type: "assistantDelta", text: params.delta, itemId: params.itemId, turnId: params.turnId, threadId: params.threadId });
        break;
      }
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta": {
        const chunk = params?.chunk || params?.delta || params?.output;
        if (typeof chunk === "string") this.emit({ type: "outputDelta", text: chunk });
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

  _describeItem(item, phase) {
    if (!item || item.type === "userMessage") return;
    if (phase !== "completed" && item.type !== "commandExecution") return;
    const event = itemToEvent(item);
    if (event) this._pushEvent({ ...event, id: [this.state.threadId, this.state.turnId, item.id].join(":"), threadId: this.state.threadId, turnId: this.state.turnId });
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
    this._broadcastState();
    return this.state.threadId;
  }

  dispatch(m) {
    const task = this.commandQueue.catch(() => {}).then(() => this._dispatchCommand(m));
    this.commandQueue = task;
    return task;
  }

  async _dispatchCommand(m) {
    switch (m.type) {
      case "prompt": return this._prompt(String(m.text || "").trim(), m.cwd);
      case "steer": return this._steer(String(m.text || "").trim());
      case "interrupt": return this._interrupt(m.threadId, m.turnId);
      case "approval": return this._resolveApproval(m.key, m.optionId);
      case "newThread": return this._newThread(m.cwd);
      case "listThreads": return this._listThreads();
      case "readThread": return this._readThread(m.threadId);
      case "resumeThread": return this._resumeThread(m.threadId);
      case "inspectWriter": return this.emit(await this.writers.inspect(m.threadId));
      case "takeoverThread":
        await this.writers.terminate(m.threadId, m.token, m.confirmed === true);
        this._pushEvent({ kind: "thread", text: "占用进程已退出，正在尝试接续会话" });
        return this._resumeThread(m.threadId);
      case "listModels": return this.emit(await this.models.list(m.cwd || this.state.cwd));
      case "setConfig":
        if (Object.hasOwn(m, "model")) this.state.model = this.models.select(m.model);
        if (m.approvalPolicy) this.state.approvalPolicy = m.approvalPolicy;
        if (m.sandbox) this.state.sandbox = m.sandbox;
        if (m.cwd) this.state.cwd = m.cwd;
        this._broadcastState();
        this.emit({ type: "configSaved", requestId: m.requestId });
        return;
      case "getState": return this.emit(this.snapshot());
      default: return;
    }
  }

  async _prompt(text, cwd) {
    if (!text) return;
    const model = await this.models.resolve(cwd || this.state.cwd);
    if (!await this._ensureThread(cwd, model)) return;
    const params = { threadId: this.state.threadId, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: this.state.approvalPolicy };
    if (cwd) params.cwd = cwd;
    params.model = model;
    this._pushEvent({ kind: "user", text });
    const res = await this.codex.request("turn/start", params);
    this.state.effectiveModel = model;
    this.state.turnId = res?.turn?.id || res?.id || this.state.turnId;
    this.state.status = "running";
    this._broadcastState();
  }
  async _steer(text) {
    if (!this.state.threadId || !this.state.turnId) throw new Error("没有进行中的任务可纠偏");
    this._pushEvent({ kind: "user", text: "↪ " + text });
    await this.codex.request("turn/steer", { threadId: this.state.threadId, expectedTurnId: this.state.turnId, input: [{ type: "text", text, text_elements: [] }] });
  }
  async _interrupt(threadId = this.state.threadId, turnId = this.state.turnId) {
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
  async _newThread(cwd) {
    if (this.state.status === "running") throw new Error("请先停止当前任务再新建会话");
    this.state.threadId = null; this.state.turnId = null; this.state.status = "idle";
    this.state.threadName = null; this.state.lastDiff = ""; this.state.readOnly = false;
    this.eventLog = [];
    this.emit(this.snapshot());
    if (cwd) this.state.cwd = cwd;
    await this._ensureThread(cwd);
    this._pushEvent({ kind: "thread", text: "新建会话 @ " + this.state.cwd });
  }
  async _listThreads() {
    this.emit({ type: "projectTree", ...await listProjectTree(this.codex, CODEX_HOME) });
  }
  async _readThread(threadId) {
    if (this.state.status === "running") throw new Error("请先停止当前任务再切换会话");
    const t = await readThreadHistory(this.codex, threadId);
    this.state.threadId = t.id;
    this.state.cwd = t.cwd || this.state.cwd;
    this.state.threadName = t.name || t.preview || null;
    this.state.turnId = null;
    this.state.status = "idle";
    this.state.readOnly = true;
    this.state.effectiveModel = null;
    this.state.lastDiff = "";
    this.eventLog = historyEvents(t);
    this.emit(this.snapshot());
  }
  async _resumeThread(threadId) {
    if (this.state.status === "running" && this.state.threadId !== threadId) throw new Error("请先停止当前任务再切换会话");
    let res;
    try {
      res = await this.codex.request("thread/resume", { threadId, approvalPolicy: this.state.approvalPolicy, sandbox: this.state.sandbox });
    } catch (error) {
      if (!isWriterConflict(error)) throw error;
      this.emit(await this.writers.inspect(threadId));
      return;
    }
    const t = res?.thread || {};
    this.state.threadId = t.id || threadId;
    this.state.cwd = t.cwd || this.state.cwd;
    const activeTurn = (t.turns || []).findLast((turn) => turn.status === "inProgress");
    this.state.turnId = activeTurn?.id || null;
    this.state.status = activeTurn ? "running" : "idle";
    this.state.lastDiff = "";
    this.state.threadName = t.name || t.preview || null;
    this.state.effectiveModel = res?.model || null;
    this.state.readOnly = false;
    const history = await readThreadHistory(this.codex, this.state.threadId, t);
    this.eventLog = historyEvents(history);
    this.emit(this.snapshot());
    return true;
  }
}
