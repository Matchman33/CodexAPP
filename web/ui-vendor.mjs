import { createIcons, Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus } from "lucide";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { appendTextPreview, appendReasoningPreview } from "../core/textPreview.mjs";
import { mergeMessageEvents } from "../core/messageOrder.mjs";
import { Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image } from "lucide";

const icons = { Menu, SquarePen, Settings2, ChevronDown, ChevronUp, ArrowUp, Square, X, RefreshCw, Folder, MessageSquare, Search, ArrowDown, Copy, Check, FileDiff, SlidersHorizontal, ShieldCheck, Ellipsis, Sun, Moon, Pause, Play, ListOrdered, ListPlus, ImagePlus };
window.ChatUI = {
  appendTextPreview,
  appendReasoningPreview,
  mergeMessageEvents,
  icons(root = document) { createIcons({ icons: { ...icons, Trash2, LockOpen, Download, Eye, File, FileSpreadsheet, Image }, root, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } }); },
  markdown(text) {
    return DOMPurify.sanitize(marked.parse(text || "", { gfm: true, breaks: true }), {
      USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "style", "input", "button", "form", "video", "audio", "iframe"],
      FORBID_ATTR: ["style", "id", "name", "class"],
    });
  },
};
