import fs from "node:fs";
import "../core/managedProcess.mjs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { persistModel } from "../core/modelSettings.mjs";
import { createSleepPrevention } from "../core/sleepPrevention.mjs";
import { createLocalRelay, existingRelay, relayDefaults } from "./transport.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = process.env.CODEXAPP_RELAY_CONFIG || path.join(ROOT, "codexapp.config.json");
const configExists = fs.existsSync(CONFIG_PATH);
const config = { ...relayDefaults, ...(configExists ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {}) };
if (!config.token) {
  config.token = crypto.randomBytes(18).toString("base64url");
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600, flag: configExists ? "w" : "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))); }
}
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.HOST) config.host = process.env.HOST;
config.defaultCwd ||= os.homedir();
const dataDir = process.env.CODEXAPP_DATA_DIR || path.join(os.homedir(), ".codexapp", "relay-" + crypto.createHash("sha256").update(ROOT).digest("hex").slice(0, 12));
const sleepPrevention = createSleepPrevention(config);
const relay = createLocalRelay({ config, dataDir, webDir: path.join(ROOT, "web"),
  saveModel: (model, settings) => persistModel(CONFIG_PATH, model, settings), sleepStatus: () => sleepPrevention.status() });
process.on("message", async m => {
  if (m?.type !== "codexapp-stop" || process.env.CODEXAPP_MANAGED !== "1") return;
  try { await relay.close(); process.exit(0); } catch (error) { console.error(error.message); }
});
try {
  const port = await relay.start(); await sleepPrevention.start();
  console.log("[codex] binary:", relay.hub.control.codex.bin);
  console.log("CodexApp relay: http://127.0.0.1:" + port);
  console.log("Token: " + config.token);
} catch (error) {
  if (error.code === "EADDRINUSE" && await existingRelay(config)) {
    console.log("本机共享中继已运行，继续使用现有服务，端口：" + config.port);
    process.exit(0);
  }
  console.error("[fatal]", error.code === "EADDRINUSE" ? "中继端口已被占用；若 Agent 已启动共享中继，请直接使用现有服务" : error.message);
  process.exit(1);
}
