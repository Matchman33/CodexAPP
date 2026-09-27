// Build the PC Agent into a single self-contained binary using esbuild + Node SEA.
//   1. esbuild bundles agent.mjs + all deps -> one CJS file
//   2. Node SEA turns it into a blob and injects it into a copy of the node binary
//
// Cross-platform: run this ON the OS you want a binary for (SEA copies the running
// node, which is native to the current OS — you can't cross-compile).
//   Windows -> dist/CodexApp-Agent.exe
//   macOS   -> dist/CodexApp-Agent      (ad-hoc codesigned so it runs)
//   Linux   -> dist/CodexApp-Agent
//
// Run:  node cloud/build-agent.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signWindows, findSigntool } from "./sign-win.mjs";
import { copyTerminalRuntime } from "../scripts/copy-terminal-runtime.mjs";
import { copyWebRuntime } from "../scripts/copy-web-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const BUNDLE = path.join(DIST, "agent.cjs");
const BLOB = path.join(DIST, "agent.blob");
const SEA_CFG = path.join(DIST, "sea-config.json");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const EXE = path.join(DIST, isWin ? "CodexApp-Agent.exe" : "CodexApp-Agent");

fs.mkdirSync(DIST, { recursive: true });
copyTerminalRuntime(DIST);
copyWebRuntime(DIST);

console.log(`[build] target: ${process.platform}/${process.arch} -> ${path.basename(EXE)}`);
console.log("[build] bundling with esbuild...");
await build({
  entryPoints: [path.join(ROOT, "cloud", "agent.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: BUNDLE,
  // ws ships optional native speedups; it falls back to JS when absent.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "warning",
});
console.log("[build] bundle:", (fs.statSync(BUNDLE).size / 1024).toFixed(0) + " KB");

fs.writeFileSync(SEA_CFG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2));

console.log("[build] generating SEA blob...");
execFileSync(process.execPath, ["--experimental-sea-config", SEA_CFG], { stdio: "inherit" });

console.log("[build] copying node runtime -> binary...");
fs.copyFileSync(process.execPath, EXE);

// Remove the platform code signature BEFORE injecting; otherwise injection corrupts
// it. Windows: signtool (optional, for later re-signing). macOS: codesign (required —
// an injected binary with a stale signature is killed by Gatekeeper on launch).
if (isWin) {
  const signtool = findSigntool();
  if (signtool) {
    try { execFileSync(signtool, ["remove", "/s", EXE], { stdio: "ignore" }); console.log("[build] stripped base signature"); }
    catch { /* node.exe may already be unsigned */ }
  } else {
    console.log("[build] (signtool not found — skip pre-strip; install Windows SDK to code-sign)");
  }
} else if (isMac) {
  try { execFileSync("codesign", ["--remove-signature", EXE], { stdio: "ignore" }); console.log("[build] removed base signature"); }
  catch { /* may already be unsigned */ }
}

console.log("[build] injecting blob with postject...");
const postjectArgs = [
  path.join(ROOT, "node_modules", "postject", "dist", "cli.js"),
  EXE, "NODE_SEA_BLOB", BLOB, "--sentinel-fuse", FUSE,
];
if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA"); // required on Mach-O
execFileSync(process.execPath, postjectArgs, { stdio: "inherit" });

// macOS: re-sign ad-hoc so the injected binary will launch. Unix: make it executable.
if (isMac) {
  try { execFileSync("codesign", ["--sign", "-", EXE], { stdio: "ignore" }); console.log("[build] ad-hoc codesigned"); }
  catch (e) { console.log("[build] (codesign failed — run: codesign --sign - " + EXE + ")"); }
}
if (!isWin) { try { fs.chmodSync(EXE, 0o755); } catch {} }

// Code-sign for distribution (no-op unless CODEXAPP_SIGN_* is configured).
if (isWin) {
  const signed = signWindows(EXE, { label: path.basename(EXE) });
  if (!signed) console.log("[build] (unsigned — set CODEXAPP_SIGN_* to code-sign; needed for SmartScreen/SAC)");
}

console.log("\n[build] done -> " + EXE);
console.log("        size:", (fs.statSync(EXE).size / 1024 / 1024).toFixed(1) + " MB");
if (isMac) console.log("        (ad-hoc signed — for distribution, sign+notarize with an Apple Developer ID)");
