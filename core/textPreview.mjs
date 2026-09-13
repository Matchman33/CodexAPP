export const PREVIEW_CHARS = 8192;

export function clipTextPreview(event, limit = PREVIEW_CHARS, tail = false) {
  const source = event.text || "", textLength = event.textLength ?? source.length;
  const cut = Math.max(0, source.length - limit), textOffset = (event.textOffset || 0) + (tail ? cut : 0);
  const text = tail ? source.slice(cut) : source.slice(0, limit);
  const truncated = textOffset > 0 || textOffset + text.length < textLength;
  return { ...event, text, textLength, textOffset, truncated, preview: truncated ? (tail ? "tail" : "head") : null,
    headText: truncated ? (event.headText ?? ((event.textOffset || 0) === 0 ? source : undefined))?.slice(0, limit) : undefined };
}

export function appendTextPreview(previous, delta, limit = PREVIEW_CHARS) {
  let source = previous || { text: "", textLength: 0, textOffset: 0 };
  if (limit !== null && (source.textOffset || 0) + (source.text || "").length < (source.textLength || 0)) {
    source = { ...source, headText: source.headText ?? ((source.textOffset || 0) === 0 ? source.text.slice(0, limit) : undefined), text: "", textOffset: source.textLength };
  }
  const event = { ...source, text: (source.text || "") + delta, textLength: (source.textLength ?? source.text?.length ?? 0) + delta.length, live: true, status: "running" };
  return limit === null ? event : clipTextPreview(event, limit, true);
}

export function appendReasoningPreview(previous, delta, source = "summary", limit = PREVIEW_CHARS) {
  if (previous?.reasoningSource === "summary" && source === "content") return null;
  // Summary and content are alternate views, not consecutive fragments of one text.
  const base = previous?.reasoningSource && previous.reasoningSource !== source
    ? { ...previous, text: "", textLength: 0, textOffset: 0, headText: undefined, truncated: false, preview: null }
    : previous;
  return { ...appendTextPreview(base, delta, limit), reasoningSource: source };
}
