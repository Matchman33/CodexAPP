import readline from "node:readline";

if (process.argv[1]?.endsWith("app-server")) {
  const thread = { id: "one", name: "生成文件验证", cwd: process.cwd(), status: { type: "idle" }, updatedAt: 100 };
  const item = { id: "files", type: "agentMessage", text: "文件已生成：\n\n[表格](exports/报表.xlsx)\n\n[图片](exports/chart.png)\n\n[PDF](exports/report.pdf)\n\n[项目外文件](../private.txt)" };
  const turn = { id: "turn", status: "completed", startedAt: 100, itemsView: "full", items: [item] };
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", raw => {
    const m = JSON.parse(raw); if (m.id === undefined) return;
    let result;
    if (m.method === "initialize") result = { userAgent: "file-fixture" };
    else if (m.method === "thread/list") result = { data: [thread], nextCursor: null };
    else if (m.method === "thread/read") result = { thread: { ...thread, turns: [turn] } };
    else if (m.method === "thread/turns/list") result = { data: [turn], nextCursor: null };
    else if (m.method.includes("items/list")) result = { data: [item], nextCursor: null };
    else { process.stdout.write(JSON.stringify({ id: m.id, error: { message: "Unexpected fixture RPC: " + m.method } }) + "\n"); return; }
    process.stdout.write(JSON.stringify({ id: m.id, result }) + "\n");
  });
  lines.on("close", () => process.exit(0));
  await new Promise(() => {});
}
