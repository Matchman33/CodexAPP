"use strict";

window.FileDownloads = class FileDownloads {
  constructor(send) { this.send = send; this.active = null; this.supported = false; this.maxBytes = 32 * 1048576; this.chunkBytes = 192 * 1024; this.previewUrl = null; }
  configure(capability) { this.supported = !!capability?.supported; }
  render(row, event) {
    row.querySelector(".file-attachments")?.remove();
    if (!this.supported) return;
    const files = event.files || [];
    const list = document.createElement("div"); list.className = "file-attachments"; list.setAttribute("aria-label", "生成的文件");
    for (const file of files.slice(0, 12)) {
      const card = document.createElement("div"); card.className = "file-attachment";
      const icon = document.createElement("i"); icon.dataset.lucide = file.preview ? "image" : /\.(xlsx?|csv|ods)$/i.test(file.name) ? "file-spreadsheet" : "file";
      const description = document.createElement("div"); description.className = "file-description";
      const name = document.createElement("strong"); name.textContent = file.name; name.title = file.name;
      const size = document.createElement("span"); size.textContent = FileDownloads.size(file.size);
      description.append(name, size); card.append(icon, description);
      if (file.preview) card.append(this.button("eye", "预览图片：" + file.name, () => this.start(file, true)));
      card.append(this.button("download", "下载文件：" + file.name, () => this.start(file, false)));
      list.append(card);
    }
    if (files.length) { row.append(list); window.ChatUI.icons(list); }
    for (const link of row.querySelectorAll(".body a")) {
      const reference = link.getAttribute("href");
      const file = files.find(file => file.reference === reference);
      if (file) { link.removeAttribute("target"); link.onclick = e => { e.preventDefault(); this.start(file, !!file.preview); }; }
      else if (reference && !reference.startsWith("#") && (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) || /^(?:file:|sandbox:|[a-z]:[\\/])/i.test(reference))) {
        link.removeAttribute("target");
        link.onclick = e => { e.preventDefault(); if (this.active) return; $("downloadBar").classList.remove("hidden"); this.cancel("该文件未开放下载、超过大小限制或已不存在"); };
      }
    }
  }
  button(icon, title, action) {
    const button = document.createElement("button"); button.type = "button"; button.className = "icon-btn"; button.title = title; button.setAttribute("aria-label", title);
    button.innerHTML = '<i data-lucide="' + icon + '"></i>'; button.onclick = action; return button;
  }
  static size(bytes) { return bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB"; }
  async start(file, preview) {
    if (this.active) { $("downloadStatus").textContent = "已有文件正在接收，请等待或取消"; return; }
    if (!this.supported || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxBytes) return;
    this.active = { file, preview, chunks: [], offset: 0, requestId: null, timer: null };
    $("downloadBar").classList.remove("hidden"); $("cancelDownload").classList.remove("hidden");
    this.next();
  }
  next() {
    const task = this.active; if (!task) return;
    task.requestId = "file-" + newClientId();
    $("downloadStatus").textContent = task.file.name + " · " + FileDownloads.size(task.offset) + " / " + FileDownloads.size(task.file.size);
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
      if (expected !== null) { this.next(); return; }
      this.active = null; $("cancelDownload").classList.add("hidden");
      const blob = new Blob(task.chunks, { type: task.file.mime || "application/octet-stream" });
      if (task.preview && /^image\/(png|jpeg|webp|gif)$/.test(blob.type)) {
        this.clearPreview(); this.previewUrl = URL.createObjectURL(blob);
        window.ImageAttachments.open(this.previewUrl, task.file.name);
        $("downloadStatus").textContent = "已接收图片：" + task.file.name;
      } else {
        const url = URL.createObjectURL(blob), link = document.createElement("a");
        link.href = url; link.download = task.file.name; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        $("downloadStatus").textContent = "已接收并提交下载：" + task.file.name;
      }
    } catch (error) { this.cancel(error.message || "文件接收失败"); }
  }
  error(message) {
    if (!message.requestId?.startsWith("file-")) return false;
    if (message.requestId === this.active?.requestId) this.cancel(message.message);
    return true;
  }
  cancel(message = "已取消下载") {
    if (this.active) clearTimeout(this.active.timer);
    this.active = null; $("downloadStatus").textContent = message; $("cancelDownload").classList.add("hidden");
  }
  disconnect() { if (this.active) this.cancel("连接已断开，请重新下载"); }
  clearPreview() { if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
};
