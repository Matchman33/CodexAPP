import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { fileURLToPath } from "node:url";

const configPath = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");

export function catalogConfig(effective = {}, file = configPath()) {
  if (!effective.model_provider && !fs.existsSync(file)) return effective;
  let saved = {};
  try { saved = parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("无法读取模型目录配置，请检查 config.toml"); }
  const profile = saved.profiles?.[saved.profile || effective.profile] || {};
  const name = profile.model_provider || saved.model_provider || effective.model_provider;
  return { ...effective, model_provider: name,
    model_catalog_json: profile.model_catalog_json ?? saved.model_catalog_json ?? effective.model_catalog_json,
    model_catalog_url: profile.model_catalog_url ?? saved.model_catalog_url ?? effective.model_catalog_url,
    model_providers: { ...effective.model_providers, [name]: {
      ...effective.model_providers?.[name], ...saved.model_providers?.[name], ...profile.model_providers?.[name],
    } },
  };
}

export function catalogSource(config) {
  const provider = config.model_providers?.[config.model_provider] || {};
  return config.model_catalog_json || provider.model_catalog_json || provider.model_catalog_url || config.model_catalog_url || null;
}

export async function readCatalog(config, options = {}) {
  const source = catalogSource(config);
  if (typeof source !== "string" || !source.trim()) throw new Error("无效的模型目录来源");
  if (/^https?:\/\//i.test(source)) return fetchRemoteCatalog(config, source, options);
  let file = source;
  try {
    if (/^file:\/\//i.test(file)) file = fileURLToPath(file);
    if (/^~[\\/]/.test(file)) file = path.join(os.homedir(), file.slice(2));
    file = path.resolve(path.dirname(options.configFile || configPath()), file);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 4 * 1048576) throw new Error("目录须为不超过 4 MiB 的 JSON 文件");
    const content = await fs.promises.readFile(file, "utf8");
    if (Buffer.byteLength(content) > 4 * 1048576) throw new Error("目录超过 4 MiB");
    return parseCatalog(content, "本地模型目录");
  } catch (error) {
    throw new Error("本地模型目录读取失败：" + (error.code || error.message));
  }
}

async function fetchRemoteCatalog(config, source, { fetch: fetcher = fetch, authFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json") } = {}) {
  const provider = config.model_providers?.[config.model_provider] || {};
  const url = new URL(source);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("模型目录必须使用 HTTP/HTTPS URL，不能包含登录凭据");
  const headers = { accept: "application/json", "cache-control": "no-cache" };
  // 用户可配置独立公共目录；不能把模型服务的密钥转发给另一个域名。
  if (provider.base_url && new URL(provider.base_url).origin === url.origin) {
    Object.assign(headers, provider.http_headers || {});
    for (const [name, key] of Object.entries(provider.env_http_headers || {})) if (process.env[key]) headers[name] = process.env[key];
    let token = provider.experimental_bearer_token || (provider.env_key && process.env[provider.env_key]);
    if (!token && provider.requires_openai_auth) {
      token = process.env.OPENAI_API_KEY;
      if (!token) {
        try { token = JSON.parse(fs.readFileSync(authFile, "utf8")).OPENAI_API_KEY; }
        catch (error) { if (error.code !== "ENOENT") throw new Error("无法读取模型目录使用的本机 API Key"); }
      }
    }
    if (token) headers.authorization = "Bearer " + token;
  }
  let response;
  try { response = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(6000), cache: "no-store" }); }
  catch { throw new Error("远程模型目录连接失败或超时（不接受重定向），请检查网络和目录地址"); }
  if (!response.ok) throw new Error(`远程模型目录 HTTP ${response.status}`);
  let size = 0, chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1048576) throw new Error("远程模型目录超过 4 MiB");
    chunks.push(chunk);
  }
  return parseCatalog(Buffer.concat(chunks).toString("utf8"), "远程模型目录");
}

function parseCatalog(content, label) {
  let data;
  try { data = JSON.parse(content.replace(/^\uFEFF/, "")); } catch { throw new Error(`${label}不是有效 JSON`); }
  const entries = Array.isArray(data) ? data : data?.models || data?.data;
  if (!Array.isArray(entries)) throw new Error(`${label}需要 data 或 models 数组`);
  const models = new Map();
  for (const raw of entries.slice(0, 10000)) {
    const m = typeof raw === "string" ? { id: raw } : raw;
    const id = m?.model || m?.slug || m?.id;
    if (typeof id !== "string" || !id || id.length > 200 || /\s|[\x00-\x1f\x7f]/.test(id) || m.hidden || ["hidden", "hide", "none"].includes(m.visibility)) continue;
    const efforts = m.supportedReasoningEfforts ?? m.supported_reasoning_levels;
    models.set(id, { model: id, displayName: m.displayName || m.display_name || id,
      description: m.description || "", isDefault: !!(m.isDefault || m.is_default),
      supportedReasoningEfforts: Array.isArray(efforts) ? efforts.map(e => ({ reasoningEffort: e.reasoningEffort || e.effort, description: e.description || "" })).filter(e => typeof e.reasoningEffort === "string") : null,
      defaultReasoningEffort: m.defaultReasoningEffort || m.default_reasoning_level || null });
  }
  if (!models.size) throw new Error(`${label}没有可选模型`);
  return [...models.values()];
}
