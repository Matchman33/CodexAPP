import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import { createLocalRelay, relayDefaults } from "../relay/transport.mjs";
import { persistModel } from "./modelSettings.mjs";
import { watchSocket } from "./socketLiveness.mjs";

// Agent 只持有传输连接；直连服务是会话、队列、审批和终端的唯一所有者。
export class SharedAgentHub {
  clients = new Map();
  state = { codexConnected: false };
  constructor({ config, base, root, emit, sleepStatus, sleepEvents, webDir }) {
    Object.assign(this, { emit, sleepStatus, sleepEvents });
    const projectConfig = path.join(root, "codexapp.config.json");
    const sourceProject = fs.existsSync(path.join(root, "relay", "server.mjs"));
    this.configPath = config.relayConfigPath || process.env.CODEXAPP_RELAY_CONFIG || (sourceProject || fs.existsSync(projectConfig) ? projectConfig : path.join(base, "relay.config.json"));
    const configExists = fs.existsSync(this.configPath);
    const saved = configExists ? JSON.parse(fs.readFileSync(this.configPath, "utf8")) : { ...config, port: config.relayPort ?? 4123 };
    this.config = { ...relayDefaults, ...saved };
    if (process.env.PORT) this.config.port = Number(process.env.PORT);
    if (process.env.HOST) this.config.host = process.env.HOST;
    for (const key of ["email", "password", "sessionToken", "loginRequired"]) delete this.config[key];
    if (!this.config.token) {
      this.config.token = crypto.randomBytes(24).toString("base64url");
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      try { fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { mode: 0o600, flag: configExists ? "w" : "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; Object.assign(this.config, JSON.parse(fs.readFileSync(this.configPath, "utf8"))); }
    }
    this.dataDir = process.env.CODEXAPP_DATA_DIR || (this.configPath === projectConfig
      ? path.join(os.homedir(), ".codexapp", "relay-" + crypto.createHash("sha256").update(root).digest("hex").slice(0, 12))
      : path.join(base, "sessions"));
    this.webDir = [process.env.CODEXAPP_WEB_DIR, webDir, path.join(root, "web"), path.join(path.dirname(process.execPath), "web")].find(p => p && fs.existsSync(path.join(p, "index.html")));
  }
  restoreQueues() {}
  snapshot() { return this.latest || { type: "hello", state: this.state }; }
  start() {
    if (this.stopped) return Promise.reject(new Error("共享连接已停止"));
    if (this.starting) return this.starting;
    if (this.control?.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    this.starting = this.startRuntime().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startRuntime() {
    try { this.control = await this.openSocket("cloud-control-" + crypto.randomUUID(), true); }
    catch (error) {
      if (error.code !== "ECONNREFUSED") throw error;
      const owner = createLocalRelay({ config: this.config, dataDir: this.dataDir, webDir: this.webDir,
        saveModel: (model, settings) => persistModel(this.configPath, model, settings), sleepStatus: this.sleepStatus, sleepEvents: this.sleepEvents });
      try { this.config.port = await owner.start(); this.owner = owner; }
      catch (e) { if (e.code !== "EADDRINUSE") throw e; }
      this.control = await this.openSocket("cloud-control-" + crypto.randomUUID(), true);
    }
    this.latest = this.control.snapshot; Object.assign(this.state, this.latest.state);
    this.owner?.hub.ensureConnected();
  }
  openSocket(clientId, control = false) {
    return new Promise((resolve, reject) => {
      const host = this.config.host === "::" ? "[::1]" : this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host;
      const url = new URL("ws://" + host + ":" + this.config.port + "/ws");
      url.searchParams.set("token", this.config.token); url.searchParams.set("clientId", clientId);
      const ws = new WebSocket(url, { handshakeTimeout: 10000 }), entry = { ws, clientId, control, ready: false, snapshot: null };
      watchSocket(ws);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("本机中继连接超时")); }, 10000);
      ws.on("error", error => { if (!entry.ready) { clearTimeout(timer); reject(error); } });
      ws.on("message", raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (!entry.ready) {
          if (m.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(m.message)); return; }
          if (m.type !== "hello") return;
          if (m.sharedRuntime?.version !== 1) { clearTimeout(timer); ws.close(); reject(new Error("本机中继版本过旧，请更新并重启中继后连接云 Agent")); return; }
          clearTimeout(timer); entry.ready = true; entry.snapshot = m; resolve(entry); return;
        }
        if (control) {
          if (m.type === "connectionState") { this.state.codexConnected = m.codexConnected; this.emit(m); }
        } else if (this.clients.get(clientId)?.entry === entry) this.emit({ ...m, clientId });
      });
      ws.on("close", () => {
        clearTimeout(timer);
        if (!entry.ready) { reject(new Error("本机中继已断开，请检查访问 Token")); return; }
        if (control && this.control === entry) {
          this.control = null; this.state.codexConnected = false; this.emit({ type: "connectionState", codexConnected: false });
          if (!this.stopped) this.scheduleRecovery();
        } else {
          const record = this.clients.get(clientId);
          if (record?.entry === entry) { record.entry = null; if (!this.stopped) this.scheduleRecovery(); }
        }
      });
    });
  }
  scheduleRecovery() {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = null;
      if (this.stopped) return;
      try {
        await this.start();
        for (const [id, record] of this.clients) if (!record.entry) {
          const snapshot = await this.attach(id);
          if (this.clients.has(id)) this.emit({ ...snapshot, clientId: id });
        }
      } catch { if (!this.stopped) this.scheduleRecovery(); }
    }, 1000);
  }
  async attach(clientId) {
    let record = this.clients.get(clientId);
    if (!record) { record = {}; this.clients.set(clientId, record); }
    if (record.entry?.ws.readyState === WebSocket.OPEN) return record.entry.snapshot;
    if (!record.pending) record.pending = (async () => {
      await this.start();
      const entry = await this.openSocket(clientId);
      if (this.clients.get(clientId) !== record) { entry.ws.close(); throw new Error("客户端已断开"); }
      record.entry = entry; return entry.snapshot;
    })().finally(() => { record.pending = null; });
    return record.pending;
  }
  async dispatch(message, clientId) {
    await this.attach(clientId);
    const entry = this.clients.get(clientId)?.entry;
    if (entry?.ws.readyState !== WebSocket.OPEN) throw new Error("本机中继已断开，请稍后重试");
    entry.ws.send(JSON.stringify(message));
  }
  disconnect(clientId) {
    const record = this.clients.get(clientId); this.clients.delete(clientId); record?.entry?.ws.close();
  }
  async stop() {
    this.stopped = true; clearTimeout(this.recoveryTimer); this.recoveryTimer = null;
    try { await this.starting; } catch {}
    for (const id of this.clients.keys()) this.disconnect(id);
    this.control?.ws.close(); this.control = null;
    if (this.owner) await this.owner.close();
  }
}
