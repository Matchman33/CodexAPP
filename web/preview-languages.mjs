export const previewLanguages = [
  { id: "javascript", label: "JavaScript", extensions: ["js", "mjs"] },
  { id: "typescript", label: "TypeScript", extensions: ["ts"] },
  { id: "python", label: "Python", extensions: ["py"] },
  { id: "c", label: "C", extensions: ["c"] },
  { id: "cpp", label: "C++", extensions: ["cpp", "h"] },
  { id: "json", label: "JSON", extensions: ["json"] },
  { id: "xml", label: "HTML / SVG", extensions: ["html", "svg"] },
  { id: "css", label: "CSS", extensions: ["css"] },
  { id: "markdown", label: "Markdown", extensions: ["md"] },
];
export const HIGHLIGHT_LIMITS = { chars: 131072, nodes: 12000, depth: 24, timeout: 1800 };
export function previewLanguageForFile(name) {
  const extension = String(name).split(".").at(-1).toLowerCase();
  return previewLanguages.find(language => language.extensions.includes(extension))?.id || null;
}
