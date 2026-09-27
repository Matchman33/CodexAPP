import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export function copyWebRuntime(destination) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [path.join(root, "scripts/build-web.mjs")], { cwd: root, stdio: "inherit", windowsHide: true });
  const source = path.join(root, "web"), target = path.join(destination, "web");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && /\.(html|css|js|mjs|png|webmanifest)$/.test(entry.name)) fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
  }
  fs.cpSync(path.join(source, "vendor"), path.join(target, "vendor"), { recursive: true });
}
