import crypto from "node:crypto";
import { normalizeImages, imageEcho, IMAGE_LIMITS } from "./imageInput.mjs";

export const QUEUE_LIMITS = { items: 20, text: 65536, totalChars: 262144, receipts: 200 };

export class PromptQueue {
  constructor({ getState, execute, schedule = task => Promise.resolve().then(task), onChange = () => {}, onSettled = () => {} }) {
    Object.assign(this, { getState, execute, schedule, onChange, onSettled });
    this.threads = new Map();
    this.active = null;
    this.scheduled = false;
    this.receipts = new Map();
  }
  bucket(threadId) {
    if (!this.threads.has(threadId)) this.threads.set(threadId, { items: [], paused: false, reason: "" });
    return this.threads.get(threadId);
  }
  snapshot(threadId = this.getState().threadId) {
    const bucket = this.threads.get(threadId);
    return { supported: true, threadId, paused: bucket?.paused || false, reason: bucket?.reason || "", items: (bucket?.items || []).map(item => ({ ...item, ...(item.images ? { images: imageEcho(item.images) } : {}), status: this.active?.id === item.id ? "starting" : "queued" })), activeId: this.active?.threadId === threadId ? this.active.id : null, acceptedRequestIds: [...this.receipts.keys()], limit: QUEUE_LIMITS.items };
  }
  changed() { this.onChange(this.snapshot()); }
  enqueue({ requestId, threadId, text, cwd, images }) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId)) throw new Error("消息请求 ID 无效");
    images = normalizeImages(images);
    if (typeof text !== "string" || (!text.trim() && !images.length) || text.length > QUEUE_LIMITS.text) throw new Error("消息为空或超过 65536 字符");
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.length > 4096)) throw new Error("工作目录无效");
    const signature = crypto.createHash("sha256").update(JSON.stringify([threadId, text, cwd, images])).digest("hex");
    const existing = this.receipts.get(requestId);
    if (existing) {
      if (existing.signature !== signature) throw new Error("同一请求 ID 不能用于不同消息");
      return { ...existing.receipt };
    }
    if (!threadId || threadId !== this.getState().threadId) throw new Error("消息只能排入当前会话");
    const allItems = [...this.threads.values()].flatMap(bucket => bucket.items);
    if (allItems.length >= QUEUE_LIMITS.items || allItems.reduce((n, item) => n + item.text.length, 0) + text.length > QUEUE_LIMITS.totalChars) throw new Error("待执行队列已满，请先取消消息或等待执行");
    const payloadChars = list => list.reduce((n, image) => n + image.dataUrl.length + (image.previewDataUrl || "").length, 0);
    if (allItems.reduce((n, item) => n + payloadChars(item.images || []), 0) + payloadChars(images) > IMAGE_LIMITS.queueChars) throw new Error("队列图片容量已满，请等待执行或取消部分消息");
    const item = { id: requestId, requestId, threadId, text, cwd, ...(images.length ? { images } : {}) };
    this.bucket(threadId).items.push(item);
    const receipt = { id: item.id, requestId, threadId };
    this.receipts.set(requestId, { signature, receipt });
    const protectedIds = new Set([...allItems.map(item => item.id), item.id, this.active?.id]);
    for (const id of this.receipts.keys()) {
      if (this.receipts.size <= QUEUE_LIMITS.receipts) break;
      if (!protectedIds.has(id)) this.receipts.delete(id);
    }
    this.changed(); this.kick();
    return { ...receipt };
  }
  cancel(threadId, id) {
    const bucket = this.threads.get(threadId);
    if (this.active?.id === id) throw new Error("已开始的消息请使用停止任务");
    if (!bucket?.items.some(item => item.id === id)) return;
    bucket.items = bucket.items.filter(item => item.id !== id);
    this.cleanup(); this.changed();
  }
  pause(threadId, reason = "队列已手动暂停") {
    if (!threadId) return;
    const bucket = this.bucket(threadId); bucket.paused = true; bucket.reason = String(reason).slice(0, 1024);
    this.cleanup(); this.changed();
  }
  pauseAll(reason) { for (const threadId of this.threads.keys()) this.pause(threadId, reason); }
  disconnect() { this.active = null; this.pauseAll("Codex 连接中断，请确认任务状态后继续队列"); }
  resume(threadId) {
    if (threadId !== this.getState().threadId) throw new Error("请先打开对应会话再继续队列");
    if (!this.getState().codexConnected) throw new Error("Codex 未连接，暂不能继续队列");
    const bucket = this.bucket(threadId); bucket.paused = false; bucket.reason = "";
    this.cleanup(); this.changed(); this.kick();
  }
  select(threadId) {
    const previous = this.getState().threadId;
    if (previous && previous !== threadId && this.threads.get(previous)?.items.length) this.pause(previous, "已切换会话，队列暂停");
  }
  cleanup() {
    const current = this.getState().threadId;
    for (const [id, bucket] of this.threads) if (!bucket.items.length && this.active?.threadId !== id && (id !== current || !bucket.paused)) this.threads.delete(id);
  }
  kick() {
    const state = this.getState(), bucket = this.threads.get(state.threadId);
    if (this.scheduled || this.active || state.status === "running" || !state.codexConnected || !bucket?.items.length || bucket.paused) return;
    this.scheduled = true;
    Promise.resolve(this.schedule(async () => { this.scheduled = false; await this.drain(); })).catch(error => { this.scheduled = false; this.pause(state.threadId, error.message); });
  }
  async drain() {
    const state = this.getState(), bucket = this.threads.get(state.threadId);
    if (this.active || state.status === "running" || !state.codexConnected || !bucket?.items.length || bucket.paused) return;
    const item = bucket.items[0];
    const active = this.active = { id: item.id, threadId: item.threadId, turnId: null, starting: true, completion: null };
    this.changed();
    try {
      const result = await this.execute(item);
      if (this.active !== active) return;
      if (!result?.turnId || (result.threadId && result.threadId !== item.threadId)) throw new Error("消息尚未启动，请检查会话占用状态后继续队列");
      active.turnId = result.turnId; active.starting = false;
      bucket.items.shift(); this.changed();
      if (active.completion) this.finish(active.completion);
    } catch (error) {
      if (this.active !== active) return;
      this.active = null; bucket.paused = true; bucket.reason = error.message; this.changed();
    }
  }
  started({ threadId, turnId }) {
    if (this.active?.threadId === threadId && this.active.starting) this.active.turnId = turnId;
  }
  complete(turn) {
    const state = this.getState();
    if (turn.threadId !== state.threadId || (state.turnId && turn.turnId !== state.turnId)) return;
    if (this.active) {
      if (this.active.threadId !== turn.threadId || !this.active.turnId || this.active.turnId !== turn.turnId || this.active.completion) return;
      this.active.completion = turn;
      if (!this.active.starting) this.finish(turn);
    } else {
      if (turn.status !== "completed" && this.threads.get(turn.threadId)?.items.length) {
        this.pause(turn.threadId, turn.reason || "上一任务未成功，队列暂停");
      }
      this.kick();
    }
  }
  finish(turn) {
    this.active = null;
    const bucket = this.bucket(turn.threadId);
    if (turn.status !== "completed") { bucket.paused = true; bucket.reason = turn.reason || "上一任务未成功，队列暂停"; }
    this.onSettled(turn); this.cleanup(); this.changed(); this.kick();
  }
}
