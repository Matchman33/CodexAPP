"use strict";

window.FileDownloads = class FileDownloads {
  constructor(send) {
    this.send = send; this.active = null; this.supported = false; this.maxBytes = 32 * 1048576; this.chunkBytes = 192 * 1024;
    this.textLimit = 1048576; this.previewUrl = null; this.cached = null; this.textPreview = null; this.messages = new Map();
    this.thumbnails = new Map(); this.thumbnailQueue = new Map();
    this.thumbnailObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.thumbnailObserver.unobserve(entry.target);
        const file = entry.target._file;
        if (!this.thumbnails.has(file.id) && !this.messages.has(file.id)) this.thumbnailQueue.set(file.id, file);
      }
      this.pumpThumbnails();
    });
    this.highlighter = new window.ChatUI.PreviewHighlighter();
    for (const language of window.ChatUI.previewLanguages) $("textPreviewLanguage").add(new Option(language.label, language.id));
    $("textPreviewLanguage").onchange = () => this.renderText();
    $("textPreviewClose").onclick = () => $("textPreviewDialog").close();
    $("textPreviewEncoding").onchange = () => this.renderText();
    $("textPreviewWrap").onchange = () => { $("textPreviewContent").classList.toggle("wrap-lines", $("textPreviewWrap").checked); $("textPreviewContent").scrollLeft = 0; this.locatePreview(); };
    $("textPreviewDownload").onclick = () => { const preview = this.textPreview; if (preview) { $("textPreviewDialog").close(); this.start(preview.file, false); } };
    $("textPreviewDialog").addEventListener("close", () => { this.highlighter.cancel(); this.textPreview = null; $("textPreviewContent").textContent = ""; });
  }
  configure(capability) { this.supported = !!capability?.supported; }
  static previewKind(file) {
    if (file.preview && /^image\/(png|jpeg|webp|gif)$/.test(file.mime)) return "image";
    return /\.(txt|md|json|csv|html|css|js|mjs|ts|py|c|cpp|h|svg)$/i.test(file.name) ? "text" : null;
  }
  render(row, event) {
    row.querySelectorAll(".file-image-preview").forEach(button => this.thumbnailObserver.unobserve(button));
    row.querySelector(".file-attachments")?.remove();
    row.querySelectorAll(".file-reference-copy").forEach(button => button.remove());
    const files = this.supported ? event.files || [] : [];
    const list = document.createElement("div"); list.className = "file-attachments"; list.setAttribute("aria-label", event.kind === "item:fileChange" ? "变更文件附件" : "生成的文件");
    const gallery = document.createElement("div"); gallery.className = "file-images";
    for (const file of files.slice(0, 12).filter(file => FileDownloads.previewKind(file) === "image")) {
      const button = document.createElement("button"); button.type = "button"; button.className = "photo-preview file-image-preview";
      button._file = file; button.dataset.attachmentId = file.id; button.setAttribute("aria-label", "放大图片：" + file.name);
      button.onclick = () => this.start(file, true);
      const cached = this.thumbnails.get(file.id);
      if (cached) this.showThumbnail(button, cached);
      else { button.textContent = "加载图片…"; this.thumbnailObserver.observe(button); }
      gallery.append(button);
    }
    if (gallery.children.length) list.append(gallery);
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
      card.append(this.pathCopyButton(file.reference || file.references?.[0] || file.name, "复制文件路径：" + file.name));
      const cancel = this.button("x", "取消接收：" + file.name, () => this.cancel()); cancel.dataset.fileCancel = "true"; card.append(cancel);
      this.updateCard(card);
      list.append(card);
    }
    if (files.length) {
      const container = event.kind === "item:fileChange" ? row.querySelector("details") || row : row;
      container.append(list); window.ChatUI.icons(list);
    }
    for (const link of row.querySelectorAll(".body a")) {
      const followingText = link.nextSibling?.nodeType === Node.TEXT_NODE ? link.nextSibling.textContent : "";
      if (link.dataset.codexReference) {
        const copy = this.pathCopyButton(link.dataset.codexReference); copy.classList.add("file-reference-copy"); link.after(copy);
      }
      const reference = link.getAttribute("href");
      const marker = /^#codex-(file|preview)-(\d+)$/.exec(reference || "");
      const file = marker ? files[Number(marker[2])] : files.find(file => file.reference === reference || file.references?.includes(reference));
      if (file) {
        const location = {};
        for (const key of ["line", "column", "endLine", "endColumn"]) {
          const value = Number(link.dataset["source" + key[0].toUpperCase() + key.slice(1)]);
          if (Number.isSafeInteger(value) && value > 0) location[key] = value;
        }
        const suffix = followingText.match(/^:\d+(?::\d+)?(?:-\d+(?::\d+)?)?(?=$|\s|[，。,.);])/u)?.[0];
        const target = location.line ? location : window.ChatUI.fileLinkLocation(reference) || (suffix ? window.ChatUI.fileLinkLocation(file.name + suffix) : null);
        link.removeAttribute("target"); link.onclick = e => { e.preventDefault(); this.start(file, true, target); };
      }
      else if (link.dataset.codexUnavailable === "true" || reference === "#codex-file-unavailable" || marker || window.ChatUI.localFileTarget(reference) !== null) {
        link.removeAttribute("href"); link.setAttribute("role", "button"); link.setAttribute("tabindex", "0");
        link.removeAttribute("target");
        link.onclick = e => {
          e.preventDefault();
          let feedback = row.querySelector(".file-message");
          if (!feedback) { feedback = document.createElement("p"); feedback.className = "file-message"; feedback.setAttribute("role", "alert"); row.append(feedback); }
          feedback.textContent = this.supported ? "该文件未开放下载、超过大小限制或已不存在" : "当前中继尚未启用文件下载，请重启中继后刷新页面";
        };
        link.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); link.click(); } };
      }
    }
  }
  button(icon, title, action) {
    const button = document.createElement("button"); button.type = "button"; button.className = "icon-btn"; button.title = title; button.setAttribute("aria-label", title);
    button.innerHTML = '<i data-lucide="' + icon + '"></i>'; button.onclick = action; return button;
  }
  showThumbnail(button, cached) {
    const image = document.createElement("img"); image.src = cached.url; image.alt = cached.file.name; image.decoding = "async";
    image.onerror = () => { button.textContent = "图片无法显示，点击预览"; };
    button.replaceChildren(image);
  }
  rememberThumbnail(file, blob) {
    if (this.thumbnails.has(file.id)) URL.revokeObjectURL(this.thumbnails.get(file.id).url);
    this.thumbnails.set(file.id, { file, url: URL.createObjectURL(blob) });
    let bytes = [...this.thumbnails.values()].reduce((sum, entry) => sum + entry.file.size, 0);
    while (this.thumbnails.size > 24 || bytes > 64 * 1048576) {
      const oldest = this.thumbnails.keys().next().value, entry = this.thumbnails.get(oldest);
      bytes -= entry.file.size; URL.revokeObjectURL(entry.url); this.thumbnails.delete(oldest);
    }
    const cached = this.thumbnails.get(file.id);
    if (cached) for (const button of document.querySelectorAll(".file-image-preview")) if (button.dataset.attachmentId === file.id) this.showThumbnail(button, cached);
  }
  pumpThumbnails() {
    if (!this.supported || this.active) return;
    for (const [id, file] of this.thumbnailQueue) {
      this.thumbnailQueue.delete(id);
      if (this.thumbnails.has(id) || ![...document.querySelectorAll(".file-image-preview")].some(button => button.dataset.attachmentId === id)) continue;
      this.start(file, "thumbnail"); break;
    }
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
      else button.disabled = button.dataset.fileCopy ? false : busy;
    }
  }
  start(file, preview, location = null) {
    const thumbnail = this.thumbnails.get(file.id);
    if (thumbnail && preview !== "thumbnail") {
      if (preview) window.ImageAttachments.open(thumbnail.url, file.name); else this.download(thumbnail);
      this.feedback(file); return;
    }
    if (this.active?.preview === "thumbnail" && preview !== "thumbnail") {
      if (this.active.file.id === file.id && preview) { this.active.preview = "image"; return; }
      this.thumbnailQueue.set(this.active.file.id, this.active.file);
      this.cancel("");
    }
    if (this.active) { this.feedback(file, "已有文件正在接收，请等待或取消"); return; }
    if (!this.supported || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > this.maxBytes) return;
    if (preview && !FileDownloads.previewKind(file)) { this.showTextPreview({ file, unsupported: true }); return; }
    if (!preview && this.cached?.file.id === file.id) { this.download(this.cached); this.feedback(file); return; }
    this.clearCached();
    this.active = { file, preview: preview === "thumbnail" ? "thumbnail" : preview ? FileDownloads.previewKind(file) : null, location: preview ? location : null, chunks: [], offset: 0, requestId: null, timer: null };
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
      queueMicrotask(() => this.pumpThumbnails());
      if (task.preview === "text") {
        const bytes = new Uint8Array(Math.min(task.offset, this.textLimit)); let offset = 0;
        for (const chunk of task.chunks) { const part = chunk.subarray(0, bytes.length - offset); bytes.set(part, offset); offset += part.length; if (offset >= bytes.length) break; }
        this.showTextPreview({ file: task.file, bytes, truncated: bytes.length < task.file.size, location: task.location }); return;
      }
      const blob = new Blob(task.chunks, { type: task.file.mime || "application/octet-stream" });
      if (task.preview === "thumbnail" || task.preview === "image") this.rememberThumbnail(task.file, blob);
      if (task.preview === "thumbnail") return;
      this.cached = { file: task.file, url: URL.createObjectURL(blob) };
      if (task.preview === "image") {
        this.clearPreview(); this.previewUrl = URL.createObjectURL(blob);
        window.ImageAttachments.open(this.previewUrl, task.file.name);
      } else this.download(this.cached);
    } catch (error) { this.active = null; this.feedback(task.file, error.message || "文件接收失败"); queueMicrotask(() => this.pumpThumbnails()); }
  }
  error(message) {
    if (!message.requestId?.startsWith("file-")) return false;
    if (message.requestId === this.active?.requestId) this.cancel(message.message);
    return true;
  }
  cancel(message = "已取消下载") {
    const task = this.active; if (!task) return;
    clearTimeout(task.timer); this.active = null; this.feedback(task.file, message);
    queueMicrotask(() => this.pumpThumbnails());
  }
  disconnect() {
    this.thumbnailQueue.clear(); this.thumbnailObserver.disconnect();
    if (this.active) this.cancel(this.active.preview === "thumbnail" ? "" : "连接已断开，请重新下载");
  }
  reset() {
    this.disconnect(); this.clearCached(); this.clearPreview();
    this.highlighter.cancel(); this.textPreview = null; this.supported = false; this.messages.clear();
    for (const cached of this.thumbnails.values()) URL.revokeObjectURL(cached.url);
    this.thumbnails.clear();
    for (const image of document.querySelectorAll(".file-image-preview img")) image.removeAttribute("src");
    $("textPreviewContent").textContent = "";
  }
  download(cached) { const link = document.createElement("a"); link.href = cached.url; link.download = cached.file.name; document.body.append(link); link.click(); link.remove(); }
  clearCached() { if (this.cached) URL.revokeObjectURL(this.cached.url); this.cached = null; }
  showTextPreview(preview) {
    this.textPreview = preview;
    $("textPreviewTitle").textContent = preview.file.name; $("textPreviewEncoding").value = "auto";
    $("textPreviewLanguage").value = "auto";
    $("textPreviewDialog").classList.toggle("preview-unavailable", !!preview.unsupported);
    const downloadLabel = preview.unsupported ? "下载文件" : "下载完整文本文件";
    $("textPreviewDownload").setAttribute("aria-label", downloadLabel); $("textPreviewDownload").title = downloadLabel;
    $("textPreviewWrap").checked = false; $("textPreviewContent").classList.remove("wrap-lines");
    $("textPreviewContent").scrollLeft = 0; $("textPreviewContent").scrollTop = 0;
    this.renderText();
    if (!$("textPreviewDialog").open) $("textPreviewDialog").showModal();
    $("textPreviewContent").scrollTop = 0; $("textPreviewContent").scrollLeft = 0;
    this.locatePreview();
  }
  pathCopyButton(reference, label = "复制路径：" + reference) {
    const button = this.button("copy", label, async () => {
      try {
        await window.ChatUI.copyText(reference);
        button.innerHTML = '<i data-lucide="check"></i>'; window.ChatUI.icons(button); button.title = "已复制路径";
        setTimeout(() => { button.innerHTML = '<i data-lucide="copy"></i>'; window.ChatUI.icons(button); button.title = label; }, 1800);
      } catch { button.title = "复制失败，请选择文字复制"; }
    });
    button.dataset.fileCopy = "true";
    return button;
  }
  locatePreview() {
    cancelAnimationFrame(this.locationFrame);
    const preview = this.textPreview;
    this.locationFrame = requestAnimationFrame(() => {
      if (preview !== this.textPreview || !$("textPreviewDialog").open) return;
      const container = $("textPreviewContent"), anchor = container.querySelector(".text-preview-anchor");
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect(), bounds = container.getBoundingClientRect();
      container.scrollTop = Math.max(0, container.scrollTop + rect.top - bounds.top - container.clientHeight / 3);
      container.scrollLeft = $("textPreviewWrap").checked ? 0 : Math.max(0, container.scrollLeft + rect.left - bounds.left - container.clientWidth / 3);
    });
  }
  renderText() {
    this.highlighter.cancel();
    const preview = this.textPreview; if (!preview) return;
    if (preview.unsupported) {
      $("textPreviewContent").textContent = "";
      $("textPreviewNote").textContent = FileDownloads.size(preview.file.size) + " · 此格式暂不支持在线预览，可点击下载按钮后在本地打开。";
      return;
    }
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
      const range = window.ChatUI.textLocation(text, preview.location);
      if (range?.found) {
        $("textPreviewContent").replaceChildren(window.ChatUI.previewFragment(text, null, range));
        $("textPreviewNote").textContent += " · 已定位第 " + range.line + (range.endLine > range.line ? "–" + range.endLine : "") + " 行";
        this.locatePreview();
      } else if (range) {
        $("textPreviewNote").textContent += preview.truncated ? " · 第 " + preview.location.line + " 行不在当前预览范围内，请下载完整文件" : " · 目标第 " + preview.location.line + " 行超出文件范围（共 " + range.totalLines + " 行）";
      }
      const selection = $("textPreviewLanguage").value;
      const language = selection === "auto" ? window.ChatUI.previewLanguageForFile(preview.file.name) : selection === "plain" ? null : selection;
      const note = $("textPreviewNote").textContent;
      if (language) {
        $("textPreviewNote").textContent = note + " · 正在着色…";
        this.highlighter.highlight(text, language, result => {
          if (this.textPreview !== preview) return;
          const content = $("textPreviewContent"), top = content.scrollTop, left = content.scrollLeft;
          let fallback = result.fallback;
          if (result.tree) {
            try { content.replaceChildren(window.ChatUI.previewFragment(text, result.tree, range)); }
            catch { fallback = "complex"; }
          }
          content.scrollTop = top; content.scrollLeft = left;
          const label = window.ChatUI.previewLanguages.find(item => item.id === language)?.label || "纯文本";
          $("textPreviewNote").textContent = note + " · " + (fallback ? fallback === "large" ? "内容较长，使用纯文本" : "高亮不可用，使用纯文本" : label);
        });
      }
    } catch {
      $("textPreviewContent").textContent = "";
      $("textPreviewNote").textContent = "无法按此编码预览，或内容不是文本；可更换编码或下载文件。";
    }
  }
  clearPreview() { if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
};
