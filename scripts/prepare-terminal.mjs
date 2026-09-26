import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export function prepareTerminal() {
  const root = path.dirname(require.resolve("node-pty/package.json"));
  if (process.platform !== "win32") return root;
  const base = path.join(root, "third_party", "conpty");
  const version = fs.readdirSync(base).filter(name => fs.statSync(path.join(base, name)).isDirectory()).sort().at(-1);
  const source = path.join(base, version, "win10-" + process.arch);
  const destination = path.join(root, "build", "Release", "conpty");
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ["conpty.dll", "OpenConsole.exe"]) {
    const from = path.join(source, name), to = path.join(destination, name);
    if (!fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to))) fs.copyFileSync(from, to);
  }
  return root;
}
prepareTerminal();
