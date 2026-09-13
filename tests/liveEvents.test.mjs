import test from "node:test";
import assert from "node:assert/strict";
import { CodexBridge } from "../core/codexBridge.mjs";
import { itemToEvent } from "../core/threadDisplay.mjs";

function fixture() {
  const messages = [], bridge = new CodexBridge({}, m => messages.push(structuredClone(m)));
  Object.assign(bridge.state, { threadId: "one", turnId: "active", status: "running", codexConnected: true });
  bridge.history = { paged: true, nextCursor: null };
  const notify = (method, params) => bridge._onNotification({ method, params: { threadId: "one", turnId: "active", ...params } });
  return { bridge, messages, notify };
}

test("empty assistant starts reserve item order across interleaved tool output", () => {
  const { bridge, notify } = fixture();
  notify("item/started", { item: { id: "reply", type: "agentMessage", text: "" } });
  notify("item/started", { item: { id: "tool", type: "commandExecution", command: "fixture" } });
  notify("item/agentMessage/delta", { itemId: "reply", delta: "reply" });
  assert.deepEqual(bridge.eventLog.map(e => e.itemId), ["reply", "tool"]);
  notify("item/completed", { item: { id: "reply", type: "agentMessage", text: "reply" } });
  assert.deepEqual(bridge.eventLog.map(e => e.itemId), ["reply", "tool"]);
});

test("late duplicate starts cannot blank or reopen an existing reply", () => {
  const { bridge, notify } = fixture();
  notify("item/agentMessage/delta", { itemId: "reply", delta: "reply" });
  notify("item/started", { item: { id: "reply", type: "agentMessage", text: "" } });
  assert.equal(bridge.eventLog[0].text, "reply");
  notify("item/completed", { item: { id: "reply", type: "agentMessage", text: "reply" } });
  notify("item/started", { item: { id: "reply", type: "agentMessage", text: "" } });
  assert.equal(bridge.eventLog[0].text, "reply");
  assert.equal(bridge.eventLog[0].live, false);
});

test("tool start, streamed output and completion update the same identified event", () => {
  const { bridge, messages, notify } = fixture();
  notify("item/started", { item: { type: "commandExecution", id: "command", command: "fixture --test", status: "inProgress" } });
  notify("item/commandExecution/outputDelta", { itemId: "command", delta: "first output" });
  const streamed = bridge.snapshot().recentEvents.find(e => e.itemId === "command");
  assert.equal(streamed.status, "running");
  assert.equal(streamed.output, "first output");
  assert.equal(streamed.command, "fixture --test");
  const delta = messages.find(m => m.type === "outputDelta");
  assert.equal(delta.threadId, "one"); assert.equal(delta.turnId, "active"); assert.equal(delta.itemId, "command");
  notify("item/completed", { item: { type: "commandExecution", id: "command", command: "fixture --test", exitCode: 1, status: "failed", aggregatedOutput: "first output" } });
  const events = bridge.snapshot().recentEvents.filter(e => e.itemId === "command");
  assert.equal(events.length, 1); assert.equal(events[0].status, "failed"); assert.equal(events[0].exitCode, 1);
  assert.equal(events[0].live, false);
});

test("unidentified, foreign and late output cannot create or corrupt tool messages", () => {
  const { bridge, messages, notify } = fixture();
  notify("item/commandExecution/outputDelta", { delta: "no identity" });
  notify("item/commandExecution/outputDelta", { itemId: "foreign", threadId: "other", delta: "foreign" });
  notify("item/commandExecution/outputDelta", { itemId: "old", turnId: "old", delta: "old" });
  assert.equal(messages.length, 0);
  notify("item/completed", { item: { type: "commandExecution", id: "command", command: "fixture", exitCode: 0, aggregatedOutput: "done" } });
  const count = messages.length;
  notify("item/commandExecution/outputDelta", { itemId: "command", delta: "late" });
  assert.equal(messages.length, count);
  assert.equal(bridge.eventLog[0].output, "done");
});

