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

// Only update the model field; never copy runtime credentials or overrides to disk.
export function persistModel(file, model) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...config, model }, null, 2), { mode: 0o600 });
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
  }

  select(value) {
    const model = normalizeModel(value);
    this.save(model);
    this.config.model = model;
    return model;
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
          models.set(m.model, { model: m.model, displayName: m.displayName || m.model, description: m.description || "", isDefault: !!m.isDefault });
        }
      }
      cursor = res?.nextCursor || null;
      if (cursor && cursors.has(cursor)) throw new Error("Invalid model list cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
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

  async list(cwd) {
    const [catalog, defaults] = await Promise.allSettled([this.catalog(), this.defaultModel(cwd)]);
    return {
      type: "models",
      models: catalog.status === "fulfilled" ? catalog.value : [],
      defaultModel: defaults.status === "fulfilled" ? defaults.value : null,
      error: [catalog, defaults].filter((r) => r.status === "rejected").map((r) => r.reason.message).join("; ") || null,
    };
  }
}
