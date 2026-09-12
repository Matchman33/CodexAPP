import { createIcons, Menu, SquarePen, Settings2, ChevronDown, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon } from "lucide";
import { marked } from "marked";
import DOMPurify from "dompurify";

const icons = { Menu, SquarePen, Settings2, ChevronDown, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon };
window.ChatUI = {
  icons(root = document) { createIcons({ icons, root, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } }); },
  markdown(text) {
    return DOMPurify.sanitize(marked.parse(text || "", { gfm: true, breaks: true }), {
      USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "style", "input", "button", "form", "video", "audio", "iframe"],
      FORBID_ATTR: ["style", "id", "name", "class"],
    });
  },
};
