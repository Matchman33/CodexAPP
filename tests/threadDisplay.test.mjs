import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectTree, normalizeRoot, collectPages, historyEvents, itemToEvent, readThreadHistory, listProjectTree } from "../core/threadDisplay.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";

const thread = (id, cwd, updatedAt = 1) => ({ id, cwd, name: id, updatedAt, createdAt: 1, turns: [] });
const message = (id, text) => ({ id, type: "agentMessage", text });
const history = (id, count = 1) => ({ ...thread(id, "D:/repo"), turns: [{ id: "turn", itemsView: "full", status: "completed", startedAt: 1, items: Array.from({ length: count }, (_, i) => message("m" + i, "text" + i)) }] });

test("UUID project order resolves names, multiple roots and explicit assignments", () => {
  const gs = {
    "project-order": ["b", "a"],
    "local-projects": { a: { name: "Alpha", rootPaths: ["D:/a", "D:/worktree/a"] }, b: { name: "Beta", rootPaths: ["D:/b"] } },
    "thread-project-assignments": { moved: { projectKind: "local", projectId: "a" } },
    "projectless-thread-ids": ["moved", "flat"],
  };
  const tree = buildProjectTree([thread("moved", "E:/elsewhere"), thread("worktree", "d:\\worktree\\a\\src"), thread("flat", "D:/b")], gs);
  assert.deepEqual(tree.projects.map((p) => p.label), ["Beta", "Alpha"]);
  assert.equal(tree.projects[1].root, "D:/a");
  assert.deepEqual(tree.projects[1].threads.map((t) => t.id), ["moved", "worktree"]);
  assert.deepEqual(tree.projectless.map((t) => t.id), ["flat"]);
});

test("legacy paths, nested project match, hints and unassigned threads are preserved", () => {
  const tree = buildProjectTree([thread("nested", "D:/repo/sub/src"), thread("hinted", "D:/outside"), thread("other", "E:/else")], {
    "project-order": ["D:/repo", "D:/repo/sub"],
    "electron-workspace-root-labels": { "D:/repo": "Repo" },
    "thread-workspace-root-hints": { hinted: "d:\\repo" },
  });
  assert.equal(tree.projects[0].label, "Repo");
  assert.equal(tree.projects[0].threads[0].id, "hinted");
  assert.equal(tree.projects[1].threads[0].id, "nested");
  assert.equal(tree.projectless[0].id, "other");
});

test("deduplicates rollout versions, retains latest title, uses recency, hides subagents", () => {
  const tree = buildProjectTree([
    thread("same", "D:/repo", 5), { ...thread("same", "D:/repo", 10), name: "renamed" },
    { ...thread("recent", "D:/repo", 2), recencyAt: 12 },
    { ...thread("child", "D:/repo"), parentThreadId: "same" },
  ]);
  assert.deepEqual(tree.projectless.map((t) => t.id), ["recent", "same"]);
  assert.equal(tree.projectless[1].name, "renamed");
});

test("migration aliases and sidebar ordering override cwd and recency", () => {
  const tree = buildProjectTree([thread("old", "E:/else", 1), thread("new", "D:/repo", 9)], {
    "local-projects": { legacy: { rootPaths: ["D:/repo"] } },
    "thread-project-assignments": { old: { projectKind: "local", projectId: "server-id" } },
    "app-server-project-id-by-legacy-project-id-by-host": { local: { legacy: "server-id" } },
    "sidebar-project-thread-orders": { legacy: ["old"] },
  });
  assert.deepEqual(tree.projects[0].threads.map((t) => t.id), ["old", "new"]);
});

test("Windows extended paths normalize without losing POSIX case sensitivity", () => {
  assert.equal(normalizeRoot("\\\\?\\D:\\Repo\\"), "d:/repo");
  assert.equal(normalizeRoot("\\\\?\\UNC\\HOST\\Repo\\"), "//host/repo");
  assert.notEqual(normalizeRoot("/Repo"), normalizeRoot("/repo"));
  const tree = buildProjectTree([thread("sibling", "D:/repository")], { "project-order": ["D:/repo"] });
  assert.equal(tree.projectless.length, 1);
  const posix = buildProjectTree([thread("root", "/repo")], { "project-order": ["/"] });
  assert.equal(posix.projects[0].threads.length, 1);
});

