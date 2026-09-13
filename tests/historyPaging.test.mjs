import test from "node:test";
import assert from "node:assert/strict";
import { HistoryPager } from "../core/historyPaging.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";

function fixture(count = 2000, text = "message") {
  const calls = [];
  const items = Array.from({ length: count }, (_, i) => ({ id: "m" + i, type: "agentMessage", text: text + i }));
  const client = { request: async (method, p) => {
    calls.push({ method, p });
    if (method === "thread/read") return { thread: { id: p.threadId, cwd: "/repo", turns: [] } };
    if (method === "thread/turns/list") return { data: p.cursor ? [] : [{ id: "turn", items: [], startedAt: 1, status: "completed" }], nextCursor: null };
    if (method === "thread/items/list") {
      const start = Number(p.cursor || 0), descending = items.slice().reverse();
      return { data: descending.slice(start, start + p.limit).map(item => ({ item, turnId: "turn" })), nextCursor: start + p.limit < count ? String(start + p.limit) : null };
    }
    throw new Error("unexpected " + method);
  } };
  return { pager: new HistoryPager(client), calls, client };
}

test("long history reads bounded recent items without loading all turns", async () => {
  const { pager, calls } = fixture();
  const page = await pager.open("one");
  assert.equal(calls[0].p.includeTurns, false);
  assert(page.events.length <= 50);
  assert.equal(page.events.at(-1).itemId, "m1999");
  assert(page.nextCursor);
  assert(calls.length <= 4);
});

test("every item remains accessible in chronological pages without duplicates", async () => {
  const { pager } = fixture(137);
  let page = await pager.open("one"), all = page.events;
  while (page.nextCursor) { page = await pager.page("one", page.nextCursor); all = [...page.events, ...all]; }
  assert.equal(all.length, 137);
  assert.equal(new Set(all.map(e => e.id)).size, 137);
  assert.equal(all[0].itemId, "m0");
});

test("large messages stay bounded and their remaining text is readable", async () => {
  const { pager } = fixture(25, "x".repeat(100000));
  let page = await pager.open("one"), all = page.events;
  assert(JSON.stringify(page).length < 150000);
  assert(page.events[0].truncated);
  const e = page.events.at(-1);
  const detail = await pager.item("one", e.detailCursor, 8192);
  assert.equal(detail.offset, 8192);
  assert.equal(detail.text.length, 8192);
  assert.equal(detail.nextOffset, 16384);
  while (page.nextCursor) { page = await pager.page("one", page.nextCursor); all = [...page.events, ...all]; }
  assert.equal(all.length, 25);
});

test("cursors cannot be reused for another conversation or forged", async () => {
  const { pager } = fixture();
  const p = await pager.open("one");
  await assert.rejects(pager.page("two", p.nextCursor));
  await assert.rejects(pager.page("one", "not-a-cursor"));
});

test("older Codex without item paging only hydrates one turn, preserving all its items", async () => {
  const items = Array.from({ length: 137 }, (_, i) => ({ id: "m" + i, type: "agentMessage", text: "text" + i }));
  const calls = [];
  const client = { request: async (method, p) => {
    calls.push({ method, p });
    if (method === "thread/read") return { thread: { id: "one" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn", items: p.itemsView === "full" ? items : [] }], nextCursor: null };
    throw new Error(method === "thread/items/list" ? "not supported yet" : "unknown variant");
  } };
  const pager = new HistoryPager(client);
  let p = await pager.open("one"), events = p.events;
  while (p.nextCursor) { p = await pager.page("one", p.nextCursor); events = [...p.events, ...events]; }
  assert.equal(events.length, 137);
  assert.equal(events[0].itemId, "m0");
  assert(calls.filter(c => c.method === "thread/turns/list").every(c => c.p.limit === 1));
});

test("failed turns include their error exactly once after their items", async () => {
  const { pager, client } = fixture(100);
  const request = client.request;
  client.request = async (method, p) => {
    const result = await request(method, p);
    if (method === "thread/turns/list") for (const t of result.data) t.error = { message: "failed" };
    return result;
  };
  let p = await pager.open("one"), events = p.events;
  while (p.nextCursor) { p = await pager.page("one", p.nextCursor); events = [...p.events, ...events]; }
  assert.equal(events.length, 101);
  assert.equal(events.at(-1).text, "failed");
});

test("paged bridge remains bounded during streaming and preserves active-turn stopping", async () => {
  const { client } = fixture();
  const emitted = [];
  const bridge = new CodexBridge({ approvalPolicy: "on-request", sandbox: "read-only" }, m => emitted.push(m));
  bridge.codex.request = async (method, p) => {
    if (method === "thread/resume") return { thread: { id: p.threadId }, initialTurnsPage: { data: [{ id: "active", status: "inProgress" }] } };
    if (method === "turn/interrupt") { assert.equal(p.turnId, "active"); return {}; }
    return client.request(method, p);
  };
  await bridge.dispatch({ type: "readThread", threadId: "one", historyMode: "paged", requestId: "selection" });
  assert.equal(emitted.at(-1).requestId, "selection");
  assert(bridge.eventLog.length <= 50);
  await bridge.dispatch({ type: "resumeThread", threadId: "one" });
  assert.equal(bridge.state.status, "running");
  await bridge.dispatch({ type: "interrupt" });
  for (let i = 0; i < 150; i++) bridge._pushEvent({ id: "live" + i, kind: "item:agentMessage", itemId: "live" + i, turnId: "active", text: "x".repeat(100000) });
  assert(bridge.eventLog.length <= 100);
  assert(bridge.eventLog.every(e => e.text.length <= 8192));
});

test("initialized paged history can resume and send with experimental capability negotiated", async () => {
  const { client } = fixture(5);
  const bridge = new CodexBridge({ approvalPolicy: "on-request", sandbox: "read-only" }, () => {});
  const calls = [];
  let experimental = false, initialized = false;
  bridge.codex.notify = method => { assert.equal(method, "initialized"); initialized = true; };
  bridge.models.resolve = async () => "fixture-model";
  bridge.models.resolveEffort = async () => null;
  bridge.codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "initialize") { experimental = params.capabilities?.experimentalApi === true; return { userAgent: "fixture" }; }
    assert(initialized, "initialize must complete before conversation requests");
    if (method === "thread/resume") {
      if (params.initialTurnsPage && !experimental) throw new Error('{"code":-32600,"message":"thread/resume.initialTurnsPage requires experimentalApi capability"}');
      assert.equal(params.excludeTurns, true);
      assert.equal(params.initialTurnsPage.limit, 1);
      return { thread: { id: params.threadId }, initialTurnsPage: { data: [] } };
    }
    if (method === "turn/start") return { turn: { id: "sent" } };
    return client.request(method, params);
  };
  await bridge._bootstrap();
  await bridge.dispatch({ type: "readThread", threadId: "one", historyMode: "paged", requestId: "selection" });
  assert(bridge.state.readOnly);
  assert.equal(calls.filter(c => c.method === "thread/resume").length, 0);
  await bridge.dispatch({ type: "prompt", text: "continue existing conversation" });
  assert.equal(calls.filter(c => c.method === "thread/resume").length, 1);
  assert.equal(calls.filter(c => c.method === "thread/start").length, 0);
  assert.equal(calls.at(-1).method, "turn/start");
  assert.equal(calls.at(-1).params.threadId, "one");
  assert.equal(bridge.state.readOnly, false);
  const userEvents = bridge.eventLog.filter(e => e.kind === "user");
  assert.equal(userEvents.length, 1);
  assert.equal(userEvents[0].inputEcho, true);
  assert.equal(userEvents[0].turnId, "sent");
});

