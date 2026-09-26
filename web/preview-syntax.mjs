import { HIGHLIGHT_LIMITS } from "./preview-languages.mjs";
export { previewLanguages, previewLanguageForFile } from "./preview-languages.mjs";

export class PreviewHighlighter {
  cancel() { clearTimeout(this.timer); this.worker?.terminate(); this.worker = null; this.generation = (this.generation || 0) + 1; }
  highlight(text, language, done) {
    this.cancel();
    if (text.length > HIGHLIGHT_LIMITS.chars) { done({ fallback: "large" }); return; }
    const generation = this.generation;
    const complete = result => {
      if (this.generation !== generation) return;
      this.cancel(); done(result);
    };
    try {
      this.worker = new Worker(new URL("vendor/preview-highlight-worker.js", location.href));
      this.worker.onmessage = event => complete(event.data);
      this.worker.onerror = event => { event.preventDefault(); complete({ fallback: "unavailable" }); };
      this.timer = setTimeout(() => complete({ fallback: "timeout" }), HIGHLIGHT_LIMITS.timeout);
      this.worker.postMessage({ text, language });
    } catch { complete({ fallback: "unavailable" }); }
  }
}

// Render text nodes instead of HTML so CRLF and source offsets remain unchanged.
export function previewFragment(text, tree, range) {
  const leaves = []; let offset = 0, budget = 0;
  const visit = (node, scopes = []) => {
    if (++budget > HIGHLIGHT_LIMITS.nodes || scopes.length > HIGHLIGHT_LIMITS.depth) throw new Error("Highlight tree too large");
    if (node.type === "text") {
      leaves.push({ start: offset, end: offset + node.value.length, value: node.value, scopes }); offset += node.value.length; return;
    }
    if (node.type === "element") {
      if (node.tagName !== "span") throw new Error("Invalid highlight node");
      const classes = (node.properties?.className || []).filter(name => /^[a-zA-Z_][\w-]{0,63}$/.test(name));
      scopes = [...scopes, classes];
    }
    for (const child of node.children || []) visit(child, scopes);
  };
  if (tree) visit(tree); else leaves.push({ start: 0, end: text.length, value: text, scopes: [] });
  if (tree && leaves.map(leaf => leaf.value).join("") !== text) throw new Error("Highlight changed source text");
  const section = (start, end) => {
    const fragment = document.createDocumentFragment();
    for (const leaf of leaves) {
      const from = Math.max(start, leaf.start), to = Math.min(end, leaf.end);
      if (from >= to) continue;
      let node = document.createTextNode(text.slice(from, to));
      for (let i = leaf.scopes.length - 1; i >= 0; i--) {
        if (++budget > HIGHLIGHT_LIMITS.nodes) throw new Error("Highlight DOM too large");
        const span = document.createElement("span"); span.classList.add(...leaf.scopes[i]); span.append(node); node = span;
      }
      fragment.append(node);
    }
    return fragment;
  };
  const fragment = document.createDocumentFragment();
  if (!range?.found) { fragment.append(section(0, text.length)); return fragment; }
  const mark = document.createElement("mark"), anchor = document.createElement("span");
  mark.className = "text-preview-target"; mark.dataset.line = String(range.line); mark.dataset.endLine = String(range.endLine);
  anchor.className = "text-preview-anchor"; anchor.append(section(range.anchor, range.anchorEnd));
  mark.append(section(range.start, range.anchor), anchor, section(range.anchorEnd, range.end));
  fragment.append(section(0, range.start), mark, section(range.end, text.length));
  return fragment;
}
