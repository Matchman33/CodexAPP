// Shared by attachment registration and Markdown rendering.
const sourceSuffix = /(\.[a-z\d]{1,16})(?::(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?|#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?)$/i;
export function markdownLinkReference(token) {
  // Markdown 会把 Windows 路径中的 \. 等片段当转义；从原始链接保留文件路径。
  if (!/^\/?[a-z]:[\\/]/i.test(token.href || "") || !token.raw) return token.href;
  const raw = token.raw, start = raw.startsWith("!") ? 1 : 0;
  if (raw[start] !== "[") return token.href;
  let brackets = 1, index = start + 1;
  // 只定位外层标签的结束位置，跳过标签内的转义、代码和嵌套图片。
  for (; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\") { index++; continue; }
    if (char === "`") {
      const run = raw.slice(index).match(/^`+/)[0];
      let end = raw.indexOf(run, index + run.length);
      while (end >= 0 && (raw[end - 1] === "`" || raw[end + run.length] === "`")) end = raw.indexOf(run, end + run.length);
      if (end >= 0) { index = end + run.length - 1; continue; }
    }
    if (char === "[") brackets++;
    if (char === "]" && --brackets === 0) break;
  }
  if (brackets || raw[index + 1] !== "(") return token.href;
  const source = raw.slice(index + 2).trimStart();
  let reference = "";
  if (source.startsWith("<")) {
    const end = source.indexOf(">");
    if (end < 0) return token.href;
    reference = source.slice(1, end);
  } else {
    let depth = 0;
    for (const char of source) {
      if (/\s/.test(char) || (char === ")" && depth === 0)) break;
      if (char === "(") depth++;
      if (char === ")") depth--;
      reference += char;
    }
  }
  // 与解析后的实际 href 核对，只允许补回被转义掉的反斜杠。
  if (reference.replace(/\\([!-/:-@[-\x60{-~])/g, "$1") === token.href) return reference;
  return token.href;
}

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
  href = href.replace(sourceSuffix, "$1");
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(?:file:|sandbox:|[a-z]:[\\/])/i.test(href)) return null;
  return href.replace(/^\/(?=[a-z]:[\\/])/i, "");
}

export function markdownPathReference(value) {
  const target = localFileTarget(value);
  if (!target || !/\.(?:md|png|jpe?g|webp|gif)$/i.test(target) || /[\r\n`<>|?*]/.test(target)) return null;
  if (/\s/.test(target) && !/^(?:[a-z]:[\\/]|\/|file:|sandbox:)/i.test(target)) return null;
  return value.trim();
}

export function fileLinkLocation(value) {
  if (localFileTarget(value) === null) return null;
  const match = value.trim().match(sourceSuffix);
  if (!match) return null;
  const line = Number(match[2] || match[6]);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const result = { line };
  for (const [key, value] of [["column", match[3] || match[7]], ["endLine", match[4] || match[8]], ["endColumn", match[5] || match[9]]]) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) result[key] = number;
  }
  if (result.endLine < line) { delete result.endLine; delete result.endColumn; }
  return result;
}

export function textLocation(text, location) {
  if (!Number.isSafeInteger(location?.line) || location.line < 1) return null;
  const endLine = Math.max(location.line, location.endLine || location.line);
  let line = 1, offset = 0, start = -1, end = text.length, firstEnd = text.length;
  const newline = /\r\n|\r|\n/g;
  for (;;) {
    const match = newline.exec(text), lineEnd = match ? match.index : text.length;
    if (line === location.line) { start = offset; firstEnd = lineEnd; }
    if (line === endLine) { end = lineEnd; break; }
    if (!match) break;
    offset = match.index + match[0].length; line++;
  }
  if (start < 0) return { found: false, totalLines: line };
  let anchor = Math.min(firstEnd, start + Math.max(0, (location.column || 1) - 1));
  if (anchor > start && /[\uDC00-\uDFFF]/.test(text[anchor] || "") && /[\uD800-\uDBFF]/.test(text[anchor - 1])) anchor--;
  const length = text.codePointAt(anchor) > 0xffff ? 2 : 1;
  return { found: true, start, end, anchor, anchorEnd: Math.min(firstEnd, anchor + length), line: location.line, endLine: Math.min(line, endLine) };
}
