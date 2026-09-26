import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prepareTerminal } from "./prepare-terminal.mjs";

const require = createRequire(import.meta.url);
export function copyTerminalRuntime(directory) {
  const root = prepareTerminal();
  const destination = path.join(directory, "node_modules", "node-pty");
  fs.cpSync(root, destination, { recursive: true });
  fs.cpSync(path.dirname(require.resolve("node-addon-api/package.json")), path.join(destination, "node_modules", "node-addon-api"), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL("../core/terminalPtyWorker.cjs", import.meta.url)), path.join(directory, "terminalPtyWorker.cjs"));
}
