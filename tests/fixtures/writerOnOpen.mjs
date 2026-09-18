import "./lifecycleCodex.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 只替换隔离中继的锁探测器；不会识别或结束任何真实进程。
if (/[\\/]relay[\\/]server\.mjs$/.test(process.argv[1] || "")) {
  const { WriterControl } = await import(pathToFileURL(path.join(process.cwd(), "core/writerControl.mjs")).href);
  await fs.writeFile("external-writer.json", JSON.stringify({ occupied: true }));
  const record = entry => fs.appendFile("checks.jsonl", JSON.stringify(entry) + "\n");
  const conflict = threadId => ({ type: "writerConflict", threadId, message: "此会话被外部 Codex 进程占用", owners: [{ pid: 4242, name: "codex", affectedThreads: [threadId, "child"], canTerminate: true, token: "fixture-confirm" }] });
  WriterControl.prototype.inspectExternal = async function (threadId) {
    await record({ action: "inspect", threadId });
    if (threadId !== "two") return null;
    for (let i = 0; i < 200; i++) {
      try { await fs.access("hold-check"); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return JSON.parse(await fs.readFile("external-writer.json", "utf8")).occupied ? conflict(threadId) : null;
  };
  WriterControl.prototype.inspect = async function (threadId) { return conflict(threadId); };
  WriterControl.prototype.terminate = async function (threadId, token, confirmed) {
    if (threadId !== "two" || token !== "fixture-confirm" || confirmed !== true) throw new Error("缺少明确确认");
    await record({ action: "terminate", threadId, confirmed });
    await fs.writeFile("external-writer.json", JSON.stringify({ occupied: false }));
  };
}
