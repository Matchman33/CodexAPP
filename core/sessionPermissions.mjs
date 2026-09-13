const modes = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };

export function sandboxPolicy(mode) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: [], networkAccess: false };
}

export class SessionPermissions {
  constructor(state, request, changed, failed = () => {}) {
    Object.assign(this, { state, request, changed, failed });
    this.revision = 0;
    this.reset();
  }
  selection() { return { approvalPolicy: this.state.approvalPolicy || "on-request", sandbox: this.state.sandbox || "workspace-write" }; }
  reset() {
    this.revision++;
    this.policy = null; this.freshThreadId = null; this.detachedThreadId = null;
    this.state.permissions = { supported: true, applied: null, pending: !!this.state.threadId, applying: false, error: null };
  }
  selected() {
    const selected = this.selection(), applied = this.state.permissions.applied;
    this.state.permissions.pending = !!this.state.threadId && (!applied || applied.approvalPolicy !== selected.approvalPolicy || applied.sandbox !== selected.sandbox);
    this.state.permissions.error = null;
  }
  confirm(response, requested = this.selection(), fresh = false) {
    requested = { approvalPolicy: requested.approvalPolicy || this.selection().approvalPolicy, sandbox: requested.sandbox || this.selection().sandbox };
    this.revision++;
    const policy = response?.sandboxPolicy || response?.sandbox || sandboxPolicy(requested.sandbox);
    this.policy = typeof policy === "string" ? sandboxPolicy(policy) : policy;
    this.state.permissions.applied = { approvalPolicy: response?.approvalPolicy ?? requested.approvalPolicy, sandbox: typeof policy === "string" ? policy : modes[policy.type] || "external-sandbox" };
    this.freshThreadId = fresh ? this.state.threadId : null;
    this.detachedThreadId = null;
    this.selected();
  }
  turnPolicy() {
    const mode = this.selection().sandbox;
    return this.state.permissions.applied?.sandbox === mode && this.policy ? structuredClone(this.policy) : sandboxPolicy(mode);
  }
  observe(settings) {
    this.confirm(settings, this.selection(), this.freshThreadId === this.state.threadId);
  }
  acceptedTurn(requested, policy, revision) {
    this.freshThreadId = null;
    if (this.revision === revision) this.confirm({ sandbox: policy, approvalPolicy: requested.approvalPolicy }, requested);
  }
  async ask(method, params) {
    let timer;
    try {
      return await Promise.race([this.request(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("权限同步超时：" + method)), 8000); })]);
    } finally { clearTimeout(timer); }
  }
  async apply() {
    const state = this.state;
    if (!state.permissions.pending) return true;
    if (state.status === "running" || !state.codexConnected || (state.readOnly && this.detachedThreadId !== state.threadId) || !state.threadId || state.threadId === this.freshThreadId) return false;
    const threadId = state.threadId, requested = this.selection();
    state.permissions.applying = true; state.permissions.error = null; this.changed();
    let detached = this.detachedThreadId === threadId;
    try {
      // Resume of an already loaded thread ignores overrides; detach only after its turn ended.
      if (!detached) await this.ask("thread/unsubscribe", { threadId });
      detached = true;
      this.detachedThreadId = threadId;
      state.permissions.applied = null; this.policy = null;
      const response = await this.ask("thread/resume", { threadId, ...requested, excludeTurns: true });
      if (state.threadId !== threadId || (response?.thread?.id && response.thread.id !== threadId)) throw new Error("权限同步期间会话已变化");
      this.confirm(response, requested);
      detached = false; state.readOnly = false;
      if (state.permissions.pending) throw new Error("后端实际权限与所选权限不一致，请检查权限限制后重试");
      return true;
    } catch (error) {
      if (state.threadId === threadId) {
        if (detached) state.readOnly = true;
        state.permissions.pending = true; state.permissions.error = String(error.message).slice(0, 1024);
        this.failed(threadId, state.permissions.error);
      }
      return false;
    } finally { state.permissions.applying = false; this.changed(); }
  }
}
