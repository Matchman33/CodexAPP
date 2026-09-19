import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

export const FILE_LIMITS = { maxBytes: 32 * 1024 * 1024, chunkBytes: 192 * 1024, perEvent: 12, entries: 512 };
const imageTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const documentTypes = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".csv": "text/csv", ".zip": "application/zip" };
const extensions = new Set("png jpg jpeg webp gif bmp svg pdf xlsx xls csv ods docx doc odt pptx ppt odp zip 7z tar gz txt md json html css js mjs ts py c cpp h mp3 wav mp4 webm".split(" ").map(ext => "." + ext));
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative); };
const privatePath = relative => relative.split(/[\\/]/).some(part => part.startsWith(".") || ["node_modules", "codexapp.config.json", "agent.config.json", "auth.json", "credentials.json", "secrets.json"].includes(part.toLowerCase()));
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

export function fileReferences(text) {
  const refs = [];
  // 使用现有 Markdown 解析器，支持带空格的 <路径> 和链接标题。
  try {
    marked.walkTokens(marked.lexer(String(text || "").slice(0, 262144)), token => {
      if (refs.length >= FILE_LIMITS.perEvent) return;
      const value = ["link", "image"].includes(token.type) ? token.href : token.type === "codespan" ? token.text : null;
      if (typeof value === "string" && value.length <= 4096 && !/^(https?:|data:|javascript:)/i.test(value)) {
        try { if (extensions.has(path.extname(decodeURIComponent(value)).toLowerCase())) refs.push(value); } catch {}
      }
    });
  } catch {}
  return [...new Set(refs)];
}

export class FileAttachments {
  constructor() { this.entries = new Map(); this.keys = new Map(); this.roots = new Map(); this.reading = 0; }
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
    for (const [id, entry] of this.entries) if (entry.threadId === threadId) { this.entries.delete(id); this.keys.delete(entry.key); }
  }
  register(reference, threadId) {
    const scope = this.roots.get(threadId), root = scope?.root;
    if (!root || typeof reference !== "string" || reference.length > 4096) return null;
    try {
      let target = reference;
      if (target.startsWith("file:")) target = fileURLToPath(target);
      else {
        if (target.startsWith("sandbox:")) target = target.slice(8);
        else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null;
        target = decodeURIComponent(target);
      }
      if (/[\x00-\x1f\x7f]/.test(target) || /^[/\\]{2}/.test(target) || target.replace(/^[a-z]:/i, "").includes(":")) return null;
      const file = path.resolve(scope.cwd, target);
      const lexicalRoot = inside(scope.cwd, file) ? scope.cwd : root;
      if (!inside(lexicalRoot, file) || privatePath(path.relative(lexicalRoot, file))) return null;
      const real = fs.realpathSync(file);
      if (!inside(root, real) || privatePath(path.relative(root, real))) return null;
      const ext = path.extname(real).toLowerCase();
      if (!extensions.has(ext)) return null;
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > FILE_LIMITS.maxBytes) return null;
      const stamp = fingerprint(stat), key = JSON.stringify([threadId, file, real, stamp]);
      const known = this.entries.get(this.keys.get(key));
      if (known) return { ...known.public, reference };
      const id = crypto.randomBytes(24).toString("base64url");
      const metadata = { id, threadId, name: path.basename(real), size: stat.size, mime: imageTypes[ext] || documentTypes[ext] || "application/octet-stream", preview: !!imageTypes[ext] };
      this.entries.set(id, { key, file, real, root, stamp, threadId, public: metadata }); this.keys.set(key, id);
      while (this.entries.size > FILE_LIMITS.entries) { const oldest = this.entries.keys().next().value; this.keys.delete(this.entries.get(oldest).key); this.entries.delete(oldest); }
      return { ...metadata, reference };
    } catch { return null; }
  }
  decorateEvent(event, state) {
    if (event.live || !["item:agentMessage", "item:fileChange", "item:imageGeneration"].includes(event.kind)) return event;
    const threadId = event.threadId || state.threadId;
    const refs = event.fileRefs?.length ? event.fileRefs : event.kind === "item:agentMessage" ? fileReferences(event.text) : [];
    const files = [], seen = new Set();
    for (const ref of refs.slice(0, FILE_LIMITS.perEvent)) {
      const file = this.register(ref, threadId);
      if (file && !seen.has(file.id)) { files.push(file); seen.add(file.id); }
    }
    return files.length ? { ...event, files } : event;
  }
  decorate(message, state) {
    if (!["hello", "event", "historyPage", "threadDeleted"].includes(message.type)) return message;
    this.remember(state.threadId, state.cwd);
    if (message.type === "threadDeleted") this.forget(message.threadId);
    if (message.type === "hello") return { ...message, fileDownloads: { supported: true, ...FILE_LIMITS }, recentEvents: (message.recentEvents || []).map(event => this.decorateEvent(event, state)) };
    if (message.type === "event") return { ...message, event: this.decorateEvent(message.event, state) };
    if (message.type === "historyPage") return { ...message, events: (message.events || []).map(event => this.decorateEvent(event, state)) };
    return message;
  }
  async read({ attachmentId, threadId, offset = 0, requestId }) {
    const entry = this.entries.get(attachmentId);
    if (!entry || entry.threadId !== threadId) throw new Error("附件未登记或已失效，请重新打开会话");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.public.size || offset % FILE_LIMITS.chunkBytes !== 0) throw new Error("附件读取位置无效");
    if (this.reading >= 4) throw new Error("附件读取繁忙，请稍后重试");
    this.reading++;
    let handle;
    try {
      const real = await fsp.realpath(entry.file);
      if (real !== entry.real || !inside(entry.root, real)) throw new Error("文件路径已变化，请重新打开会话");
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
