// 新消息的文字兜底不转发凭据、二进制正文或无限增长的对象。
export function messageSummary(value) {
  const seen = new WeakSet();
  function clean(v, depth = 0, key = "") {
    if (/^(?:data|blob|imageurl|audiourl|authorization|token|accesstoken|refreshtoken|password|secret|clientsecret|apikey|meta)$/i.test(key.replace(/[_-]/g, ""))) return "[内容已省略]";
    if (typeof v === "string") return /^data:|^[A-Za-z0-9+/=]{1024,}$/.test(v) ? "[二进制内容已省略]" : v.slice(0, 2048);
    if (v == null || typeof v !== "object") return v;
    if (depth >= 4 || seen.has(v)) return "[内容已省略]";
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 16).map(x => clean(x, depth + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 24).map(([k, x]) => [k, clean(x, depth + 1, k)]));
  }
  try { return JSON.stringify(clean(value), null, 2).slice(0, 8000); } catch { return "内容暂无法解析"; }
}

export function toolImageSources(item) {
  const images = [];
  for (const c of [...(Array.isArray(item.result?.content) ? item.result.content.slice(0, 48) : []), ...(Array.isArray(item.contentItems) ? item.contentItems.slice(0, 48) : [])].slice(0, 48)) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "image" && typeof c.data === "string") images.push({ data: c.data, mime: c.mimeType });
    if (c.type === "resource" && typeof c.resource?.blob === "string" && /^image\//.test(c.resource.mimeType || "")) images.push({ data: c.resource.blob, mime: c.resource.mimeType });
    if (c.type === "inputImage" && typeof c.imageUrl === "string" && c.imageUrl.startsWith("data:")) images.push({ url: c.imageUrl });
    if (images.length >= 12) break;
  }
  if (item.type === "imageGeneration" && !item.savedPath && typeof item.result === "string") {
    images.push(item.result.startsWith("data:") ? { url: item.result } : { data: item.result });
  }
  return images;
}
