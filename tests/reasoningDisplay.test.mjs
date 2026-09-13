import test from "node:test";
import assert from "node:assert/strict";
import { CodexBridge } from "../core/codexBridge.mjs";
import { itemToEvent } from "../core/threadDisplay.mjs";

function fixture() {
  const bridge = new CodexBridge({}, () => {});
  Object.assign(bridge.state, { threadId: "one", turnId: "active", status: "running" });
  bridge.history = { paged: true, nextCursor: null };
  const notify = (method, params) => bridge._onNotification({ method, params: { threadId: "one", turnId: "active", ...params } });
  const item = { id: "thought", type: "reasoning", summary: [], content: [] };
  return { bridge, notify, item };
}

test("empty reasoning completion settles the original entry immediately", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/completed", { item });
  assert.equal(bridge.eventLog.length, 1);
  assert.equal(bridge.eventLog[0].live, false);
  assert.equal(bridge.eventLog[0].status, "completed");
  assert.equal(bridge.eventLog[0].text, "");
});

test("reasoning completion without repeated text retains the streamed summary", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/reasoning/summaryTextDelta", { itemId: item.id, summaryIndex: 0, delta: "visible summary" });
  notify("item/completed", { item });
  assert.equal(bridge.eventLog[0].text, "visible summary");
  assert.equal(bridge.eventLog[0].live, false);
});

test("reasoning content deltas are displayed when no summary is supplied", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/reasoning/textDelta", { itemId: item.id, contentIndex: 0, delta: "provided content" });
  assert.equal(bridge.eventLog[0].text, "provided content");
  assert.equal(bridge.eventLog[0].reasoningSource, "content");
});

test("summary replaces earlier content and later content never pollutes it", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/reasoning/textDelta", { itemId: item.id, contentIndex: 0, delta: "provided content" });
  notify("item/reasoning/summaryTextDelta", { itemId: item.id, summaryIndex: 0, delta: "summary" });
  notify("item/reasoning/textDelta", { itemId: item.id, contentIndex: 0, delta: "ignored content" });
  notify("item/reasoning/summaryTextDelta", { itemId: item.id, summaryIndex: 0, delta: " continued" });
  assert.equal(bridge.eventLog[0].text, "summary continued");
  assert.equal(bridge.eventLog[0].reasoningSource, "summary");
  notify("item/completed", { item });
  assert.equal(bridge.eventLog[0].text, "summary continued");
  assert.equal(bridge.eventLog[0].live, false);
});

test("completion with only content cannot overwrite an already received summary", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/reasoning/summaryTextDelta", { itemId: item.id, summaryIndex: 0, delta: "summary" });
  notify("item/completed", { item: { ...item, content: ["provided content"] } });
  assert.equal(bridge.eventLog[0].text, "summary");
  assert.equal(bridge.eventLog[0].reasoningSource, "summary");
});

test("long reasoning windows reset their absolute positions when switching to summary", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/reasoning/textDelta", { itemId: item.id, contentIndex: 0, delta: "x".repeat(30000) });
  assert.equal(bridge.eventLog[0].text.length, 8192);
  assert.equal(bridge.eventLog[0].textOffset, 30000 - 8192);
  notify("item/reasoning/summaryTextDelta", { itemId: item.id, summaryIndex: 0, delta: "summary" });
  assert.equal(bridge.eventLog[0].text, "summary");
  assert.equal(bridge.eventLog[0].textOffset, 0);
  assert.equal(bridge.eventLog[0].textLength, 7);
  assert.equal(bridge.eventLog[0].headText, undefined);
});

test("late and foreign reasoning content cannot reopen or corrupt an ended entry", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/reasoning/textDelta", { itemId: item.id, threadId: "other", delta: "foreign" });
  notify("item/reasoning/textDelta", { itemId: item.id, turnId: "old", delta: "old" });
  assert.equal(bridge.eventLog[0].text, "");
  notify("item/completed", { item });
  notify("item/reasoning/textDelta", { itemId: item.id, delta: "late" });
  assert.equal(bridge.eventLog[0].text, "");
  assert.equal(bridge.eventLog[0].live, false);
});

test("failed empty reasoning retains its error instead of disappearing", () => {
  const { bridge, notify, item } = fixture();
  notify("item/started", { item });
  notify("item/completed", { item: { ...item, error: { message: "fixture error" } } });
  assert.equal(bridge.eventLog[0].status, "failed");
  assert.equal(bridge.eventLog[0].error, "fixture error");
});

test("historical reasoning selects real summary text or falls back to provided content", () => {
  assert.equal(itemToEvent({ type: "reasoning", summary: [""], content: ["provided content"] }).text, "provided content");
  assert.equal(itemToEvent({ type: "reasoning", summary: ["summary"], content: ["provided content"] }).reasoningSource, "summary");
  assert.equal(itemToEvent({ type: "reasoning", summary: ["", " "], content: ["provided content"] }).text, "provided content");
});
