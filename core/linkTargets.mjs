// Shared by attachment registration and Markdown rendering.
export function webLinkTarget(value) {
  if (typeof value !== "string") return null;
  const href = value.trim();
  const explicit = /^(?:https?:\/\/|\/\/)/i.test(href);
  const address = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\]):\d{1,5}(?:[/?#].*)?$/i.test(href);
  if (!explicit && !address) return null;
  try {
    const url = new URL(href.startsWith("//") ? "http:" + href : explicit ? href : "http://" + href);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    return explicit ? href : url.href;
  } catch { return null; }
}

export function localFileTarget(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("#") || webLinkTarget(value)) return null;
  let href = value.trim();
  // Source locations are metadata, not part of the downloadable filename.
  href = href.replace(/(\.[a-z\d]{1,16})(?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/i, "$1");
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(?:file:|sandbox:|[a-z]:[\\/])/i.test(href)) return null;
  return href.replace(/^\/(?=[a-z]:[\\/])/i, "");
}
