// CodexApp relay: bridge an iPhone PWA <-> a local `codex app-server`.
//
//   [iPhone PWA] --WebSocket(token)--> [this relay] --JSON-RPC(stdio)--> [codex app-server]
//
// The phone never touches Codex credentials. Auth (auth.json / config.toml)
// lives on this machine; the relay is the only thing that talks to Codex.
//
// Run:  node relay/server.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { resolveCodexBin } from "../core/codexBinary.mjs";
import { ModelSettings, persistModel } from "../core/modelSettings.mjs";
import { WriterControl, isWriterConflict } from "../core/writerControl.mjs";
import { listProjectTree, readThreadHistory, historyEvents } from "../core/threadDisplay.mjs";
import { HistoryPager, HISTORY_LIMITS, trimRecent, boundEvent } from "../core/historyPaging.mjs";
import { liveItemEvent, liveDeltaEvent, settleLiveEvents, completedTurnEvent } from "../core/liveEvents.mjs";
import { PromptQueue } from "../core/promptQueue.mjs";
import { normalizeImages, buildUserInput, imageEcho, IMAGE_LIMITS } from "../core/imageInput.mjs";
import { SessionPermissions } from "../core/sessionPermissions.mjs";
import { ThreadLifecycle, restartIdleCodex } from "../core/threadLifecycle.mjs";
import { createSleepPrevention } from "../core/sleepPrevention.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEBAPP_DIR = path.join(ROOT, "web");
const CONFIG_PATH = path.join(ROOT, "codexapp.config.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  // Path to the codex binary. Empty = auto-detect (cross-platform); override if needed.
  codexBin: "",
  // HTTP + WS listen. 0.0.0.0 so the phone on your LAN / Tailscale can reach it.
  host: "0.0.0.0",
  port: 4123,
  // Shared secret the phone must present. Auto-generated on first run.
  token: "",
  // Working directory new Codex threads start in.
  defaultCwd: os.homedir(),
  // Approval gating. "on-request" = agent escalates to you when it wants to do
  // something outside the sandbox. Use "untrusted" to be prompted for ~everything.
  approvalPolicy: "on-request",
  // "workspace-write" | "read-only" | "danger-full-access"
  sandbox: "workspace-write",
  // Optional model override (null = use Codex default from config.toml).
  model: null,
  reasoningEffort: null,
  // Windows only: keep the system awake while this service is running.
  preventSleep: true,
  // Client identifier (originator) Codex reports upstream. Some API relays only
  // accept "official" Codex clients; the relay drives the official app-server, so
  // it identifies as one. Override if your provider expects a different value.
  originator: "codex_vscode",
};

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
    } catch (e) {
      console.error("[config] failed to parse, using defaults:", e.message);
    }
  }
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(18).toString("base64url");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    console.log("[config] generated new access token");
  } else if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (!cfg.defaultCwd) cfg.defaultCwd = os.homedir(); // empty/missing -> home (cross-platform)
  return cfg;
}

const config = loadConfig();
const sleepPrevention = createSleepPrevention(config);

// ---------------------------------------------------------------------------
// Shared relay state (mirrored to every connected phone)
// ---------------------------------------------------------------------------
const state = {
  codexConnected: false,
  codexVersion: null,
  threadId: null,
  turnId: null,
  cwd: config.defaultCwd,
  status: "idle", // "idle" | "running"
  model: config.model,
  effectiveModel: null,
  reasoningEffort: config.reasoningEffort, effectiveReasoningEffort: null,
  approvalPolicy: config.approvalPolicy,
  sandbox: config.sandbox,
  threadName: null, // user-facing name of the active conversation
  readOnly: false,
  lastDiff: "", // latest unified diff for the current turn
};
const eventLog = []; // Bounded recent window in paged mode; legacy clients retain full snapshots.
let history = null;
const pendingApprovals = new Map(); // key -> { serverReqId, method, approval }

function pushEvent(entry) {
  const raw = { id: crypto.randomUUID(), ts: Date.now(), threadId: state.threadId, ...entry };
  const e = history ? boundEvent(raw, historyPager) : raw;
  const index = eventLog.findIndex((old) => old.id === e.id);
  if (index < 0) eventLog.push(e);
  else eventLog[index] = e;
  if (history) trimRecent(eventLog);
  broadcast({ type: "event", event: e });
  return e;
}

