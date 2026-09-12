import fs from "node:fs";
import path from "node:path";

const recency = (t) => t.recencyAt ?? t.updatedAt ?? t.createdAt ?? 0;
const lastSegment = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const isPath = (p) => typeof p === "string" && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);

export function normalizeRoot(value) {
  let p = String(value || "");
  const windows = /^[A-Za-z]:|^\\/.test(p);
  p = p.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "");
  p = p.replace(/\\/g, "/").replace(/\/+$/, "") || (p.startsWith("/") ? "/" : "");
  return windows ? p.toLowerCase() : p;
}

export async function collectPages(client, method, params) {
  const data = [], seen = new Set();
  let cursor;
  do {
    const page = await client.request(method, { ...params, ...(cursor ? { cursor } : {}) });
    data.push(...(page?.data || []));
    cursor = page?.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error(method + " 返回了重复分页游标");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return data;
}

export function buildProjectTree(threads, gs = {}) {
  const local = gs["local-projects"] || {};
  const labels = gs["electron-workspace-root-labels"] || {};
  const assignments = gs["thread-project-assignments"] || {};
  const hints = gs["thread-workspace-root-hints"] || {};
  const projectlessIds = new Set(gs["projectless-thread-ids"] || []);
  const order = gs["project-order"] || gs["electron-saved-workspace-roots"] || [];
  const projects = [], byId = new Map();
  const add = (id, entry) => {
    if (byId.has(id)) return;
    const roots = (entry?.rootPaths || (isPath(id) ? [id] : [])).filter(isPath);
    if (!roots.length) return;
    const p = { id, root: roots[0], roots, label: entry?.name || labels[roots[0]] || lastSegment(roots[0]), threads: [] };
    projects.push(p); byId.set(id, p);
  };
  for (const id of order) add(id, local[id]);
  for (const [id, entry] of Object.entries(local)) add(id, entry);
  for (const root of gs["electron-saved-workspace-roots"] || []) {
    if (!projects.some((p) => p.roots.some((r) => normalizeRoot(r) === normalizeRoot(root)))) add(root);
  }
  // Desktop migration keeps legacy project IDs in assignments and new IDs in the server.
  for (const mapping of Object.values(gs["app-server-project-id-by-legacy-project-id-by-host"] || {})) {
    for (const [legacy, current] of Object.entries(mapping)) if (byId.has(legacy)) byId.set(current, byId.get(legacy));
  }
  const unique = new Map();
  for (const t of threads) {
    if (!t.id || t.parentThreadId) continue;
    const old = unique.get(t.id);
    if (!old || (t.updatedAt ?? 0) > (old.updatedAt ?? 0)) unique.set(t.id, t);
  }
  const flat = [];
  for (const raw of unique.values()) {
    const t = { id: raw.id, name: raw.name || raw.preview || "(无标题)", cwd: raw.cwd || null, updatedAt: recency(raw), source: raw.source || null };
    const assignment = assignments[t.id];
    const explicit = assignment?.projectKind === "local" ? byId.get(assignment.projectId) : null;
    if (explicit) { explicit.threads.push(t); continue; }
    if (projectlessIds.has(t.id)) { flat.push(t); continue; }
    const cwd = normalizeRoot(hints[t.id] || t.cwd);
    let best = null, length = -1;
    for (const p of projects) for (const root of p.roots) {
      const r = normalizeRoot(root);
      if (r && (cwd === r || cwd.startsWith(r === "/" ? r : r + "/")) && r.length > length) { best = p; length = r.length; }
    }
    // Preserve unassigned interactive threads instead of silently hiding them.
    (best ? best.threads : flat).push(t);
  }
  const byRecency = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  const sidebarOrders = gs["sidebar-project-thread-orders"] || {};
  for (const p of projects) {
    const ids = Array.isArray(sidebarOrders[p.id]) ? sidebarOrders[p.id] : [];
    const ranks = new Map(ids.map((id, i) => [id, i]));
    p.threads.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || byRecency(a, b));
  }
  flat.sort(byRecency);
  return { projects, projectless: flat };
}

