import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function resolveCodexBin(configured, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const isWin = platform === "win32", exe = isWin ? "codex.exe" : "codex";
  const desktopRoot = isWin
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "OpenAI", "Codex", "bin")
    : platform === "darwin" ? path.join(home, "Library", "Application Support", "OpenAI", "Codex", "bin") : null;
  const normalized = value => isWin ? path.resolve(value).toLowerCase() : path.resolve(value);
  const isFile = file => { try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0; } catch { return false; } };
  const managed = file => {
    if (!desktopRoot || typeof file !== "string" || !file) return false;
    const relative = path.relative(normalized(desktopRoot), normalized(file)).split(path.sep);
    return relative.length === 2 && /^[a-f0-9]{8,64}$/i.test(relative[0]) && relative[1] === exe;
  };
  const usable = file => isFile(file) && (!isWin || !managed(file) || isFile(path.join(path.dirname(file), "codex-code-mode-host.exe")));
  const newestDesktop = () => {
    if (!desktopRoot) return null;
    try {
      return fs.readdirSync(desktopRoot).flatMap(directory => {
        const file = path.join(desktopRoot, directory, exe);
        try { return managed(file) && usable(file) ? [{ file, modified: fs.statSync(file).mtimeMs }] : []; } catch { return []; }
      }).sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file))[0]?.file || null;
    } catch { return null; }
  };

  // 桌面端哈希目录是会变化的缓存；旧版写入配置的路径不再当作固定版本。
  if (configured && managed(configured)) return newestDesktop();
  if (typeof configured === "string" && configured && usable(configured)) return configured;

  for (const entry of (env.PATH || "").split(isWin ? ";" : ":")) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    const candidate = path.join(directory, exe);
    if (managed(candidate)) { const current = newestDesktop(); if (current) return current; }
    else if (usable(candidate)) return candidate;
  }
  const desktop = newestDesktop();
  if (desktop) return desktop;
  if (isWin) return null;
  const candidates = platform === "darwin" ? [
    "/Applications/Codex.app/Contents/Resources/bin/codex", "/Applications/Codex.app/Contents/MacOS/codex",
    path.join(home, "Applications/Codex.app/Contents/Resources/bin/codex"), "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex", path.join(home, ".codex/bin/codex"),
  ] : ["/usr/local/bin/codex", "/usr/bin/codex", path.join(home, ".local/bin/codex"), path.join(home, ".codex/bin/codex")];
  return candidates.find(usable) || null;
}
