// Bundle the agent (cloud/agent.mjs + deps) into a single CJS file the Electron
// main process can require. Run: node build.mjs
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyTerminalRuntime } from "../scripts/copy-terminal-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

await build({
  entryPoints: [path.join(ROOT, "cloud", "agent.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(HERE, "agent.cjs"),
  // ws ships optional native speedups; electron is provided by the runtime.
  external: ["bufferutil", "utf-8-validate", "electron"],
  logLevel: "warning",
});
console.log("[desktop] bundled agent.cjs");
copyTerminalRuntime(HERE);
