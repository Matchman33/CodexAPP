import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

export function spawnTerminal(file, args, options) {
  const directory = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const unpacked = path.join(directory.replace(/\.asar(?=$|[\\/])/, ".asar.unpacked"), "terminalPtyWorker.cjs");
  const worker = fs.existsSync(unpacked) ? unpacked : path.join(directory, "terminalPtyWorker.cjs");
  const child = fork(worker, [], {
    env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    execArgv: [], silent: true, windowsHide: true,
  });
  child.stdout.resume(); child.stderr.resume();
  return new Promise((resolve, reject) => {
    let ready = false, ended = false, onData = null, onExit = null, result, pendingInput = 0;
    const buffered = [];
    const send = message => {
      if (!child.connected) {
        if (["pause", "resume", "kill"].includes(message.type)) return;
        throw new Error("终端进程已断开");
      }
      const size = message.type === "write" ? message.data.length : 0;
      if (pendingInput + size > 131072) throw new Error("终端输入积压，请重新连接后核对已输入内容");
      pendingInput += size;
      child.send(message, () => { pendingInput -= size; });
    };
    const timer = setTimeout(() => { send({ type: "kill" }); reject(new Error("PTY 启动超时")); }, 10000);
    const exit = value => { if (!ended) { ended = true; result = value; onExit?.(value); } };
    child.on("error", error => { clearTimeout(timer); reject(error); exit({ exitCode: -1 }); });
    child.on("exit", code => { clearTimeout(timer); if (!ready) reject(new Error("PTY 子进程启动失败，请检查终端依赖")); exit({ exitCode: code ?? -1 }); });
    child.on("message", m => {
      if (m.type === "ready") {
        clearTimeout(timer); ready = true;
        resolve({ pid: m.pid, onData: cb => { onData = cb; for (const data of buffered.splice(0)) cb(data); }, onExit: cb => { onExit = cb; if (ended) cb(result); },
          write: data => send({ type: "write", data }), resize: (cols, rows) => send({ type: "resize", cols, rows }),
          pause: () => send({ type: "pause" }), resume: () => send({ type: "resume" }), kill: () => send({ type: "kill" }) });
      } else if (m.type === "data") { if (onData) onData(m.data); else buffered.push(m.data); }
      else if (m.type === "exit") exit({ exitCode: m.exitCode, signal: m.signal });
      else if (m.type === "error") {
        clearTimeout(timer);
        if (!ready) reject(new Error(m.message));
        else onData?.("\r\n[PTY] " + String(m.message).slice(0, 500) + "\r\n");
      }
    });
    send({ type: "init", file, args, options });
  });
}