test("read-only paging does not block control commands behind its response", async () => {
  const bridge = new CodexBridge({}, () => {});
  let finish;
  bridge.historyPager.page = () => new Promise(r => { finish = r; });
  const paging = bridge.dispatch({ type: "historyPage", threadId: "one" });
  await bridge.dispatch({ type: "setConfig", requestId: "settings" });
  finish({ events: [], nextCursor: null });
  await paging;
});

test("turn pagination walks all turns while bounding work per display page", async () => {
  const client = { request: async (method, p) => {
    if (method === "thread/read") return { thread: { id: "one" } };
    if (method === "thread/turns/list") {
      const index = Number(p.cursor || 0);
      return { data: [{ id: "t" + (24 - index), items: [] }], nextCursor: index < 24 ? String(index + 1) : null };
    }
    return { data: [{ item: { id: p.turnId, type: "agentMessage", text: p.turnId }, turnId: p.turnId }], nextCursor: null };
  } };
  const pager = new HistoryPager(client);
  let p = await pager.open("one"), events = p.events;
  assert.equal(p.events.length, 8);
  while (p.nextCursor) { p = await pager.page("one", p.nextCursor); events = [...p.events, ...events]; }
  assert.deepEqual(events.map(e => e.text), Array.from({ length: 25 }, (_, i) => "t" + i));
});

test("legacy implemented item API is selected once and normalizes its direct items", async () => {
  const { client } = fixture(5);
  const request = client.request; let probes = 0;
  client.request = async (method, p) => {
    if (method === "thread/items/list") { probes++; throw new Error("unknown variant"); }
    if (method === "thread/turns/items/list") { const result = await request("thread/items/list", p); return { ...result, data: result.data.map(e => e.item) }; }
    return request(method, p);
  };
  const pager = new HistoryPager(client);
  assert.equal((await pager.open("one")).events.length, 5);
  await pager.page("one");
  assert.equal(probes, 1);
});

test("oversized Unicode turn errors keep small cursors and readable remaining content", async () => {
  const { pager, client } = fixture(100);
  const request = client.request;
  client.request = async (method, p) => {
    const result = await request(method, p);
    if (method === "thread/turns/list") for (const t of result.data) t.error = { message: "错误".repeat(10000) };
    return result;
  };
  const p = await pager.open("one");
  const error = p.events.at(-1);
  assert(error.truncated);
  assert(p.nextCursor.length < 12000);
  await pager.page("one", p.nextCursor);
  const detail = await pager.item("one", error.detailCursor, error.text.length);
  assert.equal(detail.textLength, 20000);
  assert.equal(detail.text.length, 8192);
});

test("failed writer resume preserves paged history and never kills or starts a task", async () => {
  const { client } = fixture(100);
  const bridge = new CodexBridge({}, () => {});
  bridge.codex.request = client.request;
  await bridge.dispatch({ type: "readThread", threadId: "one", historyMode: "paged" });
  const before = structuredClone(bridge.snapshot());
  bridge.codex.request = async () => { throw new Error("thread one already has an active writer"); };
  bridge.writers.inspect = async () => ({ type: "writerConflict", threadId: "one" });
  await bridge.dispatch({ type: "resumeThread", threadId: "one" });
  assert.deepEqual(bridge.snapshot(), before);
});
