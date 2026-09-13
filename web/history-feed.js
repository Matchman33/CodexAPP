"use strict";

// Keep only viewport rows in the DOM; page ownership stays with the caller.
window.HistoryFeed = class HistoryFeed {
  constructor(feed, createRow, updateRow) {
    this.feed = feed; this.createRow = createRow; this.updateRow = updateRow;
    this.events = []; this.rows = new Map(); this.heights = new Map(); this.expanded = new Set();
    this.top = document.createElement("div"); this.bottom = document.createElement("div");
    this.top.className = this.bottom.className = "history-spacer";
    this.frame = null; this.follow = true; this.dirty = new Set();
    feed.replaceChildren(this.top, this.bottom);
    feed.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.width = feed.clientWidth;
    this.observer = new ResizeObserver(entries => {
      if (this.width !== feed.clientWidth) { this.width = feed.clientWidth; this.heights.clear(); for (const id of this.rows.keys()) this.dirty.add(id); }
      for (const entry of entries) if (entry.target.dataset.eventId) this.dirty.add(entry.target.dataset.eventId);
      this.schedule();
    });
    this.observer.observe(feed);
  }
  placeholder(e) {
    return (e.kind === "item:agentMessage" && !e.text) || (e.kind === "item:reasoning" && !e.live && !e.truncated && !(e.text || "").trim() && !e.error && !["failed", "interrupted"].includes(e.status));
  }
  height(e) { return this.placeholder(e) ? 0 : this.heights.get(e.id) || Math.min(1600, Math.max(80, Math.ceil((e.text || "").length / 55) * 24 + 65)); }
  offsets() {
    const offsets = [0];
    for (const e of this.events) offsets.push(offsets.at(-1) + this.height(e));
    return offsets;
  }
  anchor() {
    const offsets = this.offsets(), y = this.feed.scrollTop - 18;
    let index = 0;
    while (index < this.events.length - 1 && offsets[index + 1] <= y) index++;
    return { id: this.events[index]?.id, delta: y - offsets[index], scrollTop: this.feed.scrollTop };
  }
  restore(anchor) {
    const index = this.events.findIndex(e => e.id === anchor.id);
    this.feed.scrollTop = index >= 0 ? this.offsets()[index] + anchor.delta + 18 : anchor.scrollTop;
  }
  replace(events, bottom = false) {
    const anchor = this.anchor();
    this.events = [...new Map(events.map(e => [e.id, e])).values()];
    const ids = new Set(this.events.map(e => e.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { this.observer.unobserve(row); this.rows.delete(id); }
    for (const id of this.heights.keys()) if (!ids.has(id)) this.heights.delete(id);
    for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
    for (const id of this.dirty) if (!ids.has(id)) this.dirty.delete(id);
    this.follow = bottom;
    if (!bottom) this.restore(anchor);
    this.render();
  }
  upsert(event) {
    const index = this.events.findIndex(e => e.id === event.id);
    if (index < 0) this.events.push(event); else this.events[index] = event;
    this.schedule();
  }
  schedule() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
  }
  render() {
    const offsets = this.offsets(), f = this.feed;
    const anchor = this.anchor();
    const y = this.follow ? Math.max(0, offsets.at(-1) - f.clientHeight) : Math.max(0, f.scrollTop - 18);
    let start = 0;
    while (start < this.events.length - 1 && offsets[start + 1] < y - 600) start++;
    let end = start;
    while (end < this.events.length && end - start < 60 && offsets[end] < y + f.clientHeight + 600) end++;
    const visible = new Set(), ordered = [this.top];
    for (let i = start; i < end; i++) {
      const e = this.events[i];
      if (this.placeholder(e)) continue;
      visible.add(e.id);
      let row = this.rows.get(e.id);
      if (!row) {
        row = this.createRow(e); this.rows.set(e.id, row); this.observer.observe(row); this.dirty.add(e.id);
        const details = row.querySelector("details");
        if (details) {
          details.open = this.expanded.has(e.id);
          details.addEventListener("toggle", () => { if (details.open) this.expanded.add(e.id); else this.expanded.delete(e.id); });
        }
      }
      else if (row._event !== e) { this.updateRow(row, e); this.dirty.add(e.id); }
      row._event = e; ordered.push(row);
    }
    for (const [id, row] of this.rows) if (!visible.has(id)) { this.observer.unobserve(row); this.rows.delete(id); this.dirty.delete(id); }
    this.top.style.height = offsets[start] + "px";
    this.bottom.style.height = (offsets.at(-1) - offsets[end]) + "px";
    ordered.push(this.bottom);
    const keep = new Set(ordered);
    for (const node of [...f.childNodes]) if (!keep.has(node)) node.remove();
    let next = f.firstChild;
    for (const node of ordered) { if (node === next) next = next.nextSibling; else f.insertBefore(node, next); }
    let changed = false;
    for (let i = start; i < end; i++) {
      if (this.placeholder(this.events[i])) continue;
      if (!this.dirty.delete(this.events[i].id)) continue;
      const height = this.rows.get(this.events[i].id).getBoundingClientRect().height + 20;
      if (Math.abs(height - this.height(this.events[i])) > 1) { this.heights.set(this.events[i].id, height); changed = true; }
    }
    if (changed) {
      const measured = this.offsets();
      this.top.style.height = measured[start] + "px";
      this.bottom.style.height = (measured.at(-1) - measured[end]) + "px";
      if (!this.follow) this.restore(anchor);
      this.schedule();
    }
    if (this.follow) f.scrollTop = f.scrollHeight;
    f.dataset.historyRows = String(this.events.length);
    f.dataset.historyChars = String(this.events.reduce((n,e) => n + (e.text || "").length, 0));
    document.getElementById("emptyState").classList.toggle("hidden", this.events.length > 0);
  }
};
