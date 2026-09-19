import { createIcons, Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus } from "lucide";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { appendTextPreview, appendReasoningPreview } from "../core/textPreview.mjs";
import { mergeMessageEvents } from "../core/messageOrder.mjs";
import { Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image } from "lucide";

const icons = { Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus };
const isLocalFile = href => href && !href.startsWith("#") && (!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) || /^(?:file:|sandbox:|[a-z]:[\\/])/i.test(href));
const escapeLabel = text => String(text || "图片").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
window.ChatUI = {
  appendTextPreview,
  appendReasoningPreview,
  mergeMessageEvents,
  icons(root = document) { createIcons({ icons: { ...icons, Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image }, root, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } }); },
  markdown(text, files = []) {
    const renderer = new marked.Renderer(), link = renderer.link;
    // 在清理 HTML 前把已登记的本地路径换成片段标记，浏览器不直接访问电脑路径。
    renderer.link = function (token) {
      const index = files.findIndex(file => file.reference === token.href || file.references?.includes(token.href));
      if (index >= 0 || isLocalFile(token.href)) return '<a href="' + (index >= 0 ? "#codex-file-" + index : "#codex-file-unavailable") + '">' + this.parser.parseInline(token.tokens) + "</a>";
      return link.call(this, token);
    };
    renderer.image = function (token) {
      const index = files.findIndex(file => file.reference === token.href || file.references?.includes(token.href));
      if (index < 0 && !isLocalFile(token.href)) return "";
      return '<a href="' + (index >= 0 ? "#codex-preview-" + index : "#codex-file-unavailable") + '">' + escapeLabel(token.text) + "</a>";
    };
    return DOMPurify.sanitize(marked.parse(text || "", { gfm: true, breaks: true, renderer }), {
      USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "style", "input", "button", "form", "video", "audio", "iframe"],
      FORBID_ATTR: ["style", "id", "name", "class"],
    });
  },
};