test("collects every list page and rejects cursor loops", async () => {
  const calls = [];
  const client = { request: async (method, params) => { calls.push(params); return params.cursor ? { data: [2], nextCursor: null } : { data: [1], nextCursor: "next" }; } };
  assert.deepEqual(await collectPages(client, "thread/list", { limit: 1 }), [1, 2]);
  assert.equal(calls[1].cursor, "next");
  await assert.rejects(collectPages({ request: async () => ({ data: [], nextCursor: "loop" }) }, "thread/list", {}), /thread\/list/);
});

test("list requests every provider, non-archived canonical database pages", async () => {
  const calls = [];
  const client = { request: async (method, params) => { calls.push({ method, params }); return { data: [thread("one", "D:/repo")], nextCursor: null }; } };
  const tree = await listProjectTree(client, "nonexistent-home");
  assert.equal(tree.projectless.length, 1);
  assert.deepEqual(calls[0].params.modelProviders, []);
  assert.equal(calls[0].params.archived, false);
  assert.equal(calls[0].params.useStateDbOnly, true);
});

test("full history has stable unique IDs and is not truncated at 120, 300 or 400", () => {
  const t = history("thread", 650);
  t.turns[0].items.push(t.turns[0].items[0]);
  const events = historyEvents(t);
  assert.equal(events.length, 650);
  assert.equal(events[0].text, "text0");
  assert.equal(events[649].text, "text649");
  assert.deepEqual(events, historyEvents(t));
  assert.equal(events[0].turnId, "turn");
});

test("conversion keeps command output, plan, reasoning and attachment-only messages", () => {
  assert.match(itemToEvent({ type: "commandExecution", command: "test", exitCode: 1, aggregatedOutput: "failure" }).text, /failure/);
  assert.equal(itemToEvent({ type: "plan", text: "plan" }).text, "plan");
  assert.equal(itemToEvent({ type: "reasoning", summary: ["summary"], content: ["detail"] }).text, "summary");
  assert.match(itemToEvent({ type: "userMessage", content: [{ type: "localImage", path: "D:/image.png" }] }).text, /image.png/);
  assert.match(itemToEvent({ type: "dynamicToolCall", tool: "tool", contentItems: [{ type: "text", text: "result" }] }).text, /result/);
  const result = itemToEvent({ type: "mcpToolCall", server: "server", tool: "tool", result: { content: [{ type: "text", text: "readable" }, { type: "image", data: "base64-not-for-the-feed" }] } });
  assert.match(result.text, /readable/);
  assert.equal(result.text.includes("base64-not-for-the-feed"), false);
});

test("read-only thread history does not resume or acquire a writer", async () => {
  const calls = [];
  const t = history("one");
  const got = await readThreadHistory({ request: async (method, params) => { calls.push({ method, params }); return { thread: t }; } }, "one");
  assert.equal(got, t);
  assert.deepEqual(calls.map((c) => c.method), ["thread/read"]);
  assert.equal(calls[0].params.includeTurns, true);
});

test("partial turns and items are expanded through every page", async () => {
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push(method);
    if (method === "thread/read") return { thread: { ...thread("one", "D:/repo"), turns: [{ id: "a", itemsView: "summary", items: [] }] } };
    if (method === "thread/turns/list") return params.cursor ? { data: [{ id: "b", itemsView: "full", items: [message("b", "b")] }], nextCursor: null } : { data: [{ id: "a", itemsView: "summary", items: [] }], nextCursor: "turn2" };
    return params.cursor ? { data: [message("a2", "a2")], nextCursor: null } : { data: [message("a1", "a1")], nextCursor: "item2" };
  } };
  const got = await readThreadHistory(client, "one");
  assert.deepEqual(historyEvents(got).map((e) => e.text), ["a1", "a2", "b"]);
  assert.equal(calls.filter((m) => m === "thread/turns/items/list").length, 2);
});

function fakeBridge() {
  const emitted = [];
  const bridge = new CodexBridge({ defaultCwd: "D:/repo", approvalPolicy: "on-request", sandbox: "workspace-write" }, (m) => emitted.push(structuredClone(m)));
  const calls = [];
  bridge.codex.request = async (method, params) => { calls.push({ method, params }); return { thread: history(params.threadId || "new", 650) }; };
  bridge.models.resolve = async () => "model";
  return { bridge, emitted, calls };
}

