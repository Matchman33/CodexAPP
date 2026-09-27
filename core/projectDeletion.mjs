import { listProjectTree, collectPages } from "./threadDisplay.mjs";

export async function deleteProject(hub, message, codexHome, progress) {
  if (message.confirmed !== true) throw new Error("请先确认删除项目及全部会话");
  if (typeof message.projectId !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(message.projectId)) throw new Error("无效项目 ID");
  if (!hub.state.codexConnected) throw new Error("Codex 未连接");
  const client = hub.control.codex;
  const inventory = await listProjectTree(client, codexHome, { includeArchived: true, includeChildren: true, requireProjects: true });
  const project = inventory.projects.find(p => p.id === message.projectId);
  if (!project) throw new Error("项目不存在或列表已变化，请刷新后重试");
  const targets = new Set(project.threads.filter(t => !hub.metadata[t.id]?.projectless).map(t => t.id));
  // thread/delete cascades to spawned descendants, including those using another cwd.
  let added;
  do {
    added = false;
    for (const t of inventory.allThreads) if (targets.has(t.parentThreadId) && !targets.has(t.id)) { targets.add(t.id); added = true; }
  } while (added);
  for (const id of targets) {
    const bridge = hub.sessions.get(id);
    if (bridge && (bridge.state.status === "running" || bridge.promptQueue.active?.starting || bridge.pendingApprovals.size)) throw new Error("项目内仍有运行中或待审批的会话，请先停止任务");
  }
  if (hub.terminals.opening) throw new Error("终端正在启动，请稍后删除项目");
  if (hub.terminals.list().some(t => targets.has(t.threadId) && t.status === "running")) throw new Error("项目内仍有活动终端，请先结束终端");
  // Pause before awaited checks so a queued prompt cannot start between checks and deletion.
  for (const id of targets) hub.sessions.get(id)?.promptQueue.pause(id, "等待删除项目");
  const deleted = new Set();
  try {
    for (const id of targets) {
      const { thread } = await client.request("thread/read", { threadId: id, includeTurns: false });
      if (!thread || !["idle", "notLoaded"].includes(thread.status?.type)) throw new Error("项目内会话正在运行或状态未知，未执行删除：" + id);
    }
    // Delete children first so every confirmed thread can be tracked on partial failure.
    const byId = new Map(inventory.allThreads.map(t => [t.id, t]));
    const depth = id => { let n = 0; const seen = new Set(); while (targets.has(byId.get(id)?.parentThreadId) && !seen.has(id)) { seen.add(id); id = byId.get(id).parentThreadId; n++; } return n; };
    for (const id of [...targets].sort((a, b) => depth(b) - depth(a))) {
      await client.request("thread/delete", { threadId: id });
      deleted.add(id);
      hub.notification({ method: "thread/deleted", params: { threadId: id } });
      progress({ deleted: deleted.size, total: targets.size });
    }
    const remaining = await listProjectTree(client, codexHome, { includeArchived: true, includeChildren: true, requireProjects: true });
    if (remaining.projects.find(p => p.id === project.id)?.threads.some(t => !hub.metadata[t.id]?.projectless)) throw new Error("删除期间出现新增或残留会话，请核对列表后重试");
    await client.request("project/delete", { projectId: project.id });
    const projects = await collectPages(client, "project/list", { limit: 200 });
    if (projects.some(p => p.id === project.id)) throw new Error("Codex 仍返回该项目，删除结果未确认");
    return { type: "projectDeleted", projectId: project.id, threadIds: [...deleted], requestId: message.requestId };
  } catch (error) {
    throw new Error("项目删除未完成，已删除 " + deleted.size + "/" + targets.size + " 个会话；未删除会话的队列保持暂停。" + error.message);
  }
}