test("long assistant streams retain bounded head and latest windows with absolute positions", () => {
  const { bridge, notify } = fixture();
  const full = "HEAD-" + "x".repeat(30000) + "-LATEST";
  notify("item/agentMessage/delta", { itemId: "long", delta: full.slice(0, 15000) });
  notify("item/agentMessage/delta", { itemId: "long", delta: full.slice(15000) });
  let event = bridge.eventLog[0];
  assert.equal(event.text, full.slice(-8192));
  assert.equal(event.headText, full.slice(0, 8192));
  assert.equal(event.textOffset, full.length - 8192);
  assert.equal(event.textLength, full.length);
  assert.equal(event.preview, "tail");
  notify("item/completed", { item: { type: "agentMessage", id: "long", text: full } });
  event = bridge.eventLog[0];
  assert.equal(event.text, full.slice(-8192));
  assert.equal(event.headText, undefined);
  assert.equal(event.live, false);
  assert(event.detailCursor);
});

test("large command logs and structured file previews remain bounded", () => {
  const { bridge, notify } = fixture();
  notify("item/started", { item: { type: "commandExecution", id: "command", command: "fixture" } });
  notify("item/commandExecution/outputDelta", { itemId: "command", delta: "x".repeat(30000) + "LATEST" });
  const event = bridge.eventLog[0];
  assert.equal(event.text.length, 8192); assert.equal(event.output.length, 8192);
  assert(event.output.endsWith("LATEST")); assert.equal(event.outputLength, 30006);
  const files = itemToEvent({ type: "fileChange", id: "files", changes: Array.from({ length: 100 }, (_, i) => ({ path: "file" + i + "x".repeat(2000), kind: { type: "add" }, diff: "diff".repeat(10000) })) });
  assert.equal(files.changeCount, 100);
  assert(files.changes.length <= 20);
  assert(files.changes.reduce((n, change) => n + change.path.length + change.diff.length, 0) <= 8192);
});

test("tool starts are visible before results and reuse their original message", () => {
  const { bridge, notify } = fixture();
  for (const type of ["mcpToolCall", "dynamicToolCall", "fileChange", "reasoning"]) {
    notify("item/started", { item: { type, id: type, server: "fixture", tool: "test" } });
    assert.equal(bridge.eventLog.find(e => e.itemId === type)?.status, "running");
    notify("item/completed", { item: { type, id: type, server: "fixture", tool: "test", text: "done", summary: ["summary"], error: { message: "fixture error" } } });
    const events = bridge.eventLog.filter(e => e.itemId === type);
    assert.equal(events.length, 1); assert.equal(events[0].status, "failed");
  }
});

test("stopping a turn settles unfinished tool messages instead of leaving them running", () => {
  const { bridge, notify } = fixture();
  notify("item/started", { item: { type: "mcpToolCall", id: "tool", server: "fixture", tool: "test" } });
  notify("turn/completed", { turn: { id: "active", status: "interrupted" } });
  assert.equal(bridge.eventLog.find(e => e.itemId === "tool").status, "interrupted");
  assert.equal(bridge.eventLog.find(e => e.itemId === "tool").live, false);
  assert(bridge.eventLog.find(e => e.kind === "turn").text.includes("停止"));
});

test("resumed partial history can continue streaming without inventing omitted content", () => {
  const { bridge, notify } = fixture();
  bridge.eventLog.push({ id: "one:active:partial", threadId: "one", turnId: "active", itemId: "partial", kind: "item:agentMessage", text: "HEAD" + "x".repeat(8188), textLength: 20000, truncated: true });
  notify("item/agentMessage/delta", { itemId: "partial", delta: "LATEST" });
  const event = bridge.eventLog[0];
  assert.equal(event.live, true);
  assert.equal(event.text, "LATEST");
  assert.equal(event.textOffset, 20000);
  assert.equal(event.textLength, 20006);
  assert(event.headText.startsWith("HEAD"));
});