test("bridge snapshot preserves full history and read-only state", async () => {
  const { bridge, emitted, calls } = fakeBridge();
  await bridge.dispatch({ type: "readThread", threadId: "one" });
  assert.equal(bridge.snapshot().recentEvents.length, 650);
  assert.equal(bridge.state.readOnly, true);
  assert.equal(emitted.at(-1).state.threadId, "one");
  assert.equal(calls[0].method, "thread/read");
  bridge._pushEvent({ kind: "item:agentMessage", id: "update", text: "one" });
  bridge._pushEvent({ kind: "item:agentMessage", id: "update", text: "two" });
  assert.equal(bridge.eventLog.length, 651);
});

test("external and previous-thread notifications cannot corrupt displayed history", async () => {
  const { bridge } = fakeBridge();
  await bridge.dispatch({ type: "readThread", threadId: "one" });
  const before = structuredClone(bridge.snapshot());
  bridge._onNotification({ method: "turn/started", params: { threadId: "one", turn: { id: "external" } } });
  bridge._onNotification({ method: "item/completed", params: { threadId: "old", item: message("other", "wrong") } });
  assert.deepEqual(bridge.snapshot(), before);
});

test("streaming snapshots retain partial text and completion replaces it by item ID", () => {
  const { bridge } = fakeBridge();
  bridge.state.threadId = "one";
  bridge.state.turnId = "turn";
  for (const delta of ["hello", " world"]) bridge._onNotification({ method: "item/agentMessage/delta", params: { threadId: "one", turnId: "turn", itemId: "item", delta } });
  assert.equal(bridge.snapshot().recentEvents[0].text, "hello world");
  assert.equal(bridge.snapshot().recentEvents[0].live, true);
  bridge._onNotification({ method: "item/completed", params: { threadId: "one", item: message("item", "hello world!") } });
  assert.equal(bridge.eventLog.length, 1);
  assert.equal(bridge.eventLog[0].text, "hello world!");
  assert.equal(bridge.eventLog[0].live, false);
  assert.equal(bridge.eventLog[0].status, "completed");
});

test("sending from history resumes on demand without creating a different conversation", async () => {
  const { bridge, calls } = fakeBridge();
  await bridge.dispatch({ type: "readThread", threadId: "one" });
  await bridge.dispatch({ type: "prompt", text: "continue" });
  assert.equal(bridge.state.readOnly, false);
  assert.equal(calls.some((c) => c.method === "thread/start"), false);
  assert.deepEqual(calls.filter((c) => c.method.startsWith("thread/") && c.method !== "thread/read" || c.method === "turn/start").map((c) => c.method), ["thread/resume", "turn/start"]);
  assert.equal(calls.at(-1).params.threadId, "one");
});

test("writer conflict on sending preserves history and never starts a turn", async () => {
  const { bridge, calls } = fakeBridge();
  await bridge.dispatch({ type: "readThread", threadId: "one" });
  bridge.codex.request = async (method) => { calls.push({ method }); throw new Error('thread one already has an active writer'); };
  bridge.writers.inspect = async () => ({ type: "writerConflict", threadId: "one", owners: [] });
  await bridge.dispatch({ type: "prompt", text: "do not lose me" });
  assert.equal(bridge.state.readOnly, true);
  assert.equal(bridge.snapshot().recentEvents.length, 650);
  assert.equal(calls.some((c) => c.method === "turn/start"), false);
});

test("new thread clears previous conversation instead of mixing histories", async () => {
  const { bridge } = fakeBridge();
  await bridge.dispatch({ type: "readThread", threadId: "one" });
  await bridge.dispatch({ type: "newThread" });
  assert.equal(bridge.state.readOnly, false);
  assert.equal(bridge.state.threadId, "new");
  assert.equal(bridge.eventLog.some((e) => e.text === "text0"), false);
});

test("concurrent selections finish in selection order and queue recovers after errors", async () => {
  const { bridge } = fakeBridge();
  const pending = [bridge.dispatch({ type: "readThread", threadId: "one" }), bridge.dispatch({ type: "readThread", threadId: "two" })];
  await Promise.all(pending);
  assert.equal(bridge.state.threadId, "two");
  bridge.state.status = "running";
  await assert.rejects(bridge.dispatch({ type: "readThread", threadId: "three" }));
  bridge.state.status = "idle";
  await bridge.dispatch({ type: "readThread", threadId: "four" });
  assert.equal(bridge.state.threadId, "four");
});
