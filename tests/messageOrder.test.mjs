import test from "node:test";
import assert from "node:assert/strict";
import { mergeMessageEvents } from "../core/messageOrder.mjs";

const events = (...ids) => ids.map(id => ({ id, text: id }));
const order = events => events.map(event => event.id);

test("canonical history keeps live markers beside their original item anchors", () => {
  assert.deepEqual(order(mergeMessageEvents(events("old", "user", "reply", "tool", "final"), events("old", "echo", "start", "reply", "tool", "final", "end"))), ["old", "user", "echo", "start", "reply", "tool", "final", "end"]);
});

test("stale history cannot reorder new live items or lose their updates", () => {
  assert.deepEqual(order(mergeMessageEvents(events("old"), events("old", "echo", "start", "reply", "tool", "final"))), ["old", "echo", "start", "reply", "tool", "final"]);
  assert.equal(mergeMessageEvents(events("reply"), [{ id: "reply", text: "latest" }])[0].text, "latest");
});

test("canonical order wins over overlapping live arrival order without duplicates", () => {
  assert.deepEqual(order(mergeMessageEvents(events("user", "reply", "tool", "final"), events("user", "tool", "reply", "final", "end"))), ["user", "reply", "tool", "final", "end"]);
});
