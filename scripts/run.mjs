import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const entries = { relay: "../relay/server.mjs", agent: "../cloud/agent.mjs" };
const entry = entries[process.argv[2] || "relay"];
if (!entry) throw new Error("启动目标只允许 relay 或 agent");
let child, stopping = false;
function start() {
  let restart = false;
  child = fork(fileURLToPath(new URL(entry, import.meta.url)), [], {
    env: { ...process.env, CODEXAPP_MANAGED: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true,
  });
  child.on("message", m => { if (m?.type === "codexapp-restart") restart = true; });
  child.on("error", error => { console.error("[launcher]", error.message); process.exitCode = 1; });
  child.on("exit", code => {
    if (restart && !stopping) start();
    else { process.exitCode = code || 0; if (process.connected) process.disconnect(); }
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; child?.kill(signal); });
process.on("message", m => { if (m?.type === "codexapp-stop") { stopping = true; child?.send({ type: "codexapp-stop" }); } });
start();
