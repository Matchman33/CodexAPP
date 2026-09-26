import { createIcons, Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus } from "lucide";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { appendTextPreview, appendReasoningPreview } from "../core/textPreview.mjs";
import { mergeMessageEvents } from "../core/messageOrder.mjs";
import { localFileTarget, webLinkTarget, fileLinkLocation, textLocation, markdownPathReference } from "../core/linkTargets.mjs";
import { copyText } from "./clipboard.mjs";
import { PreviewHighlighter, previewFragment, previewLanguages, previewLanguageForFile } from "./preview-syntax.mjs";
import { Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image, SquareTerminal, Plus, Keyboard, ClipboardPaste, Eraser, ArrowLeft, ArrowRight, Hand, ZoomIn, ZoomOut, RotateCcw, ArrowDownToLine } from "lucide";

const icons = { Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus };
const isLocalFile = href => localFileTarget(href) !== null;
const escapeLabel = text => String(text || "图片").replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const unavailableLink = (label, reference) => '<a role="button" tabindex="0" data-codex-unavailable="true"' + (reference ? ' data-codex-reference="' + escapeLabel(reference) + '"' : "") + ' title="无法访问文件：' + escapeLabel(reference || "原始文件地址不可用") + '">' + label + "</a>";
const unavailableMarker = href => {
  if (href === "#codex-file-unavailable") return true;
  try { const url = new URL(href, location.href); return url.origin === location.origin && url.pathname === location.pathname && url.hash === "#codex-file-unavailable"; } catch { return false; }
};
window.ChatUI = {
  copyText,
  PreviewHighlighter,
  previewFragment,
  previewLanguages,
  previewLanguageForFile,
  localFileTarget,
  fileLinkLocation,
  textLocation,
  appendTextPreview,
  appendReasoningPreview,
  mergeMessageEvents,
  icons(root = document) { createIcons({ icons: { ...icons, Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image, SquareTerminal, Plus, Keyboard, ClipboardPaste, Eraser, ArrowLeft, ArrowRight, Hand, ZoomIn, ZoomOut, RotateCcw, ArrowDownToLine }, root, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } }); },
  markdown(text, files = []) {
    const renderer = new marked.Renderer(), link = renderer.link, codespan = renderer.codespan, plainText = renderer.text;
    let insideLink = 0;
    const attachmentLink = (index, label, location, reference) => {
      const attributes = location ? Object.entries(location).map(([key, value]) => ' data-source-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + '="' + value + '"').join("") : "";
      return '<a href="#codex-file-' + index + '" data-codex-reference="' + escapeLabel(reference) + '"' + attributes + '>' + label + "</a>";
    };
    // 在清理 HTML 前把已登记的本地路径换成片段标记，浏览器不直接访问电脑路径。
    const renderLink = function (token) {
      const label = this.parser.parseInline(token.tokens);
      if (unavailableMarker(token.href)) return unavailableLink(label, null);
      const web = webLinkTarget(token.href);
      if (web) return link.call(this, { ...token, href: web });
      const index = files.findIndex(file => file.reference === token.href || file.references?.includes(token.href));
      if (index >= 0) {
        let location = fileLinkLocation(token.href);
        if (!location) {
          const plain = String(token.text || "").replace(/^`(.*)`$/, "$1");
          const sourceName = localFileTarget(token.href)?.split(/[\\/]/).at(-1);
          if (sourceName && localFileTarget(plain)?.split(/[\\/]/).at(-1) === sourceName) location = fileLinkLocation(plain);
        }
        return attachmentLink(index, label, location, token.href);
      }
      if (isLocalFile(token.href)) return unavailableLink(label, token.href);
      return link.call(this, token);
    };
    renderer.link = function (token) {
      insideLink++;
      try { return renderLink.call(this, token); }
      finally { insideLink--; }
    };
    renderer.codespan = function (token) {
      const code = codespan.call(this, token);
      if (insideLink) return code;
      const index = files.findIndex(file => file.reference === token.text || file.references?.includes(token.text));
      if (index >= 0) return attachmentLink(index, code, fileLinkLocation(token.text), token.text);
      return markdownPathReference(token.text) ? unavailableLink(code, token.text) : code;
    };
    renderer.text = function (token) {
      const label = plainText.call(this, token);
      if (insideLink || token.tokens) return label;
      const reference = markdownPathReference(token.text);
      if (!reference) return label;
      const index = files.findIndex(file => file.reference === reference || file.references?.includes(reference));
      return index >= 0 ? attachmentLink(index, label, fileLinkLocation(reference), reference) : unavailableLink(label, reference);
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
