import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexBin } from "../core/codexBinary.mjs";
import { resolveCodexBin as compatibilityResolver } from "../core/codexBridge.mjs";

function fixture(t, platform = "win32") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-binary-"));
  t.after(() => { const resolved = path.resolve(root); if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("codexapp-binary-")) throw new Error("无效测试目录"); fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, "profile"), local = path.join(home, "AppData", "Local");
  const options = { platform, home, env: { PATH: "", LOCALAPPDATA: local } };
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support", "OpenAI", "Codex", "bin") : path.join(local, "OpenAI", "Codex", "bin");
  const file = (target, text = "fixture", time = 100) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); fs.utimesSync(target, time, time); return target; };
  const version = (hash, time, host = true) => {
    const exe = file(path.join(base, hash, platform === "win32" ? "codex.exe" : "codex"), "fixture", time);
    if (host && platform === "win32") file(path.join(base, hash, "codex-code-mode-host.exe"));
    return exe;
  };
  return { root, base, options, file, version };
}

test("桌面端旧版本仍有 exe 但缺宿主时，自动选择较新的完整目录", t => {
  const f = fixture(t), old = f.version("1111111111111111", 100, false), current = f.version("2222222222222222", 200);
  assert.equal(resolveCodexBin(old, f.options), current);
  assert.equal(resolveCodexBin("", f.options), current);
  assert.equal(compatibilityResolver, resolveCodexBin);
});
test("更新中的残缺版本不能盖过已有可用版本", t => {
  const f = fixture(t), stable = f.version("1111111111111111", 100);
  f.version("2222222222222222", 200, false);
  const emptyHost = f.version("3333333333333333", 300);
  f.file(path.join(path.dirname(emptyHost), "codex-code-mode-host.exe"), "");
  assert.equal(resolveCodexBin("", f.options), stable);
  assert.equal(resolveCodexBin(emptyHost, f.options), stable);
});
test("旧目录被清理仍能迁移到新目录，每次解析都反映后续升级", t => {
  const f = fixture(t), old = f.version("1111111111111111", 100);
  assert.equal(resolveCodexBin(old, f.options), old);
  const current = f.version("2222222222222222", 200);
  assert.equal(resolveCodexBin(old, f.options), current);
  fs.unlinkSync(old);
  assert.equal(resolveCodexBin(old, f.options), current);
});
test("PATH 中的旧桌面端目录也跟随最新可用版本", t => {
  const f = fixture(t), old = f.version("1111111111111111", 100, false), current = f.version("2222222222222222", 200);
  f.options.env.PATH = '"' + path.dirname(old) + '"';
  assert.equal(resolveCodexBin("", f.options), current);
});
test("明确配置的独立程序保留优先级，不强制要求桌面端宿主文件", t => {
  const f = fixture(t), custom = f.file(path.join(f.root, "custom", "codex.exe"));
  f.version("2222222222222222", 200);
  assert.equal(resolveCodexBin(custom, f.options), custom);
  f.options.env.PATH = path.dirname(custom);
  assert.equal(resolveCodexBin("", f.options), custom);
});
test("缺失的自定义路径仍保留原有自动回退行为", t => {
  const f = fixture(t), current = f.version("2222222222222222", 200);
  assert.equal(resolveCodexBin(path.join(f.root, "missing.exe"), f.options), current);
});
test("Windows 没有完整桌面端版本时返回不可用，不启动残缺 exe", t => {
  const f = fixture(t), old = f.version("1111111111111111", 100, false);
  assert.equal(resolveCodexBin(old, f.options), null);
  assert.equal(resolveCodexBin("", f.options), null);
});
test("忽略空文件、同名目录和非版本缓存目录", t => {
  const f = fixture(t), current = f.version("1111111111111111", 100);
  const empty = f.version("2222222222222222", 200); f.file(empty, "", 200);
  fs.mkdirSync(path.join(f.base, "3333333333333333", "codex.exe"), { recursive: true });
  f.version("unrelated-directory", 400);
  assert.equal(resolveCodexBin("", f.options), current);
});
test("LOCALAPPDATA 缺失时使用用户目录，不错误地扫描项目目录", t => {
  const f = fixture(t), current = f.version("2222222222222222", 200);
  delete f.options.env.LOCALAPPDATA;
  assert.equal(resolveCodexBin("", f.options), current);
});
test("macOS 缓存版本继续按时间选择，独立 Linux 路径保持兼容", t => {
  const mac = fixture(t, "darwin"), old = mac.version("1111111111111111", 100), current = mac.version("2222222222222222", 200);
  assert.equal(resolveCodexBin(old, mac.options), current);
  const linux = fixture(t, "linux"), custom = linux.file(path.join(linux.root, "cli", "codex"));
  assert.equal(resolveCodexBin(custom, linux.options), custom);
});
