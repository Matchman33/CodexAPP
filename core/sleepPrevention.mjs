import { spawn } from "node:child_process";
import path from "node:path";
import { EventEmitter } from "node:events";

export const WINDOWS_SLEEP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CodexAppSleepPrevention {
    const uint Continuous = 0x80000000;
    const uint SystemRequired = 0x00000001;
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint SetThreadExecutionState(uint flags);

    public static void Run() {
        // Hold and release on the same thread. EOF means the parent has exited.
        if (SetThreadExecutionState(Continuous | SystemRequired) == 0)
            throw new InvalidOperationException("SetThreadExecutionState failed");
        try {
            Console.WriteLine("{\"event\":\"ready\"}");
            Console.Out.Flush();
            string line;
            while ((line = Console.ReadLine()) != null && line != "stop") {}
        } finally {
            if (SetThreadExecutionState(Continuous) == 0)
                throw new InvalidOperationException("Releasing execution state failed");
            Console.WriteLine("{\"event\":\"released\"}");
            Console.Out.Flush();
        }
    }
}
'@
  [CodexAppSleepPrevention]::Run()
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export class SleepPrevention extends EventEmitter {
  constructor({ enabled = true, platform = process.platform, spawnHelper = spawn, lifetime = process, logger = console, startupTimeout = 15000, stopTimeout = 2000, retryBaseDelay = 1000, maxRetryDelay = 30000 } = {}) {
    super();
    Object.assign(this, { enabled, platform, spawnHelper, lifetime, logger, startupTimeout, stopTimeout, retryBaseDelay, maxRetryDelay });
    this.child = null;
    this.starting = null;
    this.stopping = null;
    this.active = false;
    this.error = null;
    this.phase = !enabled ? "disabled" : platform !== "win32" ? "unsupported" : "idle";
    this.desired = false; this.retryTimer = null; this.nextRetryAt = null; this.retryCount = 0;
    this.exitHandler = () => {
      this.desired = false; this.clearRetry();
      // Kill only our helper; Windows clears its thread-scoped power request.
      try { this.child?.kill(); } catch {}
    };
  }

  status() {
    return { supported: this.platform === "win32", enabled: this.enabled, active: this.active, error: this.error, phase: this.phase, retryCount: this.retryCount, nextRetryAt: this.nextRetryAt };
  }
  changed() { this.emit("status", this.status()); }
  clearRetry() { clearTimeout(this.retryTimer); this.retryTimer = null; this.nextRetryAt = null; }
  retry() {
    if (!this.desired || this.retryTimer) return;
    const delay = Math.min(this.maxRetryDelay, this.retryBaseDelay * 2 ** Math.min(this.retryCount++, 16));
    this.phase = "retrying"; this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null; this.nextRetryAt = null;
      if (this.desired) void this.start();
    }, delay);
    this.retryTimer.unref?.(); this.changed();
  }

  start() {
    if (!this.enabled || this.platform !== "win32") return Promise.resolve(this.status());
    this.desired = true;
    if (!this.lifetime.listeners("exit").includes(this.exitHandler)) this.lifetime.once("exit", this.exitHandler);
    this.clearRetry();
    if (this.stopping) return this.stopping.then(() => this.desired ? this.start() : this.status());
    if (this.active) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    if (this.child) {
      this.stopping = this._stop().finally(() => { this.stopping = null; });
      return this.stopping.then(() => this.desired ? this.start() : this.status());
    }
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  _start() {
    this.phase = "starting"; this.changed();
    return new Promise((resolve) => {
      let child, settled = false, buffer = "", stderr = "";
      const finish = (error, cancelled = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelStartup = null;
        if (cancelled) {
          this.phase = "stopped";
          try { child?.kill(); } catch {}
          this.changed();
        } else if (error) {
          this.error = error;
          this.logger.warn("[power] sleep prevention unavailable: " + error + " (will retry automatically)");
          try { child?.kill(); } catch {}
          this.retry();
        } else {
          this.active = true; this.error = null; this.phase = "active"; this.retryCount = 0;
          child.unref?.();
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
          this.logger.log("[power] automatic sleep prevention active (display may turn off)");
          this.changed();
        }
        resolve(this.status());
      };
      const timer = setTimeout(() => finish("helper startup timed out"), this.startupTimeout);
      this.cancelStartup = () => finish(null, true);
      try {
        const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        child = this.spawnHelper(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_SLEEP_SCRIPT, "utf16le").toString("base64")], {
          windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        });
        this.child = child;
        child.stdin.on("error", () => {});
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2048); });
        child.stdout.on("data", (chunk) => {
          buffer = (buffer + chunk.toString()).slice(-4096);
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            try { if (JSON.parse(line).event === "ready") finish(); } catch {}
          }
        });
        child.on("error", (error) => finish(error.message));
        child.once("close", (code) => {
          if (this.child !== child) return;
          const wasActive = this.active;
          this.child = null; this.active = false;
          if (!this.desired) this.lifetime.removeListener("exit", this.exitHandler);
          if (!settled) finish(stderr.trim() || "helper exited before ready (" + code + ")");
          else if (wasActive && this.desired && !this.stopping) {
            this.error = stderr.trim() || "sleep prevention helper exited unexpectedly";
            this.logger.warn("[power] " + this.error);
            this.retry();
          }
        });
      } catch (error) { finish(error.message); }
    });
  }

  stop() {
    this.desired = false; this.clearRetry();
    this.lifetime.removeListener("exit", this.exitHandler);
    this.cancelStartup?.();
    if (this.stopping) return this.stopping;
    this.stopping = this._stop().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async _stop() {
    if (this.starting) await this.starting;
    const child = this.child;
    if (!child) { this.phase = "stopped"; this.changed(); return; }
    this.lifetime.removeListener("exit", this.exitHandler);
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, this.stopTimeout);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end("stop\n");
    });
    this.active = false;
    this.phase = "stopped"; this.changed();
  }
}

export function createSleepPrevention(config) {
  return new SleepPrevention({ enabled: config.preventSleep !== false && process.env.CODEXAPP_PREVENT_SLEEP !== "0" });
}