// ---------------------------------------------------------------------------
// Codex app-server client (JSON-RPC over newline-delimited JSON on stdio)
// ---------------------------------------------------------------------------
class CodexClient {
  constructor(bin) {
    this.configuredBin = bin;
    this.bin = bin;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.child = null;
    this.buf = "";
    this.onNotification = () => {};
    this.onServerRequest = () => {};
  }

  start() {
    const bin = resolveCodexBin(this.configuredBin);
    if (!bin) throw new Error("未找到可用 Codex；桌面端版本需包含完整配套文件，请更新或修复安装，或配置独立 CLI 路径");
    if (bin !== this.bin) console.log("[codex] selected binary:", bin);
    this.bin = bin;
    this.child = spawn(this.bin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (d) => this._onData(d));
    this.child.stderr.on("data", (d) =>
      process.stderr.write("[codex stderr] " + d.toString("utf8"))
    );
    const child = this.child;
    this.child.on("exit", (code, sig) => {
      if (this.releasingChild === child) return;
      console.error(`[codex] app-server exited code=${code} sig=${sig}`);
      state.codexConnected = false;
      state.status = "idle"; state.turnId = null; state.readOnly = !!state.threadId;
      permissions.reset();
      promptQueue.disconnect();
      broadcastState();
      // Restart after a short delay to stay resilient.
      setTimeout(() => this._restart(), 1500);
    });
    return this.child;
  }

  async _restart() {
    try {
      this.pending.forEach((p) => p.reject(new Error("codex restarting")));
      this.pending.clear();
      this.buf = "";
      this.start();
      await bootstrapCodex();
    } catch (e) {
      console.error("[codex] restart failed:", e.message);
      setTimeout(() => this._restart(), 3000);
    }
  }

  _onData(chunk) {
    this.buf += chunk.toString("utf8");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error("[codex] non-JSON line:", line.slice(0, 200));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    // Request initiated by the server (e.g. approval) -> needs a response
    if (msg.id !== undefined && msg.method) {
      this.onServerRequest(msg);
      return;
    }
    // Notification (no id)
    if (msg.method) {
      this.onNotification(msg);
    }
  }

  request(method, params) {
    if (this.releasingChild && this.releasingChild === this.child) return Promise.reject(new Error("会话释放期间控制连接重连，请稍后重试"));
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

  respond(id, result) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  respondError(id, code, message) {
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    );
  }
}

const codex = new CodexClient(config.codexBin);
const permissions = new SessionPermissions(state, (method, params) => codex.request(method, params), broadcastState, (threadId, error) => promptQueue.pause(threadId, error));
const historyPager = new HistoryPager(codex);
const models = new ModelSettings(codex, config, (model, settings) => persistModel(CONFIG_PATH, model, settings));
const writers = new WriterControl({ protectedPids: () => [process.pid, codex.child?.pid] });
const promptQueue = new PromptQueue({
  getState: () => state,
  schedule: run => { const task = commandQueue.catch(() => {}).then(run); commandQueue = task; return task; },
  execute: async item => {
    const result = await startTurn(item.text, item.cwd, item.id, item.images);
    if (state.readOnly) throw new Error("会话被占用，消息保留在队列中");
    return result;
  },
  onChange: queue => broadcast({ type: "promptQueue", queue }),
  onSettled: turn => { if (state.turnId === turn.turnId) { state.status = "idle"; broadcastState(); } },
});
const lifecycle = new ThreadLifecycle({
  state, request: (method, params) => codex.request(method, params), queue: promptQueue, permissions, pendingApprovals,
  changed: broadcastState, emit: broadcast, clearCurrent: clearThread,
  recycle: async () => {
    state.codexConnected = false; promptQueue.disconnect(); broadcastState();
    await restartIdleCodex(codex, bootstrapCodex);
  },
});

