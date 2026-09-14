"use strict";

// 原图只随发送请求传输；聊天、队列和历史使用有界缩略图。
window.ImageAttachments = class ImageAttachments {
  constructor(onChange) { this.items = []; this.busy = false; this.locked = false; this.onChange = onChange; }
  static safePreview(url) { return typeof url === "string" && url.length <= 12000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url); }
  static open(url, name) {
    const dialog = document.getElementById("imageDialog");
    const image = dialog.querySelector("img"); image.src = url; image.alt = name || "图片";
    if (!dialog.open) dialog.showModal();
  }
  static gallery(container, images) {
    container.replaceChildren();
    for (const image of (images || []).slice(0, 4)) {
      if (!this.safePreview(image.url)) {
        const label = document.createElement("span"); label.className = "image-placeholder"; label.textContent = "图片 · " + (image.name || "附件"); container.append(label); continue;
      }
      const button = document.createElement("button"); button.type = "button"; button.className = "photo-preview"; button.title = "预览图片"; button.setAttribute("aria-label", "预览图片：" + (image.name || "附件"));
      const photo = document.createElement("img"); photo.src = image.url; photo.alt = image.name || "图片"; photo.loading = "lazy"; photo.decoding = "async";
      button.append(photo); button.onclick = () => this.open(image.url, image.name); container.append(button);
    }
  }
  render() {
    const container = document.getElementById("imageDrafts"); container.replaceChildren(); container.classList.toggle("hidden", !this.items.length);
    for (const item of this.items) {
      const wrapper = document.createElement("div"); wrapper.className = "image-draft";
      const button = document.createElement("button"); button.type = "button"; button.className = "photo-preview"; button.title = "预览图片";
      const image = document.createElement("img"); image.src = item.previewDataUrl; image.alt = item.name; button.append(image); button.onclick = () => ImageAttachments.open(item.dataUrl, item.name);
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "icon-btn image-remove"; remove.title = "移除图片"; remove.setAttribute("aria-label", "移除图片：" + item.name); remove.innerHTML = '<i data-lucide="x"></i>'; remove.disabled = this.locked || this.busy;
      remove.onclick = () => { this.items = this.items.filter(image => image.id !== item.id); this.render(); this.onChange(); };
      wrapper.append(button, remove); container.append(wrapper);
    }
    window.ChatUI.icons(container);
  }
  take() { return this.items.map(({ id, ...image }) => ({ ...image })); }
  clear(ids) { this.items = this.items.filter(item => !ids.includes(item.id)); this.render(); }
  async add(files) {
    if (this.locked || this.busy) return;
    files = Array.from(files); if (!files.length) return;
    if (this.items.length + files.length > 4) throw new Error("每条消息最多添加 4 张图片");
    this.busy = true; this.render(); this.onChange();
    try {
      const added = [];
      for (const file of files) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG、WebP 图片");
        if (!file.size || file.size > 20 * 1048576) throw new Error("原始图片不能超过 20 MiB");
        const url = URL.createObjectURL(file);
        try {
          const image = new Image(); image.src = url; await image.decode();
          if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 32000000) throw new Error("图片像素过大，请先缩小图片");
          const read = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("读取图片失败")); reader.readAsDataURL(blob); });
          const encode = (side, bytes) => {
            const canvas = document.createElement("canvas");
            for (let i = 0; i < 12; i++) {
              const scale = Math.min(1, side * 0.8 ** i / Math.max(image.naturalWidth, image.naturalHeight));
              canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
              const context = canvas.getContext("2d"); if (!context) throw new Error("无法处理图片");
              context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
              const data = canvas.toDataURL("image/jpeg", 0.8);
              if ((data.length - data.indexOf(",") - 1) * 3 / 4 <= bytes) return data;
            }
            throw new Error("图片压缩失败，请选择较小图片");
          };
          added.push({ id: newClientId(), name: file.name || "图片", dataUrl: file.size <= 1048576 ? await read(file) : encode(1600, 1048576), previewDataUrl: encode(240, 8192) });
        } finally { URL.revokeObjectURL(url); }
      }
      this.items.push(...added); this.render();
    } catch (error) { throw new Error(error.message || "图片无法读取"); }
    finally { this.busy = false; this.render(); this.onChange(); }
  }
};
