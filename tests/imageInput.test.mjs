import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeImages, buildUserInput, imageEcho, historyImages, IMAGE_LIMITS } from "../core/imageInput.mjs";
import { PromptQueue } from "../core/promptQueue.mjs";
import { CodexBridge } from "../core/codexBridge.mjs";
import { itemToEvent } from "../core/threadDisplay.mjs";
import { HistoryPager } from "../core/historyPaging.mjs";
import { seal, open, newKeyPair } from "../cloud/e2e.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE0kAAAAASUVORK5CYII=";
const photo = { name: "capture.png", dataUrl: png, previewDataUrl: png };
function fixture() {
  const events = [], calls = [];
  const bridge = new CodexBridge({ defaultCwd: "/fixture", approvalPolicy: "on-request", sandbox: "read-only" }, message => events.push(structuredClone(message)));
  Object.assign(bridge.state, { threadId: "one", codexConnected: true, status: "idle" });
  bridge.models.resolve = async () => "fixture-model"; bridge.models.resolveEffort = async () => null;
  bridge.codex.request = async (method, params) => { calls.push({ method, params }); return { turn: { id: "turn-one" } }; };
  return { bridge, events, calls };
}

test("图片输入支持图文和纯图片，不向 Codex 传递文件名或缩略图", () => {
  assert.deepEqual(buildUserInput("inspect", [photo]), [{ type: "text", text: "inspect", text_elements: [] }, { type: "image", url: png }]);
  assert.deepEqual(buildUserInput("", [photo]), [{ type: "image", url: png }]);
  assert.throws(() => buildUserInput("", []));
});
test("图片输入拒绝远程 URL、路径、SVG、伪造格式、超限数量和无效缩略图", () => {
  for (const dataUrl of ["https://example.invalid/a.png", "C:/secret.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,PHNjcmlwdD4=", png + "!"]) assert.throws(() => normalizeImages([{ dataUrl }]));
  assert.throws(() => normalizeImages(Array(5).fill(photo)));
  assert.throws(() => normalizeImages([{ ...photo, previewDataUrl: "javascript:alert(1)" }]));
  assert.equal(normalizeImages([{ ...photo, name: "C:/folder/a.png" }])[0].name, "a.png");
  assert.throws(() => normalizeImages([{ dataUrl: "data:image/png;base64," + Buffer.alloc(IMAGE_LIMITS.bytes + 1).toString("base64") }]));
});
test("图片队列受理幂等，改变图片内容时拒绝复用请求 ID，快照不包含原图", () => {
  const state = { threadId: "one", status: "running", codexConnected: true };
  const queue = new PromptQueue({ getState: () => state, execute: async () => {} });
  const message = { requestId: "image", threadId: "one", text: "", images: [photo] };
  assert.deepEqual(queue.enqueue(message), queue.enqueue(message));
  assert.equal(queue.snapshot().items.length, 1);
  assert.equal(queue.snapshot().items[0].images[0].url, png);
  assert.equal(queue.snapshot().items[0].images[0].dataUrl, undefined);
  assert.throws(() => queue.enqueue({ ...message, images: [{ ...photo, name: "different.png" }] }));
  queue.cancel("one", "image"); assert.equal(queue.snapshot().items.length, 0);
});
test("图片队列总容量有界", () => {
  const bytes = Buffer.alloc(IMAGE_LIMITS.bytes); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const large = { dataUrl: "data:image/png;base64," + bytes.toString("base64") };
  const queue = new PromptQueue({ getState: () => ({ threadId: "one", status: "running" }), execute: async () => {} });
  for (let i = 0; i < 4; i++) queue.enqueue({ requestId: "large-" + i, threadId: "one", text: "", images: Array(4).fill(large) });
  assert.throws(() => queue.enqueue({ requestId: "overflow", threadId: "one", text: "", images: Array(4).fill(large) }), /图片容量/);
});
test("云端桥接的普通提示词、排队和纠偏均传递图片", async () => {
  const { bridge, calls } = fixture();
  await bridge.dispatch({ type: "prompt", text: "inspect", images: [{ dataUrl: png }] });
  assert.equal(calls[0].params.input[1].url, png);
  await bridge.dispatch({ type: "steer", text: "", images: [{ dataUrl: png }] });
  assert.equal(calls[1].method, "turn/steer"); assert.equal(calls[1].params.input[0].type, "image");
  await bridge.dispatch({ type: "enqueuePrompt", requestId: "queued-image", threadId: "one", text: "", images: [{ dataUrl: png }] });
  bridge._onNotification({ method: "turn/completed", params: { threadId: "one", turn: { id: "turn-one", status: "completed" } } });
  await bridge.commandQueue;
  assert.equal(calls.at(-1).params.input[0].url, png);
  const count = calls.length;
  await assert.rejects(bridge.dispatch({ type: "prompt", images: [{ dataUrl: "http://example.invalid/image" }] }));
  assert.equal(calls.length, count);
});
test("图片消息通过现有 E2E 通道往返，信封不泄露图片原文", () => {
  const sender = newKeyPair(), peer = newKeyPair();
  const message = { type: "enqueuePrompt", text: "", images: [photo] };
  const envelope = seal(message, peer.publicKey, sender.secretKey);
  assert.equal(JSON.stringify(envelope).includes(png), false);
  assert.deepEqual(open(envelope, sender.publicKey, peer.secretKey), message);
});
test("历史不把原图 Base64 当文本，缩略图缓存恢复相同图片身份", () => {
  const previous = process.env.CODEX_HOME, dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-images-"));
  process.env.CODEX_HOME = dir;
  try {
    const echo = imageEcho([photo], true)[0];
    const restored = historyImages([{ type: "image", url: png }])[0];
    assert.deepEqual(restored, echo);
    const event = itemToEvent({ type: "userMessage", content: [{ type: "image", url: png }] });
    assert.equal(event.text, "[图片]"); assert.equal(event.images[0].url, png);
    assert.equal(event.text.includes("base64"), false);
    fs.writeFileSync(path.join(dir, "codexapp-image-previews", echo.id + ".json"), JSON.stringify({ url: "https://example.invalid/tracker" }));
    assert.equal(historyImages([{ type: "image", url: png }])[0].url, undefined);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    for (const file of fs.readdirSync(path.join(dir, "codexapp-image-previews"))) fs.unlinkSync(path.join(dir, "codexapp-image-previews", file));
    fs.rmdirSync(path.join(dir, "codexapp-image-previews")); fs.rmdirSync(dir);
  }
});
test("历史分页的字数预算包含缩略图，避免图片页无限增大", async () => {
  const previous = process.env.CODEX_HOME, dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-image-page-"));
  process.env.CODEX_HOME = dir;
  try {
    const preview = Buffer.alloc(8192); Buffer.from([137,80,78,71,13,10,26,10]).copy(preview);
    imageEcho([{ ...photo, previewDataUrl: "data:image/png;base64," + preview.toString("base64") }], true);
    const pager = new HistoryPager({ request: async method => method === "thread/turns/list" ? { data: [{ id: "turn" }], nextCursor: null } : { data: Array.from({ length: 3 }, (_, i) => ({ id: String(i), type: "userMessage", content: Array(4).fill({ type: "image", url: png }) })), nextCursor: null } });
    const result = await pager.page("one");
    assert.equal(result.events.length, 1); assert.ok(result.nextCursor);
    const next = await pager.page("one", result.nextCursor);
    assert.equal(next.events.length, 1); assert.notEqual(next.events[0].id, result.events[0].id);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    for (const file of fs.readdirSync(path.join(dir, "codexapp-image-previews"))) fs.unlinkSync(path.join(dir, "codexapp-image-previews", file));
    fs.rmdirSync(path.join(dir, "codexapp-image-previews")); fs.rmdirSync(dir);
  }
});