// ---------------------------------------------------------------------------
// Approval normalization: turn a server->client approval request into a
// phone-friendly card, and map the phone's choice back to the right response.
// ---------------------------------------------------------------------------
function buildApproval(msg) {
  const { method, params, id } = msg;
  const key = crypto.randomUUID();
  let approval;
  switch (method) {
    case "item/commandExecution/requestApproval":
      approval = {
        key,
        kind: "command",
        title: "运行命令",
        command: params.command || "(unknown)",
        cwd: params.cwd || null,
        reason: params.reason || null,
        network: params.networkApprovalContext || null,
        options: [
          { id: "approve", label: "批准", style: "primary" },
          { id: "approveSession", label: "本会话都批准", style: "secondary" },
          { id: "deny", label: "拒绝", style: "danger" },
        ],
      };
      break;
    case "item/fileChange/requestApproval":
      approval = {
        key,
        kind: "file",
        title: "修改文件",
        command: params.grantRoot ? `授予写权限: ${params.grantRoot}` : "(文件改动)",
        cwd: null,
        reason: params.reason || null,
        options: [
          { id: "approve", label: "批准", style: "primary" },
          { id: "approveSession", label: "本会话都批准", style: "secondary" },
          { id: "deny", label: "拒绝", style: "danger" },
        ],
      };
      break;
    case "execCommandApproval": // legacy
      approval = {
        key,
        kind: "exec-legacy",
        title: "运行命令",
        command: Array.isArray(params.command) ? params.command.join(" ") : String(params.command),
        cwd: params.cwd || null,
        reason: params.reason || null,
        options: [
          { id: "approve", label: "批准", style: "primary" },
          { id: "approveSession", label: "本会话都批准", style: "secondary" },
          { id: "deny", label: "拒绝", style: "danger" },
        ],
      };
      break;
    case "applyPatchApproval": // legacy
      approval = {
        key,
        kind: "patch-legacy",
        title: "应用补丁",
        command: "修改: " + Object.keys(params.fileChanges || {}).join(", "),
        cwd: null,
        reason: params.reason || null,
        options: [
          { id: "approve", label: "批准", style: "primary" },
          { id: "approveSession", label: "本会话都批准", style: "secondary" },
          { id: "deny", label: "拒绝", style: "danger" },
        ],
      };
      break;
    case "item/permissions/requestApproval":
      // Granting requires synthesizing a permission profile we can't safely
      // fabricate, so v1 only supports declining cleanly.
      approval = {
        key,
        kind: "permission",
        title: "权限请求",
        command: "(请求额外权限)",
        cwd: null,
        reason: params.reason || null,
        options: [{ id: "deny", label: "拒绝", style: "danger" }],
        note: "v1 暂不支持远程授予权限，只能拒绝。",
      };
      break;
    default:
      return null;
  }
  return { key, serverReqId: id, method, approval };
}

// Map (method, optionId) -> JSON-RPC result body Codex expects.
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
      // Only deny is wired; respond with an error so Codex treats it as not granted.
      return null;
    default:
      return { decision: "decline" };
  }
}

codex.onServerRequest = (msg) => {
  const built = buildApproval(msg);
  if (!built) {
    // Unknown server request: respond with an error so Codex isn't left hanging.
    console.error("[codex] unhandled server request:", msg.method);
    codex.respondError(msg.id, -32601, "unhandled by relay: " + msg.method);
    return;
  }
  pendingApprovals.set(built.key, built);
  pushEvent({ kind: "approval-requested", text: `${built.approval.title}: ${built.approval.command}` });
  broadcast({ type: "approval", approval: built.approval });
};

