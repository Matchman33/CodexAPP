import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WINDOWS_WRITER_SCRIPT } from "./windowsWriterScript.mjs";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";

export function validateThreadId(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("无效的会话 ID");
  return id.toLowerCase();
}

export function isWriterConflict(error) {
  return /already has an active writer/i.test(error?.message || "");
}

async function windowsRunner({ lockFile, action, pid = 0, started = "", affectedThreads = [] }) {
  const command = "& {\n" + WINDOWS_WRITER_SCRIPT + "\n} -LockFile " + quote(lockFile) +
    " -Action " + quote(action) + " -WriterPid " + Number(pid) + " -WriterStarted " + quote(started) +
    " -ExpectedThreads " + quote([...affectedThreads].sort().join(","));
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  } catch (error) {
    throw new Error("无法检查或结束占用进程（可能权限不足或占用已变化），请重试检查；也可在电脑端关闭对应会话。", { cause: error });
  }
}

export class WriterControl {
  constructor({ home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), platform = process.platform, protectedPids = () => [process.pid], runner = windowsRunner, now = Date.now } = {}) {
    Object.assign(this, { home, platform, protectedPids, runner, now });
    this.confirmations = new Map();
  }

  lockFile(threadId) {
    return path.join(this.home, "thread-writer-locks", validateThreadId(threadId) + ".lock");
  }

  async inspect(id) {
    const threadId = validateThreadId(id);
    for (const [key, value] of this.confirmations) if (value.expires < this.now()) this.confirmations.delete(key);
    if (this.platform !== "win32") return { type: "writerConflict", threadId, owners: [], message: "此会话由其他进程占用；当前仅 Windows 支持识别并结束占用进程。" };
    let result;
    try {
      result = await this.runner({ lockFile: this.lockFile(threadId), action: "inspect" });
    } catch (error) {
      return { type: "writerConflict", threadId, owners: [], message: error.message };
    }
    const protectedPids = this.protectedPids();
    const owners = (result.owners || []).map((owner) => {
      const canTerminate = result.owners.length === 1 && !!owner.canTerminate && !protectedPids.includes(owner.pid) && Number.isInteger(owner.pid) && owner.pid > 0;
      const token = canTerminate ? crypto.randomBytes(24).toString("base64url") : null;
      const affectedThreads = (owner.affectedThreads || []).map(validateThreadId).sort();
      if (token) {
        // Bound stored confirmations even if a client repeatedly inspects a busy thread.
        if (this.confirmations.size >= 100) this.confirmations.delete(this.confirmations.keys().next().value);
        this.confirmations.set(token, { threadId, pid: owner.pid, started: owner.started, affectedThreads, expires: this.now() + 60000 });
      }
      return { pid: owner.pid, name: owner.name || "codex", affectedThreads, canTerminate, token };
    });
    return {
      type: "writerConflict", threadId, owners,
      message: owners.length ? "会话已被其他进程占用。结束 Codex 进程会影响它持有的所有会话，已产生的改动不会回滚，已启动的子进程可能继续运行。" : "未能定位占用进程，可能占用刚刚变化；请重试接续或在电脑端关闭会话。",
    };
  }

  async terminate(id, token, confirmed) {
    const threadId = validateThreadId(id);
    const choice = this.confirmations.get(token);
    if (confirmed !== true || !choice || choice.threadId !== threadId || choice.expires < this.now()) throw new Error("请重新检查占用进程并确认结束；原确认已失效。");
    this.confirmations.delete(token);
    if (this.protectedPids().includes(choice.pid)) throw new Error("不能结束当前中继自己的控制进程，请使用停止任务。");
    const result = await this.runner({ lockFile: this.lockFile(threadId), action: "terminate", ...choice });
    if (!result.terminated) throw new Error("占用进程未确认退出，尚未接管会话。");
    return choice.pid;
  }
}
