import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import headless from "@xterm/headless";
import serialization from "@xterm/addon-serialize";
import { spawnTerminal } from "./terminalPty.mjs";

const nativeRequire = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
export const TERMINAL_LIMITS = { sessions: 8, input: 16384, outstanding: 131072, scrollback: 500, columns: 240, rows: 80 };
function dimensions(cols, rows) {
  if (!Number.isInteger(cols) || cols < 10 || cols > TERMINAL_LIMITS.columns || !Number.isInteger(rows) || rows < 2 || rows > TERMINAL_LIMITS.rows) throw new Error("终端尺寸无效");
}
function defaultShell() {
  if (process.platform === "win32") return { file: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo"], name: "PowerShell" };
  const configured = process.env.SHELL || os.userInfo().shell;
  const file = configured && path.isAbsolute(configured) && fs.existsSync(configured) ? configured : "/bin/sh";
  return { file, args: [], name: path.basename(file) };
}

export class TerminalManager {
  constructor(emit, options = {}) {
    this.emit = emit; this.records = new Map(); this.shell = options.shell || defaultShell(); this.error = null; this.opening = 0;
    try {
      if (options.enabled === false) throw new Error("管理员已禁用系统终端");
      if (!options.spawn) nativeRequire("node-pty");
      this.spawn = options.spawn || spawnTerminal;
      if (process.platform === "win32" && !options.spawn) {
        const dll = path.join(path.dirname(nativeRequire.resolve("node-pty/package.json")), "build", "Release", "conpty", "conpty.dll");
        if (!fs.existsSync(dll)) throw new Error("请先运行 npm run prepare:terminal 准备 Windows 终端运行文件");
      }
    } catch (error) { this.spawn = null; this.error = "终端不可用：" + error.message.slice(0, 500); }
  }
  get activeCount() { return this.opening + [...this.records.values()].filter(r => r.status === "running").length; }
  capabilities() { return { supported: !!this.spawn, error: this.error, shell: this.shell.name, ...TERMINAL_LIMITS }; }
  metadata(r) { return { terminalId: r.id, threadId: r.threadId, cwd: r.cwd, shell: r.shell, status: r.status, exitCode: r.exitCode, cols: r.cols, rows: r.rows, controller: r.controller }; }
  list() { return [...this.records.values()].map(r => this.metadata(r)); }
  changed() { this.emit({ type: "terminalList", terminals: this.list(), activeCount: this.activeCount }); }
  get(id) { const r = this.records.get(id); if (!r) throw new Error("终端已结束或服务已重启，请新建终端"); return r; }
  controlled(m, clientId) {
    const r = this.get(m.terminalId);
    if (r.status !== "running") throw new Error("终端进程已退出");
    if (r.controller !== clientId || r.lease !== m.lease || !r.viewers.has(clientId)) throw new Error("当前页面没有终端控制权，请先连接或接管输入");
    if (r.viewers.get(clientId).paused) throw new Error("终端显示已暂停，请先恢复输出");
    return r;
  }
  async open({ cwd, threadId = null, cols = 80, rows = 24 }, clientId) {
    if (!this.spawn) throw new Error(this.error);
    dimensions(cols, rows);
    if (this.activeCount >= TERMINAL_LIMITS.sessions) throw new Error("最多运行 8 个终端，请先结束不使用的终端");
    for (const [id, r] of this.records) if (r.status !== "running" && this.records.size >= TERMINAL_LIMITS.sessions) { r.screen.dispose(); this.records.delete(id); }
    cwd = fs.realpathSync(cwd || os.homedir());
    if (!fs.statSync(cwd).isDirectory()) throw new Error("终端工作目录不存在");
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    for (const key of ["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE", "CODEXAPP_MANAGED", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) delete env[key];
    this.opening++;
    let pty;
    try { pty = await this.spawn(this.shell.file, this.shell.args, { cwd, env, cols, rows, name: "xterm-256color", useConpty: true, useConptyDll: process.platform === "win32" }); }
    finally { this.opening--; }
    const screen = new headless.Terminal({ cols, rows, scrollback: TERMINAL_LIMITS.scrollback, allowProposedApi: true });
    const serializer = new serialization.SerializeAddon(); screen.loadAddon(serializer);
    const r = { id: crypto.randomUUID(), cwd, threadId, shell: this.shell.name, pty, screen, serializer, cols, rows,
      status: "running", exitCode: null, seq: 0, queued: 0, inputSeq: 0, viewers: new Map(), controller: null, lease: null };
    r.exited = new Promise(resolve => { r.resolveExit = resolve; });
    this.records.set(r.id, r);
    // The server answers terminal queries even while every browser is disconnected.
    screen.onData(data => { if (r.status === "running") { try { pty.write(data); } catch {} } });
    pty.onData(data => this.output(r, data));
    pty.onExit(({ exitCode }) => {
      r.status = "exited"; r.exitCode = exitCode; r.resolveExit();
      screen.write("", () => {
        for (const clientId of r.viewers.keys()) this.emit({ type: "terminalExit", ...this.metadata(r), clientId });
        this.changed();
      });
    });
    const snapshot = await this.attach({ terminalId: r.id }, clientId);
    this.changed(); return snapshot;
  }
  output(r, data) {
    for (let start = 0; start < data.length;) {
      let end = Math.min(start + 4096, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const text = data.slice(start, end); start = end;
      r.queued += text.length;
      if (r.queued > 65536) r.pty.pause();
      r.screen.write(text, () => {
        r.queued -= text.length; r.seq++;
        if (r.queued < 16384 && r.status === "running") r.pty.resume();
        for (const [clientId, viewer] of r.viewers) {
          if (viewer.paused) continue;
          if (viewer.pendingChars + text.length > TERMINAL_LIMITS.outstanding) {
            viewer.paused = true; viewer.pending.clear(); viewer.pendingChars = 0;
            this.emit({ type: "terminalPaused", terminalId: r.id, clientId, message: "输出过快，页面同步已暂停，可重新连接恢复当前屏幕" });
            continue;
          }
          viewer.pending.set(r.seq, text.length); viewer.pendingChars += text.length;
          this.emit({ type: "terminalOutput", terminalId: r.id, seq: r.seq, data: text, clientId });
        }
      });
    }
  }
  async attach({ terminalId, takeControl = false }, clientId) {
    if (typeof takeControl !== "boolean") throw new Error("终端接管参数无效");
    const r = this.get(terminalId);
    await new Promise(resolve => r.screen.write("", resolve));
    if (!r.controller || r.controller === clientId || takeControl) {
      r.controller = clientId; r.lease = crypto.randomUUID(); r.inputSeq = 0;
    }
    r.viewers.set(clientId, { pending: new Map(), pendingChars: 0, paused: false });
    let data = r.serializer.serialize({ scrollback: TERMINAL_LIMITS.scrollback });
    if (data.length > 1048576) data = r.serializer.serialize({ scrollback: 0 });
    for (const id of r.viewers.keys()) if (id !== clientId) this.emit({ type: "terminalControl", ...this.metadata(r), clientId: id, canInput: r.controller === id });
    this.changed();
    return { type: "terminalAttached", ...this.metadata(r), seq: r.seq, data, canInput: r.controller === clientId, lease: r.controller === clientId ? r.lease : null };
  }
  input(m, clientId) {
    const r = this.controlled(m, clientId);
    if (typeof m.data !== "string" || !m.data.length || m.data.length > TERMINAL_LIMITS.input) throw new Error("终端输入长度无效");
    if (!Number.isSafeInteger(m.inputSeq) || m.inputSeq < 1) throw new Error("终端输入序号无效");
    if (m.inputSeq <= r.inputSeq) return;
    if (m.inputSeq !== r.inputSeq + 1) throw new Error("终端输入确认中断，请重新连接；未自动重放输入");
    r.pty.write(m.data); r.inputSeq = m.inputSeq;
  }
  resize(m, clientId) {
    const r = this.controlled(m, clientId); dimensions(m.cols, m.rows);
    if (r.cols === m.cols && r.rows === m.rows) return;
    r.pty.resize(m.cols, m.rows); r.screen.resize(m.cols, m.rows); r.cols = m.cols; r.rows = m.rows;
    for (const id of r.viewers.keys()) if (id !== clientId) this.emit({ type: "terminalResized", terminalId: r.id, cols: r.cols, rows: r.rows, clientId: id });
  }
  ack(m, clientId) {
    const r = this.get(m.terminalId), v = r.viewers.get(clientId);
    if (!v || !Number.isSafeInteger(m.seq) || m.seq > r.seq) return;
    for (const [seq, length] of v.pending) if (seq <= m.seq) { v.pending.delete(seq); v.pendingChars -= length; }
  }
  detach(clientId, terminalId) {
    for (const r of this.records.values()) {
      if (terminalId && r.id !== terminalId) continue;
      r.viewers.delete(clientId);
      if (r.controller === clientId) {
        r.controller = null; r.lease = null;
        for (const id of r.viewers.keys()) this.emit({ type: "terminalControl", ...this.metadata(r), canInput: false, clientId: id });
      }
    }
    this.changed();
  }
  async close(m, clientId) {
    const r = this.get(m.terminalId);
    if (m.confirmed !== true) throw new Error("请确认结束终端及其中的程序");
    if (r.status === "running") {
      this.controlled(m, clientId);
      let timer;
      try {
        r.pty.kill();
        await Promise.race([r.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("终端尚未退出，请稍后重试")), 8000); })]);
      } finally { clearTimeout(timer); }
    }
    await new Promise(resolve => r.screen.write("", resolve));
    this.records.delete(r.id); r.screen.dispose(); this.changed();
    return { type: "terminalClosed", terminalId: r.id };
  }
  dispose() { for (const r of this.records.values()) { if (r.status === "running") r.pty.kill(); else r.screen.dispose(); } }
}