// ---------------------------------------------------------------------------
// Notification -> normalized feed entry for the phone
// ---------------------------------------------------------------------------
function handleNotification(msg) {
  const { method, params } = msg;
  if (lifecycle.notification(method, params)) return;
  if (params?.threadId && (state.readOnly || params.threadId !== state.threadId)) return;
  if (method.startsWith("item/") && params?.turnId && state.turnId && params.turnId !== state.turnId) return;
  switch (method) {
    case "thread/started":
      if (params?.thread?.id) state.threadId = params.thread.id;
      pushEvent({ kind: "thread", text: "会话已开始" });
      broadcastState();
      break;
    case "turn/started":
      state.turnId = params?.turn?.id || state.turnId;
      promptQueue.started({ threadId: state.threadId, turnId: state.turnId });
      state.status = "running";
      state.lastDiff = "";
      broadcast({ type: "diff", diff: "" });
      pushEvent({ kind: "turn", text: "开始执行…" });
      broadcastState();
      break;
    case "turn/diff/updated":
      state.lastDiff = params?.diff || "";
      broadcast({ type: "diff", diff: state.lastDiff });
      break;
    case "model/rerouted":
      if (params?.threadId === state.threadId && params?.toModel) {
        state.effectiveModel = params.toModel;
        broadcastState();
      }
      break;
    case "thread/settings/updated":
      if (params?.threadId === state.threadId && params?.threadSettings) {
        if (params.threadSettings.model) state.effectiveModel = params.threadSettings.model;
        if (Object.hasOwn(params.threadSettings, "effort")) state.effectiveReasoningEffort = params.threadSettings.effort;
        if (params.threadSettings.sandboxPolicy && params.threadSettings.approvalPolicy) permissions.observe(params.threadSettings);
        broadcastState();
      }
      break;
    case "turn/completed": {
      if (params?.turn?.id && state.turnId && params.turn.id !== state.turnId) break;
      state.status = "idle";
      const usage = params?.turn?.usage || params?.turn?.tokenUsage;
      const tok = usage ? ` (tokens: ${usage.totalTokens ?? usage.total_tokens ?? "?"})` : "";
      for (const event of settleLiveEvents(eventLog, state.threadId, state.turnId, params?.turn?.status)) pushEvent(event);
      pushEvent(completedTurnEvent(params?.turn, tok));
      broadcastState();
      schedulePermissions();
      promptQueue.complete({ threadId: state.threadId, turnId: params?.turn?.id || state.turnId, status: params?.turn?.status, reason: params?.turn?.error?.message });
      break;
    }
    case "item/started":
      describeItem(params?.item, "started", params);
      break;
    case "item/completed":
      describeItem(params?.item, "completed", params);
      break;
    case "item/agentMessage/delta": {
      streamDelta(params, "item:agentMessage", "assistantDelta");
      break;
    }
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta": {
      streamDelta(params, "item:commandExecution", "outputDelta");
      break;
    }
    case "item/reasoning/summaryTextDelta": {
      streamDelta(params, "item:reasoning", "itemDelta", "summary");
      break;
    }
    case "item/reasoning/textDelta": {
      streamDelta(params, "item:reasoning", "itemDelta", "content");
      break;
    }
    case "serverRequest/resolved": {
      // An approval was resolved (by us or elsewhere). Clear matching cards.
      const reqId = params?.requestId ?? params?.id;
      for (const [k, v] of pendingApprovals) {
        if (v.serverReqId === reqId) {
          pendingApprovals.delete(k);
          broadcast({ type: "approvalResolved", key: k, by: "server" });
        }
      }
      break;
    }
    case "error": {
      // ErrorNotification = { error: TurnError{message, additionalDetails}, willRetry, ... }
      const err = params?.error || {};
      let text = err.message || params?.message || "Codex 错误";
      if (err.additionalDetails) text += "\n" + String(err.additionalDetails).slice(0, 400);
      pushEvent({ kind: "error", text });
      break;
    }
    case "remoteControl/status/changed":
      // informational
      break;
    default:
      // ignore the long tail of fine-grained notifications
      break;
  }
}

function describeItem(item, phase, params = {}) {
  const context = { threadId: state.threadId, turnId: params.turnId || state.turnId };
  if (state.readOnly || !context.threadId || !context.turnId) return;
  const previous = eventLog.find(e => e.id === [context.threadId, context.turnId, item?.id].join(":"));
  const event = liveItemEvent(item, phase, context, previous, history ? HISTORY_LIMITS.itemChars : null);
  if (event) pushEvent(event);
}

