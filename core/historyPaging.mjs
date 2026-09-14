import crypto from "node:crypto";
import { itemToEvent } from "./threadDisplay.mjs";
import { imageChars } from "./imageInput.mjs";

export const HISTORY_LIMITS = { events: 50, chars: 65536, itemChars: 8192, turns: 8, recent: 100 };

export class HistoryPager {
  constructor(client) { this.client = client; this.secret = crypto.randomBytes(32); }
  async items(params, turnCursor = null) {
    if (this.itemsMethod === "turn") {
      const p = await this.client.request("thread/turns/list", { threadId: params.threadId, cursor: turnCursor, limit: 1, sortDirection: "desc", itemsView: "full" });
      const turn = p.data?.find(t => t.id === params.turnId);
      if (!turn) throw new Error("历史轮次已变化，请重新打开会话");
      return { data: (turn.items || []).slice().reverse(), nextCursor: null };
    }
    let page;
    const method = this.itemsMethod || "thread/items/list";
    try { page = await this.client.request(method, params); this.itemsMethod ||= method; }
    catch (error) {
      if (!/unknown variant|method not found|not supported yet/i.test(error.message)) throw error;
      if (method === "thread/items/list") {
        if (!this.itemsMethod || this.itemsMethod === method) this.itemsMethod = "thread/turns/items/list";
      } else this.itemsMethod = "turn";
      return this.items(params, turnCursor);
    }
    return { ...page, data: (page.data || []).map(entry => entry.item || entry) };
  }
  encode(value) {
    const data = Buffer.from(JSON.stringify(value)).toString("base64url");
    return data + "." + crypto.createHmac("sha256", this.secret).update(data).digest("base64url");
  }
  decode(token, threadId) {
    if (typeof token !== "string" || token.length > 12000) throw new Error("历史游标无效，请重新打开会话");
    const parts = token.split("."), [data, signature] = parts;
    const expected = crypto.createHmac("sha256", this.secret).update(data || "").digest("base64url");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(signature || "") || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("历史游标已失效，请重新打开会话");
    const value = JSON.parse(Buffer.from(data, "base64url").toString());
    if (value.threadId !== threadId) throw new Error("历史游标不属于当前会话");
    return value;
  }
  async open(threadId) {
    const { thread } = await this.client.request("thread/read", { threadId, includeTurns: false });
    const page = await this.page(threadId);
    return { ...page, thread };
  }
  async page(threadId, cursor) {
    let state = cursor ? this.decode(cursor, threadId) : { threadId, turnCursor: null };
    const events = [], turns = [];
    let chars = 0, requests = 0, exhausted = false;
    while (events.length < HISTORY_LIMITS.events && requests < HISTORY_LIMITS.turns * 2) {
      if (!state.turn) {
        let p;
        try { p = await this.client.request("thread/turns/list", { threadId, cursor: state.turnCursor, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }); }
        catch (error) { if (/not materialized yet/.test(error.message)) { exhausted = true; break; } throw error; }
        requests++;
        if (!p.data?.length) { exhausted = true; break; }
        const t = p.data[0];
        if (p.nextCursor && p.nextCursor === state.turnCursor) throw new Error("历史轮次游标重复");
        const errorText = String(t.error?.message || "");
        state = { threadId, turn: { id: t.id, startedAt: t.startedAt, completedAt: t.completedAt, status: t.status, error: errorText ? { message: errorText.slice(0, 1024), textLength: errorText.length } : null }, turnCursor: state.turnCursor, nextTurnCursor: p.nextCursor, itemCursor: null, skip: 0 };
      }
      const t = state.turn;
      turns.push(t);
      if (t.error?.message && !state.errorSent) {
        if (events.length && chars + t.error.message.length > HISTORY_LIMITS.chars) break;
        events.push({ id: threadId + ":" + t.id + ":error", kind: "error", text: t.error.message, textLength: t.error.textLength, truncated: t.error.textLength > t.error.message.length, detailCursor: this.encode({ threadId, turnId: t.id, turnCursor: state.turnCursor, error: true }), ts: (t.completedAt || 0) * 1000 });
        chars += t.error.message.length;
        state.errorSent = true;
        if (events.length >= HISTORY_LIMITS.events) break;
      }
      const p = await this.items({ threadId, turnId: t.id, cursor: state.itemCursor, limit: HISTORY_LIMITS.events, sortDirection: "desc" }, state.turnCursor);
      requests++;
      if (p.nextCursor && p.nextCursor === state.itemCursor) throw new Error("历史条目游标重复");
      const items = p.data || [];
      let i = state.skip || 0;
      if (state.skipAfter) {
        const anchor = items.findIndex(item => item.id === state.skipAfter);
        if (anchor < 0) throw new Error("历史分页锚点已变化，请重新打开会话");
        i = anchor + 1;
      }
      for (; i < items.length; i++) {
        const item = items[i], event = itemToEvent(item);
        if (!event) continue;
        const text = event.text.slice(0, HISTORY_LIMITS.itemChars);
        if (events.length >= HISTORY_LIMITS.events || (events.length && chars + text.length + imageChars(event) > HISTORY_LIMITS.chars)) break;
        const detailCursor = this.encode({ threadId, turnId: t.id, turnCursor: state.turnCursor, itemCursor: state.itemCursor, itemId: item.id });
        events.push({ ...event, text, textLength: event.text.length, truncated: text.length < event.text.length, detailCursor, id: [threadId, t.id, item.id].join(":"), threadId, turnId: t.id, ts: (t.startedAt || 0) * 1000 });
        chars += text.length + imageChars(event);
      }
      if (i < items.length) { state.skip = i; state.skipAfter = i > 0 ? items[i - 1].id : null; break; }
      if (p.nextCursor) { state.itemCursor = p.nextCursor; state.skip = 0; state.skipAfter = null; continue; }
      if (!state.nextTurnCursor) { exhausted = true; break; }
      state = { threadId, turnCursor: state.nextTurnCursor };
    }
    return { threadId, events: events.reverse(), turns, nextCursor: exhausted ? null : this.encode(state) };
  }
  async item(threadId, cursor, offset = 0) {
    const s = this.decode(cursor, threadId);
    if ((!s.itemId && !s.error) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("历史内容位置无效");
    let event;
    if (s.error) {
      const p = await this.client.request("thread/turns/list", { threadId, cursor: s.turnCursor, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      const turn = p.data?.find(t => t.id === s.turnId);
      if (turn?.error?.message) event = { text: String(turn.error.message) };
    } else {
      const p = await this.items({ threadId, turnId: s.turnId, cursor: s.itemCursor, limit: HISTORY_LIMITS.events, sortDirection: "desc" }, s.turnCursor);
      event = itemToEvent((p.data || []).find(i => i.id === s.itemId) || {});
    }
    if (!event) throw new Error("历史内容已变化，请重新加载该页");
    return { threadId, itemId: s.itemId, detailCursor: cursor, offset, text: event.text.slice(offset, offset + HISTORY_LIMITS.itemChars), textLength: event.text.length, nextOffset: offset + HISTORY_LIMITS.itemChars < event.text.length ? offset + HISTORY_LIMITS.itemChars : null };
  }
}

export function trimRecent(events) {
  if (events.length > HISTORY_LIMITS.recent) events.splice(0, events.length - HISTORY_LIMITS.recent);
}

export function boundEvent(event, pager) {
  const text = event.text || "";
  const textLength = event.textLength ?? text.length;
  if (textLength <= HISTORY_LIMITS.itemChars) return event;
  return { ...event, text: text.slice(0, HISTORY_LIMITS.itemChars), textLength, truncated: true,
    detailCursor: event.detailCursor || (event.itemId && event.threadId && event.turnId ? pager.encode({ threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, itemCursor: null }) : null) };
}
