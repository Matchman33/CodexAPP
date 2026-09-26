"use strict";
window.WebTerminal = class WebTerminal {
  constructor(send, context) {
    this.send = send; this.context = context; this.id = null; this.lease = null; this.seq = 0; this.inputSeq = 0;
    this.connected = false; this.ready = false; this.canInput = false; this.terminals = []; this.pending = new Map();
    const el = id => document.getElementById(id); this.el = el;
    this.fontSize = Math.min(24, Math.max(9, Number(localStorage.getItem("codexapp.terminal-font-size")) || 13));
    const columns = Number(localStorage.getItem("codexapp.terminal-columns"));
    this.columns = [80, 120, 160, 240].includes(columns) ? columns : 0;
    this.panMode = matchMedia("(pointer: coarse)").matches; this.pointers = new Map();
    el("terminalBtn").onclick = () => this.show();
    el("terminalHide").onclick = () => { el("terminalPanel").classList.add("hidden"); el("terminalBtn").focus(); };
    el("terminalNew").onclick = () => this.open();
    el("terminalReconnect").onclick = () => this.attach(this.id);
    el("terminalTakeover").onclick = () => this.attach(this.id, true);
    el("terminalSelect").onchange = () => this.attach(el("terminalSelect").value);
    el("terminalEnd").onclick = () => el("terminalCloseDialog").showModal();
    el("terminalCloseCancel").onclick = () => el("terminalCloseDialog").close();
    el("terminalCloseConfirm").onclick = () => { el("terminalCloseDialog").close(); this.command("terminalClose", { confirmed: true, lease: this.lease }); };
    el("terminalClear").onclick = () => this.input("\x0c");
    el("terminalZoomIn").onclick = () => this.setFontSize(this.fontSize + 1);
    el("terminalZoomOut").onclick = () => this.setFontSize(this.fontSize - 1);
    el("terminalZoomReset").onclick = () => this.setFontSize(13);
    el("terminalPan").onclick = () => { this.panMode = !this.panMode; this.updateNavigation(); };
    el("terminalLatest").onclick = () => this.latest();
    el("terminalWidth").onchange = () => { this.columns = Number(el("terminalWidth").value); localStorage.setItem("codexapp.terminal-columns", String(this.columns)); this.fit(); };
    el("terminalHorizontalScroll").oninput = () => { el("terminalViewport").scrollLeft = Number(el("terminalHorizontalScroll").value); this.updateNavigation(); };
    this.bindGestures(); this.updateNavigation();
    el("terminalPaste").onclick = () => { el("terminalPasteText").value = ""; el("terminalPasteDialog").showModal(); el("terminalPasteText").focus(); };
    el("terminalPasteCancel").onclick = () => el("terminalPasteDialog").close();
    el("terminalPasteConfirm").onclick = () => { const text = el("terminalPasteText").value; el("terminalPasteDialog").close(); if (this.canInput) this.term.paste(text); this.term.focus(); };
    const keys = { escape: "\x1b", tab: "\t", interrupt: "\x03", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C" };
    el("terminalPanel").querySelectorAll("[data-terminal-key]").forEach(button => { button.onclick = () => { this.input(keys[button.dataset.terminalKey]); this.term?.focus(); }; });
    this.observer = new ResizeObserver(() => { clearTimeout(this.fitTimer); this.fitTimer = setTimeout(() => this.fit(), 80); });
    this.observer.observe(el("terminalViewport"));
  }
  key() { return "codexapp.terminal." + this.context().profile; }
  configure(capability) {
    const reconnect = !this.connected;
    this.capability = capability || {}; this.connected = true;
    this.el("terminalBtn").disabled = !this.capability.supported;
    this.el("terminalBtn").title = this.capability.error || "打开终端";
    if (reconnect && !this.el("terminalPanel").classList.contains("hidden")) { this.command("terminalList"); if (this.id) this.attach(this.id); }
  }
  mount() {
    if (this.term) return;
    const { Terminal, FitAddon } = window.TerminalUI;
    this.term = new Terminal({ cursorBlink: true, fontSize: this.fontSize, fontFamily: "Consolas, Menlo, monospace", scrollback: 500, overviewRuler: { width: 16 }, theme: { background: "#171717", foreground: "#eeeeee", cursor: "#eeeeee", scrollbarSliderBackground: "#777777", scrollbarSliderHoverBackground: "#aaaaaa", scrollbarSliderActiveBackground: "#cccccc" }, allowProposedApi: true });
    this.fitAddon = new FitAddon(); this.term.loadAddon(this.fitAddon); this.term.open(this.el("terminalSurface"));
    this.term.textarea?.setAttribute("aria-label", "终端输入");
    // Queries are answered by the server emulator, including when this view is offline.
    for (const prefix of [undefined, "?", ">", "="]) for (const final of ["n", "c"]) this.term.parser.registerCsiHandler({ ...(prefix ? { prefix } : {}), final }, () => true);
    this.term.onData(data => { if (!/^\x1b\](?:10|11|12);rgb:/.test(data)) this.input(data); });
    this.term.onResize(({ cols, rows }) => { if (this.ready && this.canInput) this.command("terminalResize", { cols, rows, lease: this.lease }, false); });
    this.term.onScroll(() => this.updateNavigation());
    this.term.onWriteParsed(() => this.updateNavigation());
  }
  fit() {
    if (!this.term || this.el("terminalPanel").classList.contains("hidden")) return;
    const surface = this.el("terminalSurface");
    if (this.ready && !this.canInput && this.processStatus === "running") {
      const screen = surface.querySelector(".xterm-screen");
      surface.style.width = Math.max(this.el("terminalViewport").clientWidth - 16, screen?.offsetWidth + 16 || 0) + "px";
      surface.style.height = Math.max(this.el("terminalViewport").clientHeight - 16, screen?.offsetHeight || 0) + "px";
      this.updateNavigation(); return;
    }
    const screen = surface.querySelector(".xterm-screen");
    const cellWidth = (screen?.getBoundingClientRect().width || 0) / this.term.cols;
    surface.style.width = this.columns && cellWidth ? Math.max(this.el("terminalViewport").clientWidth - 16, Math.ceil(this.columns * cellWidth) + 16) + "px" : "";
    surface.style.height = "";
    const size = this.fitAddon.proposeDimensions();
    if (size && size.cols > 0 && size.rows > 0) this.term.resize(this.columns || Math.max(10, Math.min(240, size.cols)), Math.max(2, Math.min(80, size.rows)));
    this.updateNavigation();
  }
  updateNavigation() {
    const buffer = this.term?.buffer.active, viewport = this.el("terminalViewport");
    viewport.classList.toggle("has-scrollback", !!buffer?.baseY);
    viewport.classList.toggle("drag-mode", this.panMode);
    this.el("terminalPan").setAttribute("aria-pressed", String(this.panMode));
    this.el("terminalZoomValue").value = Math.round(this.fontSize / 13 * 100) + "%";
    this.el("terminalZoomOut").disabled = this.fontSize <= 9;
    this.el("terminalZoomIn").disabled = this.fontSize >= 24;
    this.el("terminalZoomReset").disabled = this.fontSize === 13;
    const width = this.el("terminalWidth"), readOnly = this.ready && !this.canInput && this.processStatus === "running";
    width.disabled = readOnly;
    if (readOnly) {
      let remote = width.querySelector('[value="remote"]');
      if (!remote) { remote = document.createElement("option"); remote.value = "remote"; width.append(remote); }
      remote.textContent = this.term.cols + " 列（只读）"; width.value = "remote";
    } else { width.querySelector('[value="remote"]')?.remove(); width.value = String(this.columns); }
    const horizontal = this.el("terminalHorizontalScroll"), max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    this.el("terminalHorizontalBar").classList.toggle("hidden", max <= 1);
    horizontal.max = String(max); horizontal.value = String(viewport.scrollLeft);
    horizontal.setAttribute("aria-valuemax", String(max)); horizontal.setAttribute("aria-valuenow", String(Math.round(viewport.scrollLeft)));
    horizontal.style.setProperty("--thumb-width", Math.max(28, (horizontal.clientWidth || viewport.clientWidth) * viewport.clientWidth / Math.max(1, viewport.scrollWidth)) + "px");
    const bottom = !buffer || (buffer.viewportY >= buffer.baseY && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2);
    this.el("terminalLatest").disabled = bottom;
    this.el("terminalScrollPosition").textContent = buffer ? (buffer.viewportY + 1) + "–" + Math.min(buffer.length, buffer.viewportY + this.term.rows) + " / " + buffer.length : "";
  }
  latest() {
    this.scrollRemainder = 0;
    this.term?.scrollToBottom();
    this.el("terminalViewport").scrollTop = this.el("terminalViewport").scrollHeight;
    this.el("terminalViewport").scrollLeft = 0;
    this.updateNavigation();
  }
  setFontSize(value) {
    const size = Math.max(9, Math.min(24, Math.round(value)));
    if (size === this.fontSize) return;
    const viewport = this.el("terminalViewport"), buffer = this.term?.buffer.active;
    const bottom = !buffer || (buffer.viewportY >= buffer.baseY && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2);
    const line = buffer?.viewportY || 0;
    const top = viewport.scrollTop, left = viewport.scrollLeft, scale = size / this.fontSize;
    this.fontSize = size; localStorage.setItem("codexapp.terminal-font-size", String(size));
    if (this.term) this.term.options.fontSize = size;
    cancelAnimationFrame(this.zoomFrame);
    this.zoomFrame = requestAnimationFrame(() => {
      this.fit(); this.scrollRemainder = 0;
      // xterm retains pixel scroll offsets when only the font changes. Reset the
      // scroll origin through its public API before restoring the logical line.
      if (this.term) this.term.scrollLines(-this.term.buffer.active.length * 4);
      if (bottom) this.latest();
      else { this.term?.scrollToLine(Math.min(line, this.term.buffer.active.baseY)); viewport.scrollTop = top * scale; }
      viewport.scrollLeft = left * scale;
    });
    this.updateNavigation();
  }
  cellHeight() { return (this.el("terminalSurface").querySelector(".xterm-screen")?.getBoundingClientRect().height || this.fontSize * this.term.rows) / this.term.rows; }
  scrollPixels(delta) {
    if (!this.term) return;
    const viewport = this.el("terminalViewport"), buffer = this.term.buffer.active, cell = this.cellHeight();
    const maximum = buffer.baseY * cell + Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const target = Math.max(0, Math.min(maximum, buffer.viewportY * cell + viewport.scrollTop + delta + (this.scrollRemainder || 0)));
    const line = Math.min(buffer.baseY, Math.floor(target / cell));
    this.term.scrollToLine(line); viewport.scrollTop = target - line * cell;
    this.scrollRemainder = target - line * cell - viewport.scrollTop; this.updateNavigation();
  }
  bindGestures() {
    const viewport = this.el("terminalViewport"), surface = this.el("terminalSurface");
    viewport.addEventListener("scroll", () => this.updateNavigation(), { passive: true });
    viewport.addEventListener("wheel", e => {
      if (e.ctrlKey) { e.preventDefault(); e.stopImmediatePropagation(); this.setFontSize(this.fontSize + (e.deltaY < 0 ? 1 : -1)); }
      else if (this.panMode && this.term) { e.preventDefault(); e.stopImmediatePropagation(); this.scrollPixels(e.deltaY); viewport.scrollLeft += e.deltaX; }
    }, { passive: false, capture: true });
    surface.addEventListener("pointerdown", e => {
      if (!this.term || e.target.closest(".scrollbar") || (e.pointerType === "mouse" && (!this.panMode || e.button !== 0))) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.panMode && this.pointers.size < 2) return;
      e.preventDefault(); e.stopImmediatePropagation(); surface.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
      this.scrollRemainder = 0;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()]; this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), size: this.fontSize }; this.drag.moved = true;
      }
      viewport.classList.add("dragging");
    }, true);
    surface.addEventListener("pointermove", e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.drag) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (this.pointers.size >= 2 && this.pinch?.distance) {
        const [a, b] = [...this.pointers.values()]; this.setFontSize(this.pinch.size * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.distance);
      } else if (this.panMode) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this.drag.moved = true;
        this.scrollPixels(-dy); viewport.scrollLeft -= dx; this.drag.x = e.clientX; this.drag.y = e.clientY;
      }
    }, true);
    const end = e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
      if (this.pointers.size) { const p = [...this.pointers.values()][0]; this.drag = { ...p, moved: true }; this.pinch = null; }
      else {
        if (this.drag && !this.drag.moved && e.pointerType === "touch" && e.type === "pointerup") this.term?.focus();
        this.drag = this.pinch = null; viewport.classList.remove("dragging");
      }
    };
    surface.addEventListener("pointerup", end, true); surface.addEventListener("pointercancel", end, true);
  }
  show() {
    this.el("terminalPanel").classList.remove("hidden"); this.mount(); this.fit(); this.term.focus();
    this.command("terminalList");
    const id = this.id || sessionStorage.getItem(this.key());
    if (id) this.attach(id); else this.open();
  }
  command(type, fields = {}, track = true) {
    const requestId = "terminal-" + newClientId();
    if (!this.send({ type, ...(this.id ? { terminalId: this.id } : {}), ...fields, requestId })) { this.disconnect(); return; }
    if (track) this.pending.set(requestId, setTimeout(() => { this.pending.delete(requestId); this.opening = false; this.ready = false; this.status("操作确认超时，请重新连接终端"); this.buttons(); }, 12000));
    return requestId;
  }
  open() {
    if (!this.connected || this.opening) return;
    if (this.id) this.command("terminalDetach", {}, false);
    this.mount(); this.fit(); this.ready = false; this.canInput = false; this.opening = true; this.status("正在启动终端…");
    this.attachRequest = this.command("terminalOpen", { threadId: this.context().threadId, cols: this.term.cols, rows: this.term.rows });
    this.buttons();
  }
  attach(id, takeControl = false) {
    if (!id || !this.connected) return;
    this.mount();
    if (this.id && this.id !== id) this.command("terminalDetach", {}, false);
    this.id = id; this.ready = false; this.canInput = false; this.status("正在连接终端…");
    this.attachRequest = this.command("terminalAttach", { terminalId: id, takeControl }); this.buttons();
  }
  input(data) {
    if (!this.connected || !this.ready || !this.canInput || !data) return;
    if (data.length > 16384) { this.status("单次终端输入最多 16384 字符，请分段粘贴"); return; }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 16000, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      if (!this.command("terminalInput", { lease: this.lease, data: data.slice(offset, end), inputSeq: ++this.inputSeq }, false)) break;
      offset = end;
    }
  }
  status(text) { this.el("terminalStatus").textContent = text; }
  buttons() {
    this.el("terminalNew").disabled = !this.connected || this.opening;
    this.el("terminalReconnect").disabled = !this.connected || !this.id;
    this.el("terminalEnd").disabled = !this.connected || !this.id || (this.processStatus === "running" && !this.canInput);
    this.el("terminalTakeover").classList.toggle("hidden", !this.ready || this.canInput || this.processStatus !== "running");
    this.el("terminalPanel").querySelectorAll(".terminal-keys button").forEach(b => { b.disabled = !this.connected || !this.ready || !this.canInput; });
    if (this.term) this.term.options.disableStdin = !this.connected || !this.ready || !this.canInput;
  }
  list(items) {
    this.terminals = items;
    const select = this.el("terminalSelect"); select.replaceChildren();
    if (!items.length) select.add(new Option("未打开终端", ""));
    for (const [i, item] of items.entries()) select.add(new Option(item.shell + " " + (i + 1) + (item.status === "running" ? "" : " · 已退出"), item.terminalId));
    select.value = this.id || "";
  }
  receive(m) {
    if (typeof m?.type !== "string") return false;
    if (m.type === "error") {
      if (!m.requestId?.startsWith("terminal-")) return false;
      if (m.terminalId && m.terminalId !== this.id && m.requestId !== this.attachRequest) return true;
      clearTimeout(this.pending.get(m.requestId)); this.pending.delete(m.requestId);
      this.opening = false; this.ready = false; this.canInput = false; this.status(m.message); this.buttons(); return true;
    }
    if (!m.type.startsWith("terminal")) return false;
    clearTimeout(this.pending.get(m.requestId)); this.pending.delete(m.requestId);
    if (m.type === "terminalList") { this.list(m.terminals || []); return true; }
    if (m.type === "terminalAttached") {
      if (m.requestId !== this.attachRequest) return true;
      this.mount(); this.opening = false; this.id = m.terminalId; this.lease = m.lease; this.inputSeq = 0; this.seq = m.seq;
      this.processStatus = m.status; this.canInput = !!m.canInput && m.status === "running"; this.ready = false;
      this.term.reset(); this.term.resize(m.cols, m.rows);
      this.el("terminalCwd").textContent = "启动目录：" + m.cwd;
      sessionStorage.setItem(this.key(), this.id); this.el("terminalSelect").value = this.id;
      const id = this.id;
      this.term.write(m.data, () => {
        if (this.id !== id || m.requestId !== this.attachRequest) return;
        this.ready = true; this.status(this.processStatus !== "running" ? "已退出" : this.canInput ? "已连接" : "只读 · 其他页面控制");
        this.buttons(); this.fit(); this.latest(); this.term.focus();
      });
    } else if (m.terminalId !== this.id) return true;
    else if (m.type === "terminalOutput") {
      if (m.seq <= this.seq) return true;
      if (m.seq !== this.seq + 1) { this.ready = false; this.status("输出不连续，请重新连接终端"); this.buttons(); return true; }
      this.seq = m.seq;
      const id = this.id;
      this.term.write(m.data, () => { if (this.id === id) this.command("terminalAck", { seq: m.seq }, false); });
    } else if (m.type === "terminalPaused") { this.ready = false; this.status(m.message); this.buttons(); }
    else if (m.type === "terminalControl") { this.canInput = !!m.canInput; this.status(this.canInput ? "已连接" : "只读 · 可接管输入"); this.buttons(); }
    else if (m.type === "terminalResized") { this.canInput = false; this.term.resize(m.cols, m.rows); this.fit(); this.buttons(); }
    else if (m.type === "terminalExit") { this.processStatus = "exited"; this.canInput = false; this.status("已退出 · " + m.exitCode); this.buttons(); }
    else if (m.type === "terminalClosed") { this.id = null; this.ready = false; this.canInput = false; sessionStorage.removeItem(this.key()); this.status("终端已结束"); this.buttons(); }
    return true;
  }
  disconnect() {
    this.connected = false; this.ready = false; this.canInput = false; this.opening = false;
    for (const timer of this.pending.values()) clearTimeout(timer); this.pending.clear();
    this.el("terminalBtn").disabled = true; this.status("连接已断开；终端仍由服务端保持"); this.buttons();
  }
};
