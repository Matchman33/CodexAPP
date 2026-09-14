import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const IMAGE_LIMITS = { count: 4, bytes: 1048576, totalBytes: 4194304, previewBytes: 8192, queueChars: 24 * 1048576 };
const cacheDir = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codexapp-image-previews");
const identity = url => crypto.createHash("sha256").update(url).digest("hex");
function imageData(url, limit) {
  if (typeof url !== "string" || url.length > Math.ceil(limit / 3) * 4 + 64) throw new Error("图片超过大小限制");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match) throw new Error("图片必须是 PNG、JPEG 或 WebP 的 Base64 数据，不能使用路径或远程地址");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > limit || bytes.toString("base64") !== match[2]) throw new Error("图片数据无效或超过大小限制");
  const valid = match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new Error("图片内容与声明格式不一致");
  return bytes.length;
}
export function normalizeImages(images = []) {
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.count) throw new Error("每条消息最多添加 4 张图片");
  let total = 0;
  return images.map(image => {
    if (!image || typeof image !== "object") throw new Error("图片参数无效");
    total += imageData(image.dataUrl, IMAGE_LIMITS.bytes);
    if (total > IMAGE_LIMITS.totalBytes) throw new Error("每条消息图片总大小不能超过 4 MiB");
    if (image.previewDataUrl !== undefined) imageData(image.previewDataUrl, IMAGE_LIMITS.previewBytes);
    return { name: String(image.name || "图片").split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 128) || "图片", dataUrl: image.dataUrl, ...(image.previewDataUrl ? { previewDataUrl: image.previewDataUrl } : {}) };
  });
}
export function buildUserInput(text, images) {
  const normalized = normalizeImages(images);
  if (!text && !normalized.length) throw new Error("消息不能为空");
  return [...(text ? [{ type: "text", text, text_elements: [] }] : []), ...normalized.map(image => ({ type: "image", url: image.dataUrl }))];
}
export function imageEcho(images, persist = false) {
  return (images || []).map(image => {
    const result = { id: identity(image.dataUrl), name: image.name, ...(image.previewDataUrl ? { url: image.previewDataUrl } : {}) };
    if (persist && result.url) {
      try { fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(cacheDir(), result.id + ".json"), JSON.stringify(result), { mode: 0o600 }); } catch {}
    }
    return result;
  });
}
export function historyImages(content) {
  return (content || []).filter(c => c.type === "image" || c.type === "localImage").slice(0, IMAGE_LIMITS.count).map(c => {
    const id = identity(String(c.url || c.path || ""));
    if (c.type === "image" && typeof c.url === "string" && c.url.startsWith("data:image/")) {
      try {
        const file = path.join(cacheDir(), id + ".json");
        if (fs.statSync(file).size > 16000) throw new Error("preview too large");
        const cached = JSON.parse(fs.readFileSync(file, "utf8"));
        imageData(cached.url, IMAGE_LIMITS.previewBytes);
        return { id, name: String(cached.name || "图片").slice(0, 128), url: cached.url };
      } catch {}
    }
    return { id, name: c.type === "localImage" ? String(c.path || "图片").split(/[\\/]/).at(-1).slice(0, 128) : "图片" };
  });
}
export const imageChars = event => (event.images || []).reduce((n, image) => n + (image.url || "").length, 0);
