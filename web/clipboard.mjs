export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch {}
  }
  const previous = document.activeElement, selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text; input.readOnly = true; input.setAttribute("aria-hidden", "true");
  Object.assign(input.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", fontSize: "16px" });
  const host = previous?.closest("dialog[open]") || document.querySelector("dialog[open]") || document.body;
  host.append(input);
  try {
    input.focus({ preventScroll: true }); input.select(); input.setSelectionRange(0, input.value.length);
    if (!document.execCommand("copy")) throw new Error("浏览器未允许复制，请选择文本后复制");
  } finally {
    input.remove(); previous?.focus?.({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
}
