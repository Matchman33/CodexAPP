"use strict";

window.FileDownloads = class FileDownloads {
  constructor(send) {
    this.send = send; this.active = null; this.supported = false; this.maxBytes = 32 * 1048576; this.chunkBytes = 192 * 1024;
    this.textLimit = 1048576; this.previewUrl = null; this.cached = null; this.textPreview = null; this.messages = new Map();
    $("textPreviewClose").onclick = () => $("textPreviewDialog").close();
    $("textPreviewEncoding").onchange = () => this.renderText();
    $("textPreviewWrap").onchange = () => { $("textPreviewContent").classList.toggle("wrap-lines", $("textPreviewWrap").checked); $("textPreviewContent").scrollLeft = 0; };
    $("textPreviewDownload").onclick = () => { const preview = this.textPreview; if (preview) { $("textPreviewDialog").close(); this.start(preview.file, false); } };
    $("textPreviewDialog").addEventListener("close", () => { this.textPreview = null; $("textPreviewContent").textContent = ""; });
  }
  configure(capability) { this.supported = !!capability?.supported; }
  static previewKind(file) {
    if (file.preview && /^image\/(png|jpeg|webp|gif)$/.test(file.mime)) return "image";
    return /\.(txt|md|json|csv|html|css|js|mjs|ts|py|c|cpp|h|svg)$/i.test(file.name) ? "text" : null;
  }
  render(row, event) {
    row.querySelector(".file-attachments")?.remove();
    const files = this.supported ? event.files || [] : [];
    const list = document.createElement("div"); list.className = "file-attachments"; list.setAttribute("aria-label", event.kind === "item:fileChange" ? "变更文件附件" : "生成的文件");
    for (const file of files.slice(0, 12)) {
      const card = document.createElement("div"); card.className = "file-attachment";
      card.dataset.attachmentId = file.id;
      const icon = document.createElement("i"); icon.dataset.lucide = file.preview ? "image" : /\.(xlsx?|csv|ods)$/i.test(file.name) ? "file-spreadsheet" : "file";
      const description = document.createElement("div"); description.className = "file-description";
      const name = document.createElement("strong"); name.textContent = file.name; name.title = file.name;
      const size = document.createElement("span"); size.textContent = FileDownloads.size(file.size);
      const feedback = document.createElement("span"); feedback.className = "file-feedback hidden"; feedback.setAttribute("role", "status");
      description.append(name, size, feedback); card.append(icon, description);
      const kind = FileDownloads.previewKind(file);
      if (kind) card.append(this.button("eye", (kind === "text" ? "预览文本：" : "预览图片：") + file.name, () => this.start(file, true)));
      card.append(this.button("download", "下载文件：" + file.name, () => this.start(file, false)));
      const cancel = this.button("x", "取消接收：" + file.name, () => this.cancel()); cancel.dataset.fileCancel = "true"; card.append(cancel);
      this.updateCard(card);
      list.append(card);
    }
    if (files.length) {
      const container = event.kind === "item:fileChange" ? row.querySelector("details") || row : row;
      container.append(list); window.ChatUI.icons(list);
    }
    for (const link of row.querySelectorAll(".body a")) {
      const reference = link.getAttribute("href");
      const marker = /^#codex-(file|preview)-(\d+)$/.exec(reference || "");
      const file = marker ? files[Number(marker[2])] : files.find(file => file.reference === reference || file.references?.includes(reference));
      if (file) { link.removeAttribute("target"); link.onclick = e => { e.preventDefault(); this.start(file, marker?.[1] === "preview"); }; }
      else if (reference === "#codex-file-unavailable" || marker || (reference && !reference.startsWith("#") && (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) || /^(?:file:|sandbox:|[a-z]:[\\/])/i.test(reference)))) {
        link.removeAttribute("target");
        link.onclick = e => {
          e.preventDefault();
          let feedback = row.querySelector(".file-message");
          if (!feedback) { feedback = document.createElement("p"); feedback.className = "file-message"; feedback.setAttribute("role", "alert"); row.append(feedback); }
          feedback.textContent = this.supported ? "该文件未开放下载、超过大小限制或已不存在" : "当前中继尚未启用文件下载，请重启中继后刷新页面";
        };
      }
    }
  }
  button(icon, title, action) {
    const button = document.createElement("button"); button.type = "button"; button.className = "icon-btn"; button.title = title; button.setAttribute("aria-label", title);
    button.innerHTML = '<i data-lucide="' + icon + '"></i>'; button.onclick = action; return button;
  }
  static size(bytes) { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB"; }
  feedback(file, message = "") {
    if (message) this.messages.set(file.id, message); else this.messages.delete(file.id);
    while (this.messages.size > 128) this.messages.delete(this.messages.keys().next().value);
    for (const card of document.querySelectorAll(".file-attachment")) if (card.dataset.attachmentId === file.id) this.updateCard(card);
  }
  updateCard(card) {
    const id = card.dataset.attachmentId, busy = this.active?.file.id === id;
    const feedback = card.querySelector(".file-feedback"); feedback.textContent = this.messages.get(id) || ""; feedback.classList.toggle("hidden", !feedback.textContent);
    for (const button of card.querySelectorAll("button")) {
      if (button.dataset.fileCancel) button.classList.toggle("hidden", !busy);
      else button.disabled = busy;
    }
  }
  start(file, preview) {
    if (this.active) { this.feedback(file, "已有文件正在接收，请等待或取消"); return; }
    if (!this.supported || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxBytes) return;
    if (!preview && this.cached?.file.id === file.id) { this.download(this.cached); this.feedback(file); return; }
    this.clearCached();
    this.active = { file, preview: preview ? FileDownloads.previewKind(file) : null, chunks: [], offset: 0, requestId: null, timer: null };
    this.next();
  }
  next() {
    const task = this.active; if (!task) return;
    task.requestId = "file-" + newClientId();
    this.feedback(task.file, "接收中 · " + FileDownloads.size(task.offset) + " / " + FileDownloads.size(task.file.size));
    if (!this.send({ type: "readAttachment", attachmentId: task.file.id, threadId: task.file.threadId, offset: task.offset, requestId: task.requestId })) { this.cancel("连接已断开，请重新下载"); return; }
    task.timer = setTimeout(() => this.cancel("文件接收超时，请重新下载"), 20000);
  }
  receive(message) {
    const task = this.active;
    if (!task || message.requestId !== task.requestId) return;
    clearTimeout(task.timer);
    try {
      if (message.attachmentId !== task.file.id || message.threadId !== task.file.threadId || message.offset !== task.offset || message.total !== task.file.size || typeof message.data !== "string" || message.data.length > this.chunkBytes * 4 / 3 + 4) throw new Error("文件分块校验失败");
      const raw = atob(message.data), bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      if (bytes.length !== Math.min(this.chunkBytes, task.file.size - task.offset)) throw new Error("文件接收不完整");
      task.offset += bytes.length; task.chunks.push(bytes);
      const expected = task.offset < task.file.size ? task.offset : null;
      if (message.nextOffset !== expected) throw new Error("文件分块顺序异常");
      if (expected !== null && !(task.preview === "text" && task.offset >= this.textLimit)) { this.next(); return; }
      this.active = null; this.feedback(task.file);
      if (task.preview === "text") {
        const bytes = new Uint8Array(Math.min(task.offset, this.textLimit)); let offset = 0;
        for (const chunk of task.chunks) { const part = chunk.subarray(0, bytes.length - offset); bytes.set(part, offset); offset += part.length; if (offset >= bytes.length) break; }
        this.textPreview = { file: task.file, bytes, truncated: bytes.length < task.file.size };
        $("textPreviewTitle").textContent = task.file.name; $("textPreviewEncoding").value = "auto";
        $("textPreviewWrap").checked = false; $("textPreviewContent").classList.remove("wrap-lines");
        $("textPreviewContent").scrollLeft = 0; $("textPreviewContent").scrollTop = 0;
        this.renderText(); $("textPreviewDialog").showModal(); return;
      }
      const blob = new Blob(task.chunks, { type: task.file.mime || "application/octet-stream" });
      this.cached = { file: task.file, url: URL.createObjectURL(blob) };
      if (task.preview === "image") {
        this.clearPreview(); this.previewUrl = URL.createObjectURL(blob);
        window.ImageAttachments.open(this.previewUrl, task.file.name);
      } else this.download(this.cached);
    } catch (error) { this.active = null; this.feedback(task.file, error.message || "文件接收失败"); }
  }
  error(message) {
    if (!message.requestId?.startsWith("file-")) return false;
    if (message.requestId === this.active?.requestId) this.cancel(message.message);
    return true;
  }
  cancel(message = "已取消下载") {
    const task = this.active; if (!task) return;
    clearTimeout(task.timer); this.active = null; this.feedback(task.file, message);
  }
  disconnect() { if (this.active) this.cancel("连接已断开，请重新下载"); }
  download(cached) { const link = document.createElement("a"); link.href = cached.url; link.download = cached.file.name; document.body.append(link); link.click(); link.remove(); }
  clearCached() { if (this.cached) URL.revokeObjectURL(this.cached.url); this.cached = null; }
  renderText() {
    const preview = this.textPreview; if (!preview) return;
    const bytes = preview.bytes; let encoding = $("textPreviewEncoding").value;
    const decode = label => new TextDecoder(label, { fatal: true }).decode(bytes, { stream: preview.truncated });
    try {
      let text;
      if (encoding === "auto") {
        encoding = bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : "utf-8";
        try { text = decode(encoding); } catch { encoding = "gb18030"; text = decode(encoding); }
      } else text = decode(encoding);
      if (text.includes("\u0000")) throw new Error("binary content");
      $("textPreviewContent").textContent = text;
      $("textPreviewNote").textContent = (preview.truncated ? "仅预览前 1 MiB；下载可获取完整文件" : bytes.length ? FileDownloads.size(bytes.length) : "空文件") + " · " + encoding.toUpperCase();
    } catch {
      $("textPreviewContent").textContent = "";
      $("textPreviewNote").textContent = "无法按此编码预览，或内容不是文本；可更换编码或下载文件。";
    }
  }
  clearPreview() { if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
};
