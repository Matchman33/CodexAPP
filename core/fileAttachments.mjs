import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { localFileTarget, markdownPathReference, markdownLinkReference } from "./linkTargets.mjs";

export const FILE_LIMITS = { maxBytes: 32 * 1024 * 1024, chunkBytes: 192 * 1024, perEvent: 12, entries: 512 };
const inlineLimit = 8 * 1024 * 1024, inlineBudget = 64 * 1024 * 1024;
const imageTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const documentTypes = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".csv": "text/csv", ".zip": "application/zip" };
const extensions = new Set("png jpg jpeg webp gif bmp svg pdf xlsx xls csv ods docx doc odt pptx ppt odp zip 7z tar gz txt md json html css js mjs ts py c cpp h mp3 wav mp4 webm".split(" ").map(ext => "." + ext));
const privatePath = (relative, allowSmoke = false) => relative.split(/[\\/]/).some(part => (part.startsWith(".") && !(allowSmoke && part.toLowerCase() === ".smoke")) || ["node_modules", "codexapp.config.json", "agent.config.json", "auth.json", "credentials.json", "secrets.json"].includes(part.toLowerCase()));
const privateFile = file => privatePath(path.relative(path.parse(file).root, file));
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const proseImagePath = /((?:(?<![a-z\d/\\])\/?[a-z]:[\\/][^\r\n`<>"|?*]{0,4096}?|(?<![\p{L}\p{N}:/\\])(?:(?:file:\/\/\/|sandbox:\/|\/|\.{1,2}[\\/]|[\p{L}\p{N}_.-]+[\\/])[^\r\n`<>"|?*]{0,4096}?|[\p{L}\p{N}_.-]{1,4096}))\.(?:png|jpe?g|webp|gif))(?=$|[\s，。；：、!?"'<>()[\]{},.;:])/giu;

function proseImageReferences(tokens) {
  const refs = [];
  let text = "";
  const flush = () => {
    for (const match of text.matchAll(proseImagePath)) {
      if (refs.length >= FILE_LIMITS.perEvent) break;
      refs.push(match[1]);
    }
    text = "";
  };
  // 拼回普通文字与 Markdown 转义，保持 Windows 路径；不扫描链接标签和代码块。
  for (const token of tokens) {
    if ((token.type === "text" && !token.tokens) || token.type === "escape") text += token.raw ?? token.text;
    else flush();
  }
  flush();
  return refs;
}

export function fileReferences(text) {
  const refs = [];
  const labels = new WeakSet();
  // 使用现有 Markdown 解析器，支持带空格的 <路径> 和链接标题。
  try {
    marked.walkTokens(marked.lexer(String(text || "").slice(0, 262144)), token => {
      if (refs.length >= FILE_LIMITS.perEvent || labels.has(token)) return;
      const standalone = token.type === "paragraph" ? markdownPathReference(token.text) : null;
      if (!standalone && ["paragraph", "text", "strong", "em", "del"].includes(token.type) && token.tokens) {
        refs.push(...proseImageReferences(token.tokens).slice(0, FILE_LIMITS.perEvent - refs.length));
        // 普通文字已按原始片段拼回并扫描，不再把转义后的路径尾部当作另一个文件。
        for (const child of token.tokens) if (child.type === "text" && !child.tokens && /\.(?:png|jpe?g|webp|gif)\s*$/i.test(child.raw ?? child.text)) labels.add(child);
      }
      if (["link", "image"].includes(token.type) && token.tokens) marked.walkTokens(token.tokens, child => labels.add(child));
      if (standalone && token.tokens) marked.walkTokens(token.tokens, child => labels.add(child));
      const value = standalone || (["link", "image"].includes(token.type) ? markdownLinkReference(token) : token.type === "codespan" ? token.text : token.type === "text" && !token.tokens ? markdownPathReference(token.raw ?? token.text) : null);
      const target = localFileTarget(value);
      if (typeof value === "string" && value.length <= 4096 && target !== null) {
        try { if (extensions.has(path.extname(decodeURIComponent(target)).toLowerCase())) refs.push(value); } catch {}
      }
    });
  } catch {}
  return [...new Set(refs)];
}

export class FileAttachments {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } = {}) {
    this.entries = new Map(); this.keys = new Map(); this.roots = new Map(); this.reading = 0; this.inlineBytes = 0;
    this.generatedImages = path.resolve(codexHome, "generated_images");
  }
  readable(file, scope) {
    if (!privateFile(file)) return true;
    if (!imageTypes[path.extname(file).toLowerCase()]) return false;
    // 项目内的 .smoke 截图可转发，其他隐藏目录仍按原规则过滤。
    if (scope && !privatePath(path.relative(path.parse(file).root, file), true) && [scope.cwd, scope.root].some(root => {
      const relative = path.relative(root, file);
      return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
    })) return true;
    try {
      // 默认生成目录位于隐藏的 Codex 目录，只开放其非隐藏图片，不开放整个 CODEX_HOME。
      const roots = [this.generatedImages, fs.realpathSync(this.generatedImages)];
      return roots.some(root => {
        const relative = path.relative(root, file);
        return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) && !privatePath(relative);
      });
    } catch { return false; }
  }
  remember(threadId, cwd) {
    if (!threadId || !cwd) return;
    try {
      const root = fs.realpathSync(cwd);
      if (!fs.statSync(root).isDirectory()) return;
      this.roots.set(threadId, { root, cwd: path.resolve(cwd) });
      if (this.roots.size > 128) this.forget(this.roots.keys().next().value);
    } catch {}
  }
  forget(threadId) {
    this.roots.delete(threadId);
    for (const [id, entry] of this.entries) if (entry.threadId === threadId) this.remove(id, entry);
  }
  remove(id, entry = this.entries.get(id)) {
    if (!entry) return;
    this.inlineBytes -= entry.bytes?.length || 0;
    this.entries.delete(id); this.keys.delete(entry.key);
  }
  trim() {
    while (this.entries.size > FILE_LIMITS.entries || this.inlineBytes > inlineBudget) this.remove(this.entries.keys().next().value);
  }
  registerInline(source, threadId, index) {
    if (!this.roots.has(threadId)) return null;
    let data = source.data, claimed = source.mime;
    if (source.url) {
      if (source.url.length > inlineLimit * 4 / 3 + 128) return null;
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(source.url);
      if (!match) return null;
      [, claimed, data] = match;
    }
    if (typeof data !== "string" || !data.length || data.length > Math.ceil(inlineLimit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > inlineLimit || bytes.toString("base64") !== data) return null;
    let ext;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = ".png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ext = ".jpg";
    else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) ext = ".gif";
    else if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") ext = ".webp";
    if (!ext || (claimed && claimed !== imageTypes[ext])) return null;
    const key = JSON.stringify([threadId, "inline", crypto.createHash("sha256").update(bytes).digest("hex")]);
    const known = this.entries.get(this.keys.get(key));
    if (known) return { ...known.public };
    const id = crypto.randomBytes(24).toString("base64url");
    const metadata = { id, threadId, name: "工具图片-" + (index + 1) + ext, size: bytes.length, mime: imageTypes[ext], preview: true };
    this.entries.set(id, { key, bytes, threadId, public: metadata }); this.keys.set(key, id); this.inlineBytes += bytes.length;
    this.trim();
    return { ...metadata };
  }
  register(reference, threadId) {
    const scope = this.roots.get(threadId);
    if (!scope || typeof reference !== "string" || reference.length > 4096) return null;
    try {
      let target = localFileTarget(reference);
      if (target === null) return null;
      if (/^file:/i.test(target)) target = fileURLToPath(target);
      else {
        if (/^sandbox:/i.test(target)) target = target.slice(8);
        else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null;
        target = decodeURIComponent(target);
      }
      if (/[\x00-\x1f\x7f]/.test(target) || /^[/\\]{2}/.test(target) || target.replace(/^[a-z]:/i, "").includes(":")) return null;
      const file = path.resolve(scope.cwd, target);
      const real = fs.realpathSync(file);
      if (!this.readable(file, scope) || !this.readable(real, scope)) return null;
      const ext = path.extname(real).toLowerCase();
      if (!extensions.has(ext)) return null;
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > FILE_LIMITS.maxBytes) return null;
      const stamp = fingerprint(stat), key = JSON.stringify([threadId, file, real, stamp]);
      const known = this.entries.get(this.keys.get(key));
      if (known) return { ...known.public, reference };
      const id = crypto.randomBytes(24).toString("base64url");
      const metadata = { id, threadId, name: path.basename(real), size: stat.size, mime: imageTypes[ext] || documentTypes[ext] || "application/octet-stream", preview: !!imageTypes[ext] };
      this.entries.set(id, { key, file, real, stamp, threadId, public: metadata }); this.keys.set(key, id);
      this.trim();
      return { ...metadata, reference };
    } catch { return null; }
  }
  decorateEvent(event, state) {
    const threadId = event.threadId || state.threadId;
    const { toolImages, ...clean } = event;
    this.remember(threadId, state.cwd);
    if (toolImages?.length) {
      const files = toolImages.slice(0, FILE_LIMITS.perEvent).map((source, i) => this.registerInline(source, threadId, i)).filter(Boolean);
      event = files.length ? { ...clean, files: [...new Map(files.map(file => [file.id, file])).values()] } : clean;
    }
    if (event.live || !["item:agentMessage", "item:fileChange", "item:imageGeneration", "item:imageView"].includes(event.kind)) return event;
    const refs = event.fileRefs?.length ? event.fileRefs : event.kind === "item:agentMessage" ? fileReferences(event.text) : [];
    const files = [], seen = new Set();
    for (const ref of refs.slice(0, FILE_LIMITS.perEvent)) {
      const file = this.register(ref, threadId);
      if (file && !seen.has(file.id)) { files.push({ ...file, references: [ref] }); seen.add(file.id); }
      else if (file) files.find(known => known.id === file.id).references.push(ref);
    }
    return files.length ? { ...event, files: [...new Map([...(event.files || []), ...files].map(file => [file.id, file])).values()].slice(0, FILE_LIMITS.perEvent) } : event;
  }
  decorate(message, state) {
    if (!["hello", "event", "historyPage", "historyUpdate", "threadDeleted"].includes(message.type)) return message;
    this.remember(state.threadId, state.cwd);
    if (message.type === "threadDeleted") this.forget(message.threadId);
    if (message.type === "hello") return { ...message, fileDownloads: { supported: true, ...FILE_LIMITS }, recentEvents: (message.recentEvents || []).map(event => this.decorateEvent(event, state)) };
    if (message.type === "event") return { ...message, event: this.decorateEvent(message.event, state) };
    if (["historyPage", "historyUpdate"].includes(message.type)) return { ...message, events: (message.events || []).map(event => this.decorateEvent(event, state)) };
    return message;
  }
  async read({ attachmentId, threadId, offset = 0, requestId }) {
    const entry = this.entries.get(attachmentId);
    if (!entry || entry.threadId !== threadId) throw new Error("附件未登记或已失效，请重新打开会话");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.public.size || offset % FILE_LIMITS.chunkBytes !== 0) throw new Error("附件读取位置无效");
    if (entry.bytes) {
      const next = Math.min(offset + FILE_LIMITS.chunkBytes, entry.bytes.length);
      return { type: "attachmentChunk", requestId, attachmentId, threadId, offset, total: entry.bytes.length, data: entry.bytes.subarray(offset, next).toString("base64"), nextOffset: next < entry.bytes.length ? next : null };
    }
    if (this.reading >= 4) throw new Error("附件读取繁忙，请稍后重试");
    this.reading++;
    let handle;
    try {
      const real = await fsp.realpath(entry.file);
      const scope = this.roots.get(threadId);
      if (real !== entry.real || !this.readable(entry.file, scope) || !this.readable(real, scope)) throw new Error("文件路径已变化，请重新打开会话");
      handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || fingerprint(stat) !== entry.stamp || await fsp.realpath(entry.file) !== real) throw new Error("文件已变化，请重新打开会话");
      const buffer = Buffer.alloc(Math.min(FILE_LIMITS.chunkBytes, stat.size - offset));
      let received = 0;
      while (received < buffer.length) {
        const { bytesRead } = await handle.read(buffer, received, buffer.length - received, offset + received);
        if (!bytesRead) throw new Error("文件读取不完整，请重新下载");
        received += bytesRead;
      }
      if (fingerprint(await handle.stat()) !== entry.stamp) throw new Error("文件下载期间发生变化，请重试");
      return { type: "attachmentChunk", requestId, attachmentId, threadId, offset, total: stat.size, data: buffer.toString("base64"), nextOffset: offset + received < stat.size ? offset + received : null };
    } catch (error) {
      if (error.code) throw new Error("文件不存在或无法读取，请重新打开会话");
      throw error;
    } finally { try { if (handle) await handle.close(); } finally { this.reading--; } }
  }
}
