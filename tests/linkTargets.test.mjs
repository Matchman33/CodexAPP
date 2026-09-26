import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileAttachments, fileReferences } from "../core/fileAttachments.mjs";
import { localFileTarget, webLinkTarget } from "../core/linkTargets.mjs";

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
