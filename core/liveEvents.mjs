import { itemToEvent } from "./threadDisplay.mjs";
import { appendTextPreview, appendReasoningPreview, clipTextPreview } from "./textPreview.mjs";

export function liveItemEvent(item, phase, context, previous, limit = null) {
  if (!item?.id || item.type === "userMessage") return null;
  if (phase === "started" && previous?.live === false) return null;
  let event = itemToEvent(item);
  if (!event && ((phase === "started" && ["agentMessage", "reasoning", "plan"].includes(item.type)) || (phase === "completed" && item.type === "reasoning"))) {
    event = { kind: "item:" + item.type, text: "", itemId: item.id };
  }
  if (!event) return null;
  const failed = !!item.error || ["failed", "declined", "denied"].includes(item.status) || (item.exitCode != null && item.exitCode !== 0);
  event = { ...event, ...context, id: [context.threadId, context.turnId, item.id].join(":"), live: phase === "started", status: phase === "started" ? "running" : failed ? "failed" : item.status === "interrupted" ? "interrupted" : "completed" };
  if (item.error?.message && !event.error) event.error = String(item.error.message).slice(0, 2048);
  if (previous && (!event.text || (item.type === "reasoning" && (!event.text.trim() || (previous.reasoningSource === "summary" && event.reasoningSource === "content"))))) {
    event = { ...event, text: previous.text, textLength: previous.textLength, textOffset: previous.textOffset, headText: previous.headText };
    if (previous.reasoningSource) event.reasoningSource = previous.reasoningSource;
  }
  if (item.type === "commandExecution" && previous?.outputLength && item.aggregatedOutput === undefined) {
    Object.assign(event, { text: previous.text, textLength: previous.textLength, textOffset: previous.textOffset, output: previous.output, outputLength: previous.outputLength, outputStart: previous.outputStart, headText: previous.headText });
  }
  if (limit !== null) event = clipTextPreview(event, limit, previous?.preview === "tail");
  if (!event.live) delete event.headText;
  return event;
}

export function liveDeltaEvent(previous, context, delta, kind, limit = null) {
  const base = previous || { ...context, kind, id: [context.threadId, context.turnId, context.itemId].join(":"), text: "", ts: Date.now() };
  const event = kind === "item:reasoning" ? appendReasoningPreview(base, delta, context.reasoningSource || "summary", limit) : appendTextPreview(base, delta, limit);
  if (!event) return null;
  if (kind === "item:commandExecution") {
    event.output = event.text.slice(Math.max(0, (event.outputStart || 0) - (event.textOffset || 0))).slice(-8192);
    event.outputLength = (previous?.outputLength || 0) + delta.length;
  }
  return event;
}

export function settleLiveEvents(events, threadId, turnId, status) {
  return events.filter(event => event.live && event.threadId === threadId && event.turnId === turnId).map(event => {
    const settled = { ...event, live: false, status: ["failed", "interrupted"].includes(status) ? status : "ended" };
    delete settled.headText;
    return settled;
  });
}

export function completedTurnEvent(turn, tokens = "") {
  const text = turn?.status === "completed" ? "执行完成" : turn?.status === "failed" ? "执行失败" : turn?.status === "interrupted" ? "任务已停止" : "任务已结束";
  return { kind: "turn", status: turn?.status || "ended", text: text + tokens + (turn?.error?.message ? "\n" + String(turn.error.message).slice(0, 2048) : "") };
}
