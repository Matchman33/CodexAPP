import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileAttachments, fileReferences } from "../core/fileAttachments.mjs";
import { localFileTarget, webLinkTarget, fileLinkLocation, textLocation, markdownPathReference } from "../core/linkTargets.mjs";

test("带行号的源码链接能登记为原文件，不把行号当作文件名", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-links-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "demo.js"), "const fixture = true;\n");
  const files = new FileAttachments(); files.remember("one", dir);
  for (const ref of ["demo.js:12", "demo.js:12:3", "demo.js#L12", "demo.js#L12-L20", ...(process.platform === "win32" ? ["/" + path.join(dir, "demo.js").replaceAll("\\", "/") + ":12"] : [])]) {
    assert.deepEqual(fileReferences("[源码](" + ref + ")"), [ref]);
    assert.equal(files.register(ref, "one")?.name, "demo.js", ref);
  }
  assert.equal(files.register("../outside.js:12", "one"), null);
  assert.equal(files.register("demo.js:secret", "one"), null);
});

test("文件定位保留行列与范围，不把网页端口当行号", () => {
  assert.deepEqual(fileLinkLocation("demo.js:120"), { line: 120 });
  assert.deepEqual(fileLinkLocation("demo.js:120:3"), { line: 120, column: 3 });
  assert.deepEqual(fileLinkLocation("demo.js#L120-L125"), { line: 120, endLine: 125 });
  assert.deepEqual(fileLinkLocation("/C:/demo.js#L12C4-L15C8"), { line: 12, column: 4, endLine: 15, endColumn: 8 });
  for (const value of ["http://127.0.0.1:4123", "demo.js:0", "demo.js:999999999999999999999999", "demo.js"]) assert.equal(fileLinkLocation(value), null);
});

test("文本行定位兼容 CRLF、空行、末行和不存在的行，不改变原文", () => {
  const text = "first\r\n\r\nthird\nlast";
  const range = textLocation(text, { line: 3, column: 2, endLine: 4 });
  assert.equal(text.slice(range.start, range.end), "third\nlast");
  assert.equal(text.slice(range.anchor, range.anchorEnd), "h");
  assert.equal(textLocation(text, { line: 2 }).start, textLocation(text, { line: 2 }).end);
  assert.equal(textLocation(text, { line: 50 }).found, false);
  assert.equal(textLocation(text, { line: 50 }).totalLines, 4);
  assert.equal(textLocation("", { line: 1 }).found, true);
  const unicode = textLocation("a😀b", { line: 1, column: 3 });
  assert.equal("a😀b".slice(unicode.anchor, unicode.anchorEnd), "😀");
});

test("网页地址与文件地址分类一致，不把 IP 端口或协议地址登记成附件", () => {
  for (const href of ["39.102.80.25:7002/demo", "localhost:4123/", "[::1]:4123/"]) {
    assert(webLinkTarget(href)?.startsWith("http://")); assert.equal(localFileTarget(href), null);
  }
  for (const href of ["https://example.com/demo.js:12", "http://39.102.80.25:7002/", "//example.com/demo"]) {
    assert.equal(webLinkTarget(href), href); assert.equal(localFileTarget(href), null);
  }
  assert.equal(webLinkTarget("demo.js:12"), null);
  assert.equal(localFileTarget("demo.js:12"), "demo.js");
  for (const href of ["javascript:alert(1)", "data:text/html,fixture", "mailto:test@example.invalid", "#section"]) assert.equal(localFileTarget(href), null);
  assert.equal(localFileTarget("sandbox:/mnt/data/demo.pdf"), "sandbox:/mnt/data/demo.pdf");
});

test("Windows 路径恢复只读取链接目标，不把标签中的路径替换为附件", () => {
  const label = "C:\\example\\.codex\\label.png", actual = "D:\\project\\.codex\\actual.png";
  assert.deepEqual(fileReferences("[`示例](" + label + ")`](https://example.com)"), []);
  assert.deepEqual(fileReferences("[![图](<" + label + ">)](https://example.com)"), []);
  assert.deepEqual(fileReferences("[`示例](" + label + ")`](<" + actual + ">)"), [actual]);
  const titlePath = actual.replace("actual.png", "act\\ual.png");
  assert.deepEqual(fileReferences('[图片](<' + actual + '> "示例](' + titlePath + ')")'), [actual]);
  const collision = actual.replace("\\.codex", ".codex");
  assert.deepEqual(fileReferences('[图片](<' + actual + '> "示例](' + collision + ')")'), [actual]);
});

test("独立 Markdown 本地路径可登记，命令和网页不是文件引用", () => {
  for (const ref of ["docs/说明.md", "C:\\User Files\\说明.md", "/C:/User Files/说明.md:12", "file:///C:/docs/readme.md", "/project/readme.md", "README.md"]) {
    assert.equal(markdownPathReference(ref), ref);
    assert.deepEqual(fileReferences(ref), [ref]);
  }
  for (const ref of ["cat docs/readme.md", "npm run docs/readme.md", "https://example.invalid/readme.md"]) assert.equal(markdownPathReference(ref), null);
  assert.deepEqual(fileReferences("[README.md](docs/README.md)"), ["docs/README.md"], "链接标签不能重复登记或占用引用额度");
  assert.deepEqual(fileReferences("```text\ndocs/README.md\n```"), []);
});
