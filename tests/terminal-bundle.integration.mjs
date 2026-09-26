import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { copyTerminalRuntime } from "../scripts/copy-terminal-runtime.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-terminal-bundle-"));
let manager, opened;
try {
  const file = path.join(dir, "terminal.cjs");
  await build({ entryPoints: ["core/terminalManager.mjs"], outfile: file, bundle: true, platform: "node", format: "cjs", logLevel: "error" });
  copyTerminalRuntime(dir);
  const { TerminalManager } = createRequire(import.meta.url)(file);
  manager = new TerminalManager(() => {}, { shell: process.platform === "win32" ? { file: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo", "-NoProfile"], name: "PowerShell" } : { file: "/bin/sh", args: [], name: "sh" } });
  assert(manager.capabilities().supported, manager.capabilities().error);
  opened = await manager.open({ cwd: dir }, "bundle");
  assert.equal(opened.canInput, true);
  await manager.close({ ...opened, confirmed: true }, "bundle");
  assert.equal(manager.activeCount, 0);
  console.log("PASS: relocated CJS bundle loads packaged native PTY and worker, starts and closes shell");
} finally {
  manager?.dispose();
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("codexapp-terminal-bundle-")) throw new Error("Invalid cleanup directory");
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
