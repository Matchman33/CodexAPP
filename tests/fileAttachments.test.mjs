import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { FileAttachments, FILE_LIMITS, fileReferences } from "../core/fileAttachments.mjs";
import { itemToEvent } from "../core/threadDisplay.mjs";
import { HistoryPager } from "../core/historyPaging.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";
import { newKeyPair, seal, open } from "../cloud/e2e.mjs";

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-files-")), root = path.join(temp, "project"); fs.mkdirSync(root);
  t.after(() => { const resolved = path.resolve(temp); assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert(path.basename(resolved).startsWith("codexapp-files-")); fs.rmSync(resolved, { recursive: true, force: true }); });
  const store = new FileAttachments(); store.remember("one", root);
  const write = (name, data = "fixture") => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
  return { temp, root, store, write };
}

test("Markdown 文件引用保留空格、中文、绝对路径和行内代码，完成事件与图片生成结果携带引用", () => {
  assert.deepEqual(fileReferences("[表格](<exports/报表 v1.xlsx>) `exports/a.pdf` ![图](exports/a.png)"), ["exports/报表 v1.xlsx", "exports/a.pdf", "exports/a.png"]);
  assert.deepEqual(itemToEvent({ type: "imageGeneration", savedPath: "out/a.png", status: "completed" }).fileRefs, ["out/a.png"]);
  assert.deepEqual(itemToEvent({ type: "fileChange", changes: [{ path: "a.xlsx", kind: { type: "add" } }, { path: "gone.pdf", kind: { type: "delete" } }] }).fileRefs, ["a.xlsx"]);
});
test("同一文件的相对和绝对链接都映射到同一附件", t => {
  const { root, store, write } = fixture(t), absolute = write("chart.png");
  const result = store.decorateEvent({ kind: "item:agentMessage", threadId: "one", fileRefs: ["chart.png", absolute] }, { cwd: root, threadId: "one" });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0].references, ["chart.png", absolute]);
});
test("附件必须被登记并绑定会话，二进制分块与原文件逐字节一致", async t => {
  const { store, write } = fixture(t), bytes = crypto.randomBytes(FILE_LIMITS.chunkBytes * 2 + 17);
  write("exports/报表.xlsx", bytes);
  const file = store.register("exports/报表.xlsx", "one"); assert(file);
  assert.equal(file.size, bytes.length); assert.equal(file.name, "报表.xlsx");
  const chunks = []; let offset = 0;
  do { const chunk = await store.read({ attachmentId: file.id, threadId: "one", offset, requestId: "chunk" }); chunks.push(Buffer.from(chunk.data, "base64")); offset = chunk.nextOffset; } while (offset !== null);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await assert.rejects(store.read({ attachmentId: file.id, threadId: "other" }));
  await assert.rejects(store.read({ attachmentId: "exports/报表.xlsx", threadId: "one" }));
  for (const offset of [-1, 1, 0.5, bytes.length + 1, Infinity]) await assert.rejects(store.read({ attachmentId: file.id, threadId: "one", offset }));
});
test("拒绝目录穿越、网络路径、凭据、隐藏目录、硬链接与超大文件", t => {
  const { store, write, root, temp } = fixture(t);
  fs.writeFileSync(path.join(temp, "outside.txt"), "private");
  write("codexapp.config.json"); write(".env"); write(".codex/auth.json"); write("secret.pem"); write("normal.txt");
  for (const reference of ["../outside.txt", "..%2Foutside.txt", path.join(temp, "outside.txt"), "https://example.invalid/a.xlsx", "\\\\server\\share\\a.pdf", "codexapp.config.json", ".codex/auth.json", ".env", "secret.pem", "normal.txt:secret", "data:text/plain,abc"]) assert.equal(store.register(reference, "one"), null, reference);
  fs.linkSync(path.join(temp, "outside.txt"), path.join(root, "hardlink.txt"));
  assert.equal(store.register("hardlink.txt", "one"), null);
  const big = write("big.zip"); fs.truncateSync(big, FILE_LIMITS.maxBytes + 1);
  assert.equal(store.register("big.zip", "one"), null);
});
test("符号链接指向项目外时不能登记，登记后切换目标也不能继续读取", async t => {
  const { store, write, root, temp } = fixture(t);
  write("inside/a.txt", "inside"); const outside = path.join(temp, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "a.txt"), "outside");
  const link = path.join(root, "link"); fs.symlinkSync(path.join(root, "inside"), link, process.platform === "win32" ? "junction" : "dir");
  const file = store.register("link/a.txt", "one"); assert(file);
  fs.unlinkSync(link); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.read({ attachmentId: file.id, threadId: "one" }));
  assert.equal(store.register("link/a.txt", "one"), null);
});
test("项目本身是目录链接时，仍允许工作目录内文件且拒绝外部目标", async t => {
  const { store, write, root, temp } = fixture(t); write("result.txt", "inside");
  const alias = path.join(temp, "workspace-alias"); fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    store.remember("alias", alias);
    const file = store.register(path.join(alias, "result.txt"), "alias"); assert(file);
    assert.equal(Buffer.from((await store.read({ attachmentId: file.id, threadId: "alias" })).data, "base64").toString(), "inside");
    assert.equal(store.register("../private.txt", "alias"), null);
  } finally { fs.unlinkSync(alias); }
});
test("大量外部链接不会挤掉本地附件名额，已完成工具事件推送可下载文件", t => {
  const { root, write } = fixture(t); write("result.xlsx");
  const text = Array(20).fill("[外链](https://example.invalid/file.xlsx)").join("\n") + "\n[报表](result.xlsx)";
  assert.deepEqual(fileReferences(text), ["result.xlsx"]);
  const messages = [], bridge = new CodexBridge({ defaultCwd: root }, message => messages.push(message));
  Object.assign(bridge.state, { threadId: "one", turnId: "turn", cwd: root, readOnly: false });
  bridge._onNotification({ method: "item/completed", params: { threadId: "one", turnId: "turn", item: { id: "change", type: "fileChange", status: "completed", changes: [{ path: "result.xlsx", kind: { type: "add" } }] } } });
  assert.equal(messages.find(m => m.type === "event").event.files[0].name, "result.xlsx");
});
test("文件变化、删除和会话删除使旧附件失效，空文件仍可下载", async t => {
  const { store, write } = fixture(t);
  const target = write("a.txt"), file = store.register("a.txt", "one");
  fs.writeFileSync(target, "changed");
  // 紧邻的同尺寸写入可能共享文件时间戳，显式推进时间以验证元数据变更。
  const changedAt = new Date(Date.now() + 2000); fs.utimesSync(target, changedAt, changedAt);
  await assert.rejects(store.read({ attachmentId: file.id, threadId: "one" }), /变化/);
  const updated = store.register("a.txt", "one"); assert.notEqual(updated.id, file.id);
  fs.unlinkSync(target); await assert.rejects(store.read({ attachmentId: updated.id, threadId: "one" }));
  write("empty.txt", ""); const empty = store.register("empty.txt", "one");
  assert.equal((await store.read({ attachmentId: empty.id, threadId: "one" })).data, "");
  store.forget("one"); await assert.rejects(store.read({ attachmentId: empty.id, threadId: "one" }));
});
test("历史分页不会因长文本截断而丢失后部附件引用，普通用户文字不能登记附件", async t => {
  const { root, store, write } = fixture(t); write("result.xlsx");
  const text = "x".repeat(20000) + "\n\n[表格](result.xlsx)";
  const pager = new HistoryPager({ request: async method => method === "thread/turns/list" ? { data: [{ id: "turn", status: "completed" }], nextCursor: null } : { data: [{ id: "assistant", type: "agentMessage", text }], nextCursor: null } });
  const page = await pager.page("one");
  const response = store.decorate({ type: "historyPage", ...page }, { threadId: "one", cwd: root });
  assert(response.events[0].truncated); assert.equal(response.events[0].files[0].name, "result.xlsx");
  assert.equal(store.decorateEvent({ kind: "user", text: "[表格](result.xlsx)", threadId: "one" }, {}).files, undefined);
});
test("云桥接附件不阻塞任务控制队列，快照可恢复且文件分块经 E2E 原样往返", async t => {
  const { root, write } = fixture(t); write("chart.png", Buffer.from([137,80,78,71,13,10,26,10]));
  const messages = [], bridge = new CodexBridge({ defaultCwd: root }, message => messages.push(message));
  Object.assign(bridge.state, { threadId: "one", cwd: root });
  bridge.eventLog = [{ id: "event", kind: "item:agentMessage", threadId: "one", text: "[图](chart.png)" }];
  const first = bridge.snapshot(), second = bridge.snapshot(); assert.equal(first.fileDownloads.supported, true);
  assert.equal(first.recentEvents[0].files[0].id, second.recentEvents[0].files[0].id);
  bridge.commandQueue = new Promise(() => {});
  const file = first.recentEvents[0].files[0];
  await bridge.dispatch({ type: "readAttachment", attachmentId: file.id, threadId: "one", requestId: "file" });
  const chunk = messages.at(-1), a = newKeyPair(), b = newKeyPair();
  assert.equal(chunk.type, "attachmentChunk");
  assert.deepEqual(open(seal(chunk, b.publicKey, a.secretKey), a.publicKey, b.secretKey), chunk);
});
