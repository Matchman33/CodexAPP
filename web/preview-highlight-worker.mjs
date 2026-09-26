import { createLowlight } from "lowlight";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import { HIGHLIGHT_LIMITS } from "./preview-languages.mjs";

const lowlight = createLowlight({ javascript, typescript, python, c, cpp, json, xml, css, markdown });
self.onmessage = ({ data }) => {
  try {
    if (typeof data.text !== "string" || data.text.length > HIGHLIGHT_LIMITS.chars || !lowlight.registered(data.language)) throw new Error("unsupported");
    const tree = lowlight.highlight(data.language, data.text);
    let count = 0;
    const visit = (node, depth = 0) => {
      if (++count > HIGHLIGHT_LIMITS.nodes || depth > HIGHLIGHT_LIMITS.depth) throw new Error("complex");
      for (const child of node.children || []) visit(child, depth + 1);
    };
    visit(tree); self.postMessage({ tree });
  } catch { self.postMessage({ fallback: "complex" }); }
};
