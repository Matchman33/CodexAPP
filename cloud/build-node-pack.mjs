// Build the "trusted-node" distribution: the agent bundled as a single .cjs, shipped
// alongside the OFFICIAL signed node.exe + a double-click launcher.
//
// Why: a SEA / Electron .exe is modified after build, so its Authenticode signature
// breaks and Smart App Control (SAC) hard-blocks it. Here the launcher runs the
// PRISTINE, still-signed node.exe (trusted by SAC) and feeds it our agent.cjs as
// plain data — nothing unsigned is ever executed, and the user needs no Node install.
//
// Run: node cloud/build-node-pack.mjs   ->   dist/CodexApp-node-win64/  +  .zip
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyTerminalRuntime } from "../scripts/copy-terminal-runtime.mjs";
import { copyWebRuntime } from "../scripts/copy-web-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PACK = path.join(DIST, "CodexApp-node-win64");
const ZIP = path.join(DIST, "CodexApp-node-win64.zip");

fs.rmSync(PACK, { recursive: true, force: true });
fs.mkdirSync(PACK, { recursive: true });
copyTerminalRuntime(PACK);
copyWebRuntime(PACK);

// 1. bundle the agent into one CJS file
console.log("[node-pack] bundling agent.cjs ...");
await build({
  entryPoints: [path.join(ROOT, "cloud", "agent.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(PACK, "agent.cjs"),
  external: ["bufferutil", "utf-8-validate"], // ws optional native speedups
  logLevel: "warning",
});

// 2. ship the OFFICIAL signed node.exe (the one running this build — OpenJS-signed).
//    Node.js is MIT-licensed, so redistribution is fine.
const nodeExe = process.env.CODEXAPP_NODE_EXE || process.execPath;
fs.copyFileSync(nodeExe, path.join(PACK, "node.exe"));
console.log("[node-pack] bundled node.exe from", nodeExe);

// 3. double-click launcher (runs the bundled signed node.exe with agent.cjs).
//    ASCII-only echoes — cmd.exe mis-parses UTF-8 Chinese in .cmd files.
fs.writeFileSync(path.join(PACK, "启动CodexApp.cmd"),
  "@echo off\r\n" +
  "title CodexApp\r\n" +
  "cd /d \"%~dp0\"\r\n" +
  "echo Starting CodexApp... (running via the bundled trusted Node; Windows won't block it)\r\n" +
  "echo A login panel will open. Close this window to quit.\r\n" +
  "echo.\r\n" +
  "\"%~dp0node.exe\" \"%~dp0agent.cjs\"\r\n" +
  "echo.\r\n" +
  "echo CodexApp exited. Press any key to close.\r\n" +
  "pause >nul\r\n");

// 4. readme
fs.writeFileSync(path.join(PACK, "使用说明.txt"),
  "CodexApp 电脑客户端（受信任 Node 版）\r\n" +
  "====================================\r\n\r\n" +
  "双击「启动CodexApp.cmd」即可运行。\r\n" +
  "会弹出登录面板：用你的账号登录后，手机/网页登录同一账号即可远程控制本机 Codex。\r\n\r\n" +
  "为什么是这种形式：\r\n" +
  "  本包随附官方签名的 node.exe，启动器运行的是它（受 Windows 信任），\r\n" +
  "  因此不会被 SmartScreen / 智能应用控制(SAC) 拦截，你也无需自己安装 Node。\r\n\r\n" +
  "关闭那个黑色命令行窗口 = 退出 CodexApp。\r\n" +
  "需要本机已安装 Codex CLI。\r\n");

// 5. zip (Windows PowerShell Compress-Archive)
console.log("[node-pack] zipping ...");
if (fs.existsSync(ZIP)) fs.rmSync(ZIP);
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -Path '${PACK}\\*' -DestinationPath '${ZIP}' -CompressionLevel Optimal`],
  { stdio: "inherit" });

const mb = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(0);
console.log(`[node-pack] done -> ${ZIP} (${mb} MB)`);
console.log("[node-pack] contents:", fs.readdirSync(PACK).join(", "));
