const threadIdValue = value => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error("无效的会话 ID");
  return value;
};

// 两种传输共享会话生命周期，避免只切换界面却留下写入订阅。
export class ThreadLifecycle {
  constructor({ state, request, queue, permissions, pendingApprovals, changed, emit, clearCurrent, recycle }) {
    Object.assign(this, { state, request, queue, permissions, pendingApprovals, changed, emit, clearCurrent, recycle });
  }
  idle() {
    if (!this.state.codexConnected) throw new Error("Codex 未连接，无法管理会话");
    if (this.state.status === "running" || this.queue.active?.starting || this.pendingApprovals.size) throw new Error("请先停止当前任务并等待结束，再管理会话");
  }
  async loaded() {
    const ids = [], cursors = new Set();
    let cursor = null;
    do {
      const page = await this.request("thread/loaded/list", { limit: 100, cursor });
      if (!Array.isArray(page?.data) || page.data.some(id => typeof id !== "string")) throw new Error("无法确认会话卸载状态，请更新 Codex 后重试");
      ids.push(...page.data); cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error("已加载会话分页异常");
      cursors.add(cursor);
    } while (cursor);
    return [...new Set(ids)];
  }
  async release(threadId, { verify = true } = {}) {
    threadIdValue(threadId);
    if (threadId !== this.state.threadId) throw new Error("当前会话已变化，请重新选择后解除占用");
    this.idle();
    this.queue.pause(threadId, "会话已解除订阅，队列暂停");
    this.state.threadAction = "release"; this.changed();
    try {
      const result = await this.request("thread/unsubscribe", { threadId });
      if (!["unsubscribed", "notSubscribed", "notLoaded"].includes(result?.status)) throw new Error("Codex 未确认取消订阅，尚未解除占用");
      this.state.readOnly = true; this.state.turnId = null;
      this.state.writerReleased = result.status === "notLoaded";
      this.permissions.reset(); this.changed();
      if (verify && !this.state.writerReleased) {
        const loaded = await this.loaded();
        if (loaded.includes(threadId)) {
          // 新版取消订阅有卸载宽限期；只重连本应用的空闲子进程。
          for (const id of loaded) {
            const { thread } = await this.request("thread/read", { threadId: id, includeTurns: false });
            if (!thread || !["idle", "notLoaded"].includes(thread.status?.type)) throw new Error("本中继仍有运行中或状态未知的会话，暂不能重连控制进程；请稍后再解除占用");
          }
          this.idle();
          await this.recycle();
        }
        if ((await this.loaded()).includes(threadId)) throw new Error("会话仍未卸载，请稍后重试解除占用");
        this.state.writerReleased = true;
      }
      return { threadId, writerReleased: this.state.writerReleased };
    } finally { this.state.threadAction = null; this.changed(); }
  }
  async beforeSwitch() {
    if (this.state.threadId && !this.state.readOnly) await this.release(this.state.threadId, { verify: false });
  }
  async remove(threadId, confirmed) {
    threadIdValue(threadId);
    if (confirmed !== true) throw new Error("请先确认永久删除会话");
    this.idle();
    this.state.threadAction = "delete"; this.changed();
    try {
      const { thread } = await this.request("thread/read", { threadId, includeTurns: false });
      if (!thread || !["idle", "notLoaded"].includes(thread.status?.type)) throw new Error("目标会话正在运行或状态未知，请先停止后再删除");
      await this.request("thread/delete", { threadId });
      this.deleted(threadId);
    } catch (error) {
      if (/unknown variant|method not found|not supported/i.test(error.message)) throw new Error("当前 Codex 不支持删除会话，请升级 Codex 后重试");
      throw error;
    } finally { this.state.threadAction = null; this.changed(); }
  }
  deleted(threadId) {
    this.queue.removeThread(threadId);
    if (this.state.threadId === threadId) this.clearCurrent();
    this.emit({ type: "threadDeleted", threadId });
  }
  notification(method, params) {
    if (method === "thread/deleted") { this.deleted(params.threadId); return true; }
    if (method === "thread/closed") {
      if (this.state.threadId === params.threadId && this.state.readOnly) { this.state.writerReleased = true; this.changed(); }
      return true;
    }
    return false;
  }
}

export async function restartIdleCodex(client, bootstrap) {
  const child = client.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error("控制进程已退出，请等待连接恢复后重试");
  client.releasingChild = child;
  for (const pending of client.pending.values()) pending.reject(new Error("会话释放期间控制连接重连，请重试读取"));
  client.pending.clear();
  try {
    // EOF 让专用 app-server 正常退出；不杀外部进程，也不重启中继。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("控制进程尚未退出，未强制结束进程，请稍后重试")); }, 10000);
      const cleanup = () => { clearTimeout(timer); child.off("close", closed); child.off("error", failed); };
      const closed = () => { cleanup(); resolve(); };
      const failed = error => { cleanup(); reject(error); };
      child.once("close", closed); child.once("error", failed);
      child.stdin.end();
    });
    client.buf = "";
    client.start();
    await bootstrap();
  } finally { client.releasingChild = null; }
}
