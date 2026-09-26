import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { TerminalManager } from "../core/terminalManager.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-terminal-"));
await fs.mkdir(path.join(root, "sub"));
const win = process.platform === "win32", client = "pty-test";
let manager, opened, output = "", seq = 0;
try {
  manager = new TerminalManager(m => {
    if (m.type === "terminalOutput") { output += m.data; manager.ack(m, client); }
  }, { ...(win ? { shell: { file: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoLogo", "-NoProfile"], name: "PowerShell" } } : {}) });
  assert(manager.capabilities().supported, manager.capabilities().error);
  opened = await manager.open({ cwd: root, cols: 90, rows: 25 }, client);
  const input = data => manager.input({ ...opened, data, inputSeq: ++seq }, client);
  const until = async text => { for (let n = 0; n < 200; n++) { if (stripVTControlCharacters(output).includes(text)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("未收到终端结果：" + text + "\n" + stripVTControlCharacters(output).slice(-2000)); };
  input(win ? "Write-Output ('PTY'+'-READY')\r" : "printf 'PTY%s\\n' '-READY'\r");
  await until("PTY-READY");
  input(win ? "Set-Location sub; Write-Output ('HERE'+':' +(Get-Location).Path)\r" : "cd sub; printf 'HERE:%s\\n' \"$PWD\"\r");
  await until("HERE:" + path.join(root, "sub"));
  manager.resize({ ...opened, cols: 100, rows: 30 }, client);
  input(win ? "Write-Output ('START'+'-WAIT'); Start-Sleep -Seconds 30; Write-Output ('BAD'+'-END')\r" : "printf 'START%s\\n' '-WAIT'; sleep 30; printf 'BAD%s\\n' '-END'\r");
  await until("START-WAIT"); output = ""; input("\x03");
  if (win) await until(path.join(root, "sub") + ">");
  else await new Promise(resolve => setTimeout(resolve, 200));
  input(win ? "Write-Output ('AFTER'+'-INTERRUPT')\r" : "printf 'AFTER%s\\n' '-INTERRUPT'\r");
  await until("AFTER-INTERRUPT");
  assert(!stripVTControlCharacters(output).includes("BAD-END"));
  manager.detach(client);
  const restored = await manager.attach({ terminalId: opened.terminalId }, "reconnected");
  assert(stripVTControlCharacters(restored.data).includes("AFTER-INTERRUPT"));
  assert.equal(restored.cols, 100); assert.equal(restored.rows, 30);
  await manager.close({ ...restored, confirmed: true }, "reconnected");
  assert.equal(manager.activeCount, 0);
  console.log("PASS: real PTY, interactive shell, persistent cd, resize, Ctrl+C, reconnect screen and confirmed exit");
} finally {
  manager?.dispose();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("codexapp-terminal-")) throw new Error("Invalid cleanup path");
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