function streamDelta(params, kind, type, reasoningSource) {
  const text = params?.delta ?? params?.chunk ?? params?.output, itemId = params?.itemId || params?.callId;
  if (typeof text !== "string" || !text || !itemId || state.readOnly || !state.threadId) return;
  if (params.turnId && state.turnId && params.turnId !== state.turnId) return;
  const context = { threadId: state.threadId, turnId: params.turnId || state.turnId, itemId, ...(reasoningSource ? { reasoningSource } : {}) };
  const previous = eventLog.find(e => e.id === [context.threadId, context.turnId, itemId].join(":"));
  if (previous?.live === false || ["completed", "failed", "interrupted", "ended"].includes(previous?.status)) return;
  let event = liveDeltaEvent(previous, context, text, kind, history ? HISTORY_LIMITS.itemChars : null);
  if (!event) return;
  if (history) event = boundEvent(event, historyPager);
  const index = eventLog.findIndex(e => e.id === event.id);
  if (index < 0) eventLog.push(event); else eventLog[index] = event;
  if (history) trimRecent(eventLog);
  broadcast({ type, ...context, kind, text });
}

codex.onNotification = handleNotification;

// ---------------------------------------------------------------------------
// Bootstrap the Codex session (handshake)
// ---------------------------------------------------------------------------
async function bootstrapCodex() {
  const res = await codex.request("initialize", {
    clientInfo: { name: config.originator || "codex_vscode", title: "CodexApp Relay", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  codex.notify("initialized");
  state.codexConnected = true;
  state.codexVersion = (res?.userAgent || "").split(" ")[0] || null;
  console.log("[codex] connected:", res?.userAgent);
  broadcastState();
}

// ---------------------------------------------------------------------------
// Actions triggered by the phone
// ---------------------------------------------------------------------------
async function ensureThread(cwd, model) {
  if (state.threadId) {
    if (state.readOnly) {
      const conflict = await resumeThread(state.threadId);
      if (conflict) { broadcast(conflict); return null; }
    }
    return state.threadId;
  }
  const params = {
    cwd: cwd || state.cwd,
    approvalPolicy: state.approvalPolicy,
    sandbox: state.sandbox,
  };
  params.model = model || await models.resolve(params.cwd);
  const res = await codex.request("thread/start", params);
  state.threadId = res?.thread?.id || res?.threadId || state.threadId;
  state.cwd = params.cwd;
  state.effectiveModel = res?.model || params.model;
  permissions.confirm(res, params, true);
  state.readOnly = false; state.writerReleased = false;
  broadcastState();
  return state.threadId;
}

async function startTurn(text, cwd, echoId, images) {
  images = normalizeImages(images);
  if (!text && !images.length) return;
  const input = buildUserInput(text, images);
  if (state.status === "running") throw new Error("当前任务未完成，请使用消息队列或纠偏");
  const model = await models.resolve(cwd || state.cwd);
  if (!await ensureThread(cwd, model)) return;
  if (state.status === "running") throw new Error("会话仍有运行中的任务，请等待完成后继续队列");
  const effort = await models.resolveEffort(cwd || state.cwd, model, state.effectiveReasoningEffort);
  const requested = permissions.selection(), policy = permissions.turnPolicy();
  const params = {
    threadId: state.threadId,
    input,
    // 每轮显式传入用户选择，避免已有会话沿用旧审批策略。
    approvalPolicy: requested.approvalPolicy,
    sandboxPolicy: policy,
  };
  if (cwd) params.cwd = cwd;
  params.model = model;
  params.effort = effort;
  const echo = pushEvent({ kind: "user", text: text || "[图片]", ...(images.length ? { images: imageEcho(images, true) } : {}), inputEcho: true, ...(echoId ? { id: echoId } : {}) });
  const permissionRevision = permissions.revision;
  const res = await codex.request("turn/start", params);
  permissions.acceptedTurn(requested, policy, permissionRevision);
  const turnId = res?.turn?.id || res?.id || state.turnId;
  if (turnId) pushEvent({ ...echo, turnId });
  state.effectiveModel = model;
  state.effectiveReasoningEffort = effort;
  state.turnId = res?.turn?.id || res?.id || state.turnId;
  state.status = "running";
  broadcastState();
  return { threadId: state.threadId, turnId: res?.turn?.id || res?.id || null };
}

async function steerTurn(text, images) {
  images = normalizeImages(images);
  const input = buildUserInput(text, images);
  if (!state.threadId || !state.turnId) throw new Error("没有进行中的任务可纠偏");
  pushEvent({ kind: "user", text: "↪ " + (text || "[图片]"), ...(images.length ? { images: imageEcho(images, true) } : {}) });
  await codex.request("turn/steer", {
    threadId: state.threadId,
    expectedTurnId: state.turnId,
    input,
  });
}

async function interruptTurn(threadId = state.threadId, turnId = state.turnId) {
  promptQueue.pause(threadId, "任务已请求停止，队列暂停");
  if (!threadId || !turnId) throw new Error("没有可停止的任务；请先接续会话。");
  await codex.request("turn/interrupt", { threadId, turnId });
  pushEvent({ kind: "turn", text: "已请求中断" });
}

async function resolveApproval(key, optionId) {
  const item = pendingApprovals.get(key);
  if (!item) throw new Error("审批已失效");
  pendingApprovals.delete(key);
  const result = approvalResult(item.method, optionId);
  if (result === null) {
    codex.respondError(item.serverReqId, -32000, "denied (relay)");
  } else {
    codex.respond(item.serverReqId, result);
  }
  pushEvent({
    kind: "approval-resolved",
    text: `${item.approval.title}: ${optionId === "deny" ? "已拒绝" : "已批准"}`,
  });
  broadcast({ type: "approvalResolved", key, by: "user" });
}

async function newThread(cwd, paged = false) {
  if (state.status !== "running") promptQueue.select(null);
  if (state.status === "running") throw new Error("请先停止当前任务再新建会话");
  await lifecycle.beforeSwitch();
  state.threadId = null;
  permissions.reset();
  state.turnId = null;
  state.status = "idle";
  state.threadName = null;
  state.readOnly = false;
  state.writerReleased = false;
  state.effectiveReasoningEffort = null;
  state.effectiveModel = null;
  state.lastDiff = "";
  eventLog.length = 0;
  history = paged ? { paged: true, nextCursor: null } : null;
  broadcast(snapshot());
  if (cwd) state.cwd = cwd;
  await ensureThread(cwd);
  pushEvent({ kind: "thread", text: "新建会话 @ " + state.cwd });
}

async function buildProjectTree() {
  return listProjectTree(codex, CODEX_HOME);
}

async function readThread(threadId, paged = false, requestId, checkWriter = false) {
  if (state.status === "running") throw new Error("请先停止当前任务再切换会话");
  if (checkWriter) {
    const conflict = await writers.inspectExternal(threadId);
    if (conflict) return { ...conflict, onOpen: true, requestId };
  }
  const page = paged ? await historyPager.open(threadId) : null;
  const t = page?.thread || await readThreadHistory(codex, threadId);
  await lifecycle.beforeSwitch();
  promptQueue.select(t.id);
  state.threadId = t.id;
  state.cwd = t.cwd || state.cwd;
  state.threadName = t.name || t.preview || null;
  state.turnId = null;
  state.status = "idle";
  state.readOnly = true;
  state.writerReleased = false;
  permissions.reset();
  state.effectiveModel = null;
  state.effectiveReasoningEffort = null;
  state.lastDiff = "";
  eventLog.splice(0, eventLog.length, ...(page?.events || historyEvents(t)));
  history = page ? { paged: true, nextCursor: page.nextCursor } : null;
  broadcast({ ...snapshot(), requestId });
}

// Resume with recent display history; model context remains owned by Codex.
async function resumeThread(threadId) {
  if (state.status === "running" && state.threadId !== threadId) throw new Error("请先停止当前任务再切换会话");
  if (state.threadId !== threadId) await lifecycle.beforeSwitch();
  let res;
  const requested = permissions.selection();
  try {
    res = await codex.request("thread/resume", { threadId, ...requested, ...(history ? { excludeTurns: true, initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" } } : {}) });
  } catch (error) {
    if (!isWriterConflict(error)) throw error;
    return writers.inspect(threadId);
  }
  const t = res?.thread || {};
  promptQueue.select(t.id || threadId);
  state.threadId = t.id || threadId;
  state.cwd = t.cwd || state.cwd;
  const activeTurn = (res.initialTurnsPage?.data || t.turns || []).findLast((turn) => turn.status === "inProgress");
  state.turnId = activeTurn?.id || null;
  state.status = activeTurn ? "running" : "idle";
  state.lastDiff = "";
  state.threadName = t.name || t.preview || null;
  state.effectiveModel = res?.model || null;
  state.effectiveReasoningEffort = res?.reasoningEffort || null;

  state.readOnly = false;
  state.writerReleased = false;
  permissions.confirm(res, requested);
  const beforePage = new Map(eventLog.map(e => [e.id, e]));
  const page = history ? await historyPager.page(state.threadId) : null;
  if (page) {
    const changes = eventLog.filter(e => (e.live && e.threadId === state.threadId) || beforePage.get(e.id) !== e);
    const merged = [...new Map([...page.events, ...changes].map(e => [e.id, e])).values()];
    eventLog.splice(0, eventLog.length, ...merged); trimRecent(eventLog);
    const pagedActive = page.turns.find(t => t.status === "inProgress");
    if (!activeTurn && pagedActive && !changes.some(e => e.kind === "turn")) { state.turnId = pagedActive.id; state.status = "running"; }
    history = { paged: true, nextCursor: page.nextCursor };
  } else {
    const loaded = await readThreadHistory(codex, state.threadId, t);
    eventLog.splice(0, eventLog.length, ...historyEvents(loaded));
  }

  // Push a fresh snapshot so every client repopulates its feed with the history.
  broadcast(snapshot());
}

function clearThread() {
  Object.assign(state, { threadId: null, turnId: null, status: "idle", threadName: null, lastDiff: "", readOnly: false, writerReleased: false, effectiveModel: null, effectiveReasoningEffort: null });
  permissions.reset(); pendingApprovals.clear(); eventLog.length = 0;
  if (history) history = { paged: true, nextCursor: null };
  broadcast(snapshot());
}

// ---------------------------------------------------------------------------
// HTTP (serve PWA) + WebSocket (phone link)
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, codexConnected: state.codexConnected, sleepPrevention: sleepPrevention.status() }));
    return;
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(WEBAPP_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(WEBAPP_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 8 * 1048576 });
const clients = new Set();
let commandQueue = Promise.resolve();

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(s);
}
function broadcastState() {
  broadcast({ type: "state", state });
}

function schedulePermissions() {
  if (state.permissions.pending) commandQueue = commandQueue.catch(() => {}).then(() => permissions.apply());
}

function snapshot() {
  return {
    type: "hello",
    imageUpload: { supported: true, ...IMAGE_LIMITS },
    threadManagement: { delete: true, release: true },
    state,
    config: { approvalPolicy: state.approvalPolicy, sandbox: state.sandbox, cwd: state.cwd, model: state.model, reasoningEffort: state.reasoningEffort },
    pendingApprovals: [...pendingApprovals.values()].map((v) => v.approval),
    recentEvents: eventLog,
    history,
    promptQueue: promptQueue.snapshot(),
    diff: state.lastDiff,
  };
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  if (token !== config.token) {
    send(ws, { type: "error", message: "无效 token" });
    ws.close(4001, "unauthorized");
    return;
  }
  clients.add(ws);
  ws.on("error", () => {});
  if (url.searchParams.get("history") === "paged") {
    history ||= { paged: true, nextCursor: null };
    const bounded = eventLog.map(e => boundEvent(e, historyPager));
    eventLog.splice(0, eventLog.length, ...bounded); trimRecent(eventLog);
  }
  console.log(`[ws] phone connected (${clients.size} total)`);
  send(ws, snapshot());

  ws.on("message", async (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === "historyPage" || m.type === "readHistoryItem") {
      const task = m.type === "historyPage" ? historyPager.page(m.threadId, m.cursor) : historyPager.item(m.threadId, m.detailCursor, m.offset);
      task.then(data => send(ws, { type: m.type === "historyPage" ? "historyPage" : "historyItem", ...data, requestId: m.requestId })).catch(e => send(ws, { type: "error", message: e.message, requestId: m.requestId }));
      return;
    }
    commandQueue = commandQueue.catch(() => {}).then(async () => {
      try {
        switch (m.type) {
          case "enqueuePrompt": {
            const images = normalizeImages(m.images);
            if (!state.codexConnected) throw new Error("Codex 未连接");
            if (!state.threadId && !m.threadId) await ensureThread(m.cwd);
            const receipt = promptQueue.enqueue({ requestId: m.requestId, threadId: m.threadId || state.threadId, text: String(m.text || "").trim(), cwd: m.cwd, images });
            send(ws, { type: "promptAccepted", ...receipt, queue: promptQueue.snapshot() });
            break;
          }
          case "cancelQueuedPrompt": promptQueue.cancel(m.threadId, m.id); break;
          case "pauseQueue": promptQueue.pause(m.threadId); break;
          case "resumeQueue": promptQueue.resume(m.threadId); break;
          case "prompt":
            await startTurn(String(m.text || "").trim(), m.cwd, m.requestId, m.images);
            break;
          case "steer":
            await steerTurn(String(m.text || "").trim(), m.images);
            break;
          case "interrupt":
            await interruptTurn(m.threadId, m.turnId);
            break;
          case "releaseThread": {
            const result = await lifecycle.release(m.threadId);
            send(ws, { type: "threadReleased", ...result, requestId: m.requestId });
            break;
          }
          case "deleteThread":
            await lifecycle.remove(m.threadId, m.confirmed);
            send(ws, { type: "threadDeleted", threadId: m.threadId, requestId: m.requestId });
            broadcast({ type: "projectTree", ...await buildProjectTree() });
            break;
          case "approval":
            await resolveApproval(m.key, m.optionId);
            break;
          case "newThread":
            await newThread(m.cwd, m.historyMode === "paged" || !!history);
            break;
          case "listThreads": {
            const tree = await buildProjectTree();
            send(ws, { type: "projectTree", ...tree });
            break;
          }
          case "resumeThread": {
            const conflict = await resumeThread(m.threadId);
            if (conflict) send(ws, conflict);
            break;
          }
          case "readThread": {
            const conflict = await readThread(m.threadId, m.historyMode === "paged", m.requestId, m.checkWriter === true);
            if (conflict) send(ws, conflict);
            break;
          }
          case "inspectWriter":
            send(ws, await writers.inspect(m.threadId));
            break;
          case "takeoverThread": {
            await writers.terminate(m.threadId, m.token, m.confirmed === true);
            pushEvent({ kind: "thread", text: "占用进程已退出，正在尝试接续会话" });
            const conflict = await resumeThread(m.threadId);
            if (conflict) send(ws, conflict);
            break;
          }
          case "listModels":
            send(ws, await models.list(m.cwd || state.cwd));
            break;
          case "setConfig":
            models.update(m);
            state.model = config.model || null;
            state.reasoningEffort = config.reasoningEffort || null;
            state.approvalPolicy = config.approvalPolicy;
            state.sandbox = config.sandbox;
            if (m.cwd) state.cwd = m.cwd;
            permissions.selected();
            broadcastState();
            send(ws, { type: "configSaved", requestId: m.requestId });
            await permissions.apply();
            break;
          case "getState":
            if (m.historyMode === "paged") {
              history ||= { paged: true, nextCursor: null };
              const bounded = eventLog.map(e => boundEvent(e, historyPager));
              eventLog.splice(0, eventLog.length, ...bounded); trimRecent(eventLog);
            }
            send(ws, snapshot());
            break;
          default:
            break;
        }
      } catch (e) {
        send(ws, { type: "error", message: e.message, requestId: m.requestId });
        pushEvent({ kind: "error", text: e.message });
      }
    });
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[ws] phone disconnected (${clients.size} left)`);
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// 每次启动控制子进程重新选择可用版本，不将自动路径写回配置。
async function main() {
  codex.start();
  await bootstrapCodex();
  await sleepPrevention.start();
  httpServer.listen(config.port, config.host, () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal && !n.address.startsWith("169."))
      .map((n) => n.address);
    console.log("");
    console.log("  CodexApp relay is up.");
    for (const ip of ips) console.log(`  PWA:   http://${ip}:${config.port}/`);
    console.log(`  Token: ${config.token}`);
    console.log(`  (open a PWA URL on your iPhone, paste the token, then Add to Home Screen)`);
    console.log("");
  });
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
