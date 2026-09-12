import { spawn } from "node:child_process";
import path from "node:path";

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

export class SleepPrevention {
  constructor({ enabled = true, platform = process.platform, spawnHelper = spawn, lifetime = process, logger = console, startupTimeout = 15000, stopTimeout = 2000 } = {}) {
    Object.assign(this, { enabled, platform, spawnHelper, lifetime, logger, startupTimeout, stopTimeout });
    this.child = null;
    this.starting = null;
    this.stopping = null;
    this.active = false;
    this.error = null;
    this.exitHandler = () => {
      // Kill only our helper; Windows clears its thread-scoped power request.
      try { this.child?.kill(); } catch {}
    };
  }

  status() {
    return { supported: this.platform === "win32", enabled: this.enabled, active: this.active, error: this.error };
  }

  start() {
    if (!this.enabled || this.platform !== "win32" || this.active) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.child) return this.stop().then(() => this.start());
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  _start() {
    this.error = null;
    return new Promise((resolve) => {
      let child, settled = false, buffer = "", stderr = "";
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.error = error;
          this.logger.warn("[power] sleep prevention unavailable: " + error);
          try { child?.kill(); } catch {}
        } else {
          this.active = true;
          this.lifetime.once("exit", this.exitHandler);
          child.unref?.();
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
          this.logger.log("[power] automatic sleep prevention active (display may turn off)");
        }
        resolve(this.status());
      };
      const timer = setTimeout(() => finish("helper startup timed out"), this.startupTimeout);
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
          this.lifetime.removeListener("exit", this.exitHandler);
          if (!settled) finish(stderr.trim() || "helper exited before ready (" + code + ")");
          else if (wasActive && !this.stopping) {
            this.error = stderr.trim() || "sleep prevention helper exited unexpectedly";
            this.logger.warn("[power] " + this.error);
          }
        });
      } catch (error) { finish(error.message); }
    });
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this._stop().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async _stop() {
    if (this.starting) await this.starting;
    const child = this.child;
    if (!child) return;
    this.lifetime.removeListener("exit", this.exitHandler);
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, this.stopTimeout);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin.end("stop\n");
    });
    this.active = false;
  }
}

export function createSleepPrevention(config) {
  return new SleepPrevention({ enabled: config.preventSleep !== false && process.env.CODEXAPP_PREVENT_SLEEP !== "0" });
}
