import { createIcons, Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus } from "lucide";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { appendTextPreview, appendReasoningPreview } from "../core/textPreview.mjs";
import { mergeMessageEvents } from "../core/messageOrder.mjs";
import { localFileTarget, webLinkTarget } from "../core/linkTargets.mjs";
import { Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image, SquareTerminal, Plus, Keyboard, ClipboardPaste, Eraser, ArrowLeft, ArrowRight, Hand, ZoomIn, ZoomOut, RotateCcw, ArrowDownToLine } from "lucide";

const icons = { Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus };
const isLocalFile = href => localFileTarget(href) !== null;
const escapeLabel = text => String(text || "图片").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const unavailableLink = (label, reference) => '<a role="button" tabindex="0" data-codex-unavailable="true" title="无法访问文件：' + escapeLabel(reference) + '">' + label + "</a>";
const unavailableMarker = href => {
  if (href === "#codex-file-unavailable") return true;
  try { const url = new URL(href, location.href); return url.origin === location.origin && url.pathname === location.pathname && url.hash === "#codex-file-unavailable"; } catch { return false; }
};
window.ChatUI = {
  localFileTarget,
  appendTextPreview,
  appendReasoningPreview,
  mergeMessageEvents,
  icons(root = document) { createIcons({ icons: { ...icons, Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image, SquareTerminal, Plus, Keyboard, ClipboardPaste, Eraser, ArrowLeft, ArrowRight, Hand, ZoomIn, ZoomOut, RotateCcw, ArrowDownToLine }, root, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } }); },
  markdown(text, files = []) {
    const renderer = new marked.Renderer(), link = renderer.link;
    // 在清理 HTML 前把已登记的本地路径换成片段标记，浏览器不直接访问电脑路径。
    renderer.link = function (token) {
      const label = this.parser.parseInline(token.tokens);
      if (unavailableMarker(token.href)) return unavailableLink(label, "原始文件地址不可用");
      const web = webLinkTarget(token.href);
      if (web) return link.call(this, { ...token, href: web });
      const index = files.findIndex(file => file.reference === token.href || file.references?.includes(token.href));
      if (index >= 0) return '<a href="#codex-file-' + index + '">' + label + "</a>";
      if (isLocalFile(token.href)) return unavailableLink(label, token.href);
      return link.call(this, token);
    };
    renderer.image = function (token) {
      const index = files.findIndex(file => file.reference === token.href || file.references?.includes(token.href));
      if (index < 0 && !isLocalFile(token.href)) return "";
      return index >= 0 ? '<a href="#codex-preview-' + index + '">' + escapeLabel(token.text) + "</a>" : unavailableLink(escapeLabel(token.text), token.href);
    };
    return DOMPurify.sanitize(marked.parse(text || "", { gfm: true, breaks: true, renderer }), {
      USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "style", "input", "button", "form", "video", "audio", "iframe"],
      FORBID_ATTR: ["style", "id", "name", "class"],
    });
  },
};