export async function listProjectTree(client, codexHome) {
  let gs = {};
  try { gs = JSON.parse(fs.readFileSync(path.join(codexHome, ".codex-global-state.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") console.warn("[tree] global-state:", error.message); }
  const params = { limit: 200, sortKey: "recency_at", modelProviders: [], archived: false };
  let threads = await collectPages(client, "thread/list", { ...params, useStateDbOnly: true });
  if (!threads.length) threads = await collectPages(client, "thread/list", params);
  return buildProjectTree(threads, gs);
}

function toolResultText(result) {
  if (!result) return "";
  const content = (result.content || []).map((c) => {
    if (c.type === "text") return c.text || "";
    if (c.type === "image") return "[图片]";
    if (c.type === "resource") return c.resource?.text || c.resource?.uri || "";
    return c.uri || "";
  }).filter(Boolean).join("\n");
  return content || (result.structuredContent ? JSON.stringify(result.structuredContent) : "");
}

export function itemToEvent(item) {
  let text;
  switch (item.type) {
    case "userMessage":
      text = (item.content || []).map((c) => c.type === "text" ? c.text : c.type === "image" || c.type === "localImage" ? "[图片] " + (c.path || c.url || "") : c.type === "skill" ? "[技能] " + (c.name || c.path || "") : c.type === "mention" ? "[引用] " + (c.name || c.path || "") : "").join("\n"); break;
    case "agentMessage": case "plan": text = item.text; break;
    case "reasoning": text = (item.summary?.length ? item.summary : item.content || []).join("\n"); break;
    case "commandExecution": text = "$ " + item.command + (item.exitCode != null ? "  →  exit " + item.exitCode : "") + (item.aggregatedOutput ? "\n" + item.aggregatedOutput : ""); break;
    case "fileChange": text = (item.changes || []).map((c) => c.path + (c.diff ? "\n" + c.diff : "")).join("\n"); break;
    case "webSearch": text = "搜索: " + (item.query || JSON.stringify(item.action)); break;
    case "mcpToolCall": text = "工具: " + item.server + "/" + item.tool + (item.result ? "\n" + toolResultText(item.result) : "") + (item.error ? "\n" + item.error.message : ""); break;
    case "dynamicToolCall": text = "工具: " + [item.namespace, item.tool].filter(Boolean).join("/") + (item.contentItems ? "\n" + item.contentItems.map((c) => c.text || "[图片]").join("\n") : ""); break;
    case "collabAgentToolCall": text = "子任务: " + item.tool + (item.prompt ? "\n" + item.prompt : ""); break;
    case "imageView": text = "[图片] " + item.path; break;
    case "imageGeneration": text = "[生成图片] " + (item.savedPath || item.revisedPrompt || item.status); break;
    case "enteredReviewMode": case "exitedReviewMode": text = item.review; break;
    case "contextCompaction": text = "上下文已压缩"; break;
    default: return null;
  }
  return text ? { kind: item.type === "userMessage" ? "user" : "item:" + item.type, text, itemId: item.id, phase: item.phase || null } : null;
}

export function historyEvents(thread) {
  const events = [], seen = new Set();
  for (const [turnIndex, turn] of (thread.turns || []).entries()) {
    for (const [index, item] of (turn.items || []).entries()) {
      const event = itemToEvent(item);
      if (!event) continue;
      const id = [thread.id, turn.id || turnIndex, item.id || index].join(":");
      if (seen.has(id)) continue;
      seen.add(id);
      events.push({ ...event, id, threadId: thread.id, turnId: turn.id, ts: (turn.startedAt ?? thread.createdAt ?? 0) * 1000 + index });
    }
    if (turn.error?.message) events.push({ id: thread.id + ":" + turn.id + ":error", kind: "error", text: turn.error.message, ts: (turn.completedAt ?? thread.updatedAt ?? 0) * 1000 });
  }
  return events;
}

export async function readThreadHistory(client, threadId, initialThread) {
  const thread = initialThread || (await client.request("thread/read", { threadId, includeTurns: true })).thread;
  if ((thread.turns || []).some((t) => t.itemsView && t.itemsView !== "full")) {
    thread.turns = await collectPages(client, "thread/turns/list", { threadId, limit: 100, sortDirection: "asc", itemsView: "full" });
    for (const turn of thread.turns) if (turn.itemsView !== "full") {
      turn.items = await collectPages(client, "thread/turns/items/list", { threadId, turnId: turn.id, limit: 200, sortDirection: "asc" });
      turn.itemsView = "full";
    }
  }
  return thread;
}
