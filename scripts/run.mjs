import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { supervise } from "./supervisor.mjs";

const entries = { relay: "../relay/server.mjs", agent: "../cloud/agent.mjs", broker: "../cloud/broker.mjs" };
const entry = entries[process.argv[2] || "relay"];
if (!entry) throw new Error("启动目标只允许 relay、agent 或 broker");
const supervisor = supervise(() => fork(fileURLToPath(new URL(entry, import.meta.url)), [], {
    env: { ...process.env, CODEXAPP_MANAGED: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true,
  }), { finished: code => { process.exitCode = code; if (process.connected) process.disconnect(); } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => supervisor.stop(signal));
process.on("message", m => { if (m?.type === "codexapp-stop") supervisor.stopManaged(); });
