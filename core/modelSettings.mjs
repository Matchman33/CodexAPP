import fs from "node:fs";
import crypto from "node:crypto";

export function normalizeModel(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Model must be a string or null");
  const model = value.trim();
  if (!model) return null;
  if (model.length > 200 || /\s|[\x00-\x1f\x7f]/.test(model)) throw new Error("Invalid model ID");
  return model;
}

export function normalizeReasoningEffort(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error("无效的思考等级");
  }
  return value;
}

export function normalizeApprovalPolicy(value) {
  if (!["on-request", "untrusted", "on-failure", "never"].includes(value)) throw new Error("无效的审批策略");
  return value;
}

export function normalizeSandbox(value) {
  if (!["workspace-write", "read-only", "danger-full-access"].includes(value)) throw new Error("无效的沙箱模式");
  return value;
}

export function persistModel(file, model, settings = {}) {
  // 只保存用户选择，不将运行时凭据或环境变量覆盖值写入磁盘。
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const patch = { model };
    if (Object.hasOwn(settings, "reasoningEffort")) patch.reasoningEffort = settings.reasoningEffort;
    if (Object.hasOwn(settings, "approvalPolicy")) patch.approvalPolicy = normalizeApprovalPolicy(settings.approvalPolicy);
    if (Object.hasOwn(settings, "sandbox")) patch.sandbox = normalizeSandbox(settings.sandbox);
    fs.writeFileSync(temp, JSON.stringify({ ...config, ...patch }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export class ModelSettings {
  constructor(codex, config, save = () => {}) {
    this.codex = codex;
    this.config = config;
    this.save = save;
    this.cachedCatalog = null;
    this.catalogTime = 0;
  }

  select(value) {
    this.update({ model: value });
    return this.config.model;
  }

  update(patch) {
    const settings = {};
    if (Object.hasOwn(patch, "model")) settings.model = normalizeModel(patch.model);
    if (Object.hasOwn(patch, "reasoningEffort")) settings.reasoningEffort = normalizeReasoningEffort(patch.reasoningEffort);
    if (Object.hasOwn(patch, "approvalPolicy")) settings.approvalPolicy = normalizeApprovalPolicy(patch.approvalPolicy);
    if (Object.hasOwn(patch, "sandbox")) settings.sandbox = normalizeSandbox(patch.sandbox);
    if (!Object.keys(settings).length) return;
    const model = Object.hasOwn(settings, "model") ? settings.model : this.config.model;
    const effort = Object.hasOwn(settings, "reasoningEffort") ? settings.reasoningEffort : this.config.reasoningEffort;
    if (Object.hasOwn(settings, "model") || Object.hasOwn(settings, "reasoningEffort")) this.validateEffort(model, effort);
    this.save(model ?? null, settings);
    Object.assign(this.config, settings);
  }

  validateEffort(model, effort) {
    const entry = this.cachedCatalog?.find((m) => m.model === model);
    if (effort && entry?.supportedReasoningEfforts !== null && entry?.supportedReasoningEfforts !== undefined &&
        !entry.supportedReasoningEfforts.some((o) => o.reasoningEffort === effort)) {
      throw new Error(`模型 ${model} 不支持思考等级 ${effort}`);
    }
  }

  async request(method, params) {
    let timer;
    try {
      return await Promise.race([
        this.codex.request(method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} timed out`)), 8000); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async catalog() {
    const models = new Map();
    const cursors = new Set();
    let cursor = null;
    do {
      const res = await this.request("model/list", { limit: 100, cursor, includeHidden: false });
      for (const m of res?.data || []) {
        if (!m.hidden && typeof m.model === "string" && m.model && !models.has(m.model)) {
          models.set(m.model, {
            model: m.model, displayName: m.displayName || m.model, description: m.description || "", isDefault: !!m.isDefault,
            supportedReasoningEfforts: Array.isArray(m.supportedReasoningEfforts)
              ? [...new Map(m.supportedReasoningEfforts.filter((o) => typeof o?.reasoningEffort === "string")
                .map((o) => [o.reasoningEffort, { reasoningEffort: o.reasoningEffort, description: o.description || "" }])).values()] : null,
            defaultReasoningEffort: m.defaultReasoningEffort || null,
          });
        }
      }
      cursor = res?.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw new Error("Invalid model list cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    this.cachedCatalog = [...models.values()];
    this.catalogTime = Date.now();
    return this.cachedCatalog;
  }

  async defaultModel(cwd) {
    const res = await this.request("config/read", { cwd, includeLayers: false });
    if (res?.config?.model) return res.config.model;
    const models = await this.catalog();
    const model = models.find((m) => m.isDefault)?.model;
    if (!model) throw new Error("Cannot resolve default model; select an explicit model ID");
    return model;
  }

  async resolve(cwd) {
    // Omitting model on an existing thread keeps its previous override, not the default.
    return this.config.model || await this.defaultModel(cwd);
  }

  async resolveEffort(cwd, model, previousEffort = null) {
    if (!this.cachedCatalog || Date.now() - this.catalogTime > 60000) {
      try { await this.catalog(); } catch { /* 私有模型允许在目录不可用时继续使用。 */ }
    }
    if (this.config.reasoningEffort) {
      this.validateEffort(model, this.config.reasoningEffort);
      return this.config.reasoningEffort;
    }
    let defaults;
    try { defaults = (await this.request("config/read", { cwd, includeLayers: false }))?.config; } catch {}
    const entry = this.cachedCatalog?.find((m) => m.model === model);
    if ((!defaults?.model || defaults.model === model) && defaults?.model_reasoning_effort) {
      const effort = normalizeReasoningEffort(defaults.model_reasoning_effort);
      this.validateEffort(model, effort);
      return effort;
    }
    if (entry?.defaultReasoningEffort) return entry.defaultReasoningEffort;
    if (Array.isArray(entry?.supportedReasoningEfforts) && !entry.supportedReasoningEfforts.length) return null;
    if (previousEffort) throw new Error("无法确定模型的默认思考等级，请选择明确的等级后再发送");
    return null;
  }

  async list(cwd) {
    const [catalog, defaults, config] = await Promise.allSettled([
      this.catalog(), this.defaultModel(cwd), this.request("config/read", { cwd, includeLayers: false }),
    ]);
    return {
      type: "models",
      models: catalog.status === "fulfilled" ? catalog.value : [],
      defaultModel: defaults.status === "fulfilled" ? defaults.value : null,
      defaultReasoningEffort: config.status === "fulfilled" ? config.value?.config?.model_reasoning_effort || null : null,
      error: [catalog, defaults].filter((r) => r.status === "rejected").map((r) => r.reason.message).join("; ") || null,
    };
  }
}
