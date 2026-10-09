import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { CodexBridge } from "../core/codexBridge.mjs";
import { FileAttachments } from "../core/fileAttachments.mjs";
import { itemToEvent, historyEvents } from "../core/threadDisplay.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=";
function fixture() {
  const messages = [], replies = [], bridge = new CodexBridge({ defaultCwd: os.tmpdir() }, message => messages.push(message));
  Object.assign(bridge.state, { threadId: "one", turnId: "turn", status: "running", codexConnected: true });
  bridge.codex.respond = (id, result) => replies.push({ id, result: JSON.parse(JSON.stringify(result)) });
  bridge.codex.respondError = (id, code, message) => replies.push({ id, code, message });
  return { bridge, messages, replies };
}

test("工具内嵌图片只传附件元数据，点击读取可还原图片且隔离会话", async () => {
  const files = new FileAttachments(); files.remember("one", os.tmpdir());
  for (const item of [
    { type: "mcpToolCall", server: "fixture", tool: "image", result: { content: [{ type: "image", mimeType: "image/png", data: png }] } },
    { type: "dynamicToolCall", tool: "image", contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64," + png }] },
    { type: "imageGeneration", status: "completed", result: png },
    { type: "mcpToolCall", result: { content: [{ type: "resource", resource: { uri: "fixture://image", mimeType: "image/png", blob: png } }] } },
  ]) {
    const event = files.decorateEvent({ ...itemToEvent(item), threadId: "one" }, { threadId: "one", cwd: os.tmpdir() });
    assert.equal(event.files?.length, 1);
    assert.equal(event.files[0].preview, true);
    assert(!JSON.stringify(event).includes(png), "聊天事件不能包含图片正文");
    const chunk = await files.read({ attachmentId: event.files[0].id, threadId: "one" });
    assert.equal(chunk.data, png);
    await assert.rejects(files.read({ attachmentId: event.files[0].id, threadId: "other" }), /附件/);
  }
  files.forget("one"); assert.equal(files.entries.size, 0);
});

test("工具图片拒绝伪造 MIME、远程地址和过大的载荷", () => {
  const files = new FileAttachments(); files.remember("one", os.tmpdir());
  for (const image of [
    { type: "image", mimeType: "image/jpeg", data: png },
    { type: "inputImage", imageUrl: "https://example.com/private.png" },
    { type: "image", mimeType: "image/png", data: "a".repeat(12 * 1024 * 1024) },
  ]) {
    const event = files.decorateEvent(itemToEvent({ type: "mcpToolCall", result: { content: [image] } }), { threadId: "one", cwd: os.tmpdir() });
    assert(!event.files?.length);
    assert(!JSON.stringify(event).includes("a".repeat(1024)));
  }
});

test("实时事件登记工具图片后不会在事件日志中保留 Base64", () => {
  const { bridge, messages } = fixture();
  bridge._onNotification({ method: "item/completed", params: { threadId: "one", turnId: "turn", item: { id: "image", type: "mcpToolCall", result: { content: [{ type: "image", mimeType: "image/png", data: png }] } } } });
  assert.equal(messages.find(m => m.type === "event").event.files?.length, 1);
  assert(!JSON.stringify(bridge.eventLog).includes(png));
});

test("选择题恢复待回答状态、校验答案后按 Codex 协议回应", async () => {
  const { bridge, replies } = fixture();
  bridge._onServerRequest({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "one", turnId: "turn", itemId: "ask", questions: [{ id: "choice", header: "选择", question: "采用哪种方案？", isOther: true, isSecret: false, options: [{ label: "方案 A", description: "描述" }] }, { id: "secret", header: "输入", question: "输入值", isOther: false, isSecret: true, options: null }] } });
  assert.equal(replies.length, 0);
  const a = bridge.snapshot().pendingApprovals[0]; assert.equal(a.kind, "question");
  await assert.rejects(bridge.dispatch({ type: "interactionResponse", key: a.key, answers: { choice: { answers: [] } } }), /回答/);
  assert.equal(bridge.pendingApprovals.size, 1);
  await assert.rejects(bridge.dispatch({ type: "approval", key: a.key, optionId: "approve" }), /回答/);
  await bridge.dispatch({ type: "interactionResponse", key: a.key, answers: { choice: { answers: ["方案 A"] }, secret: { answers: ["sensitive-value"] } } });
  assert.deepEqual(replies, [{ id: 7, result: { answers: { choice: { answers: ["方案 A"] }, secret: { answers: ["sensitive-value"] } } } }]);
  assert.equal(bridge.pendingApprovals.size, 0);
  assert(!JSON.stringify(bridge.eventLog).includes("sensitive-value"));
});

test("MCP 表单校验字段类型和枚举，取消和授权链接按协议响应", async () => {
  const { bridge, replies } = fixture();
  bridge._onServerRequest({ id: 8, method: "mcpServer/elicitation/request", params: { threadId: "one", mode: "form", serverName: "fixture", message: "填写参数", requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 3 }, mode: { type: "string", enum: ["fast", "safe"] } }, required: ["count", "mode"] } } });
  const a = bridge.snapshot().pendingApprovals[0]; assert.equal(a.kind, "form");
  await assert.rejects(bridge.dispatch({ type: "interactionResponse", key: a.key, action: "accept", content: { count: 4, mode: "safe" } }), /count/);
  await assert.rejects(bridge.dispatch({ type: "interactionResponse", key: a.key, action: "accept", content: { count: 1, mode: "wrong" } }), /mode/);
  await bridge.dispatch({ type: "interactionResponse", key: a.key, action: "accept", content: { count: 2, mode: "safe" } });
  assert.deepEqual(replies[0], { id: 8, result: { action: "accept", content: { count: 2, mode: "safe" }, _meta: null } });
  bridge._onServerRequest({ id: 9, method: "mcpServer/elicitation/request", params: { threadId: "one", mode: "url", serverName: "fixture", message: "登录", url: "https://example.com/auth", elicitationId: "auth" } });
  const link = bridge.snapshot().pendingApprovals[0]; assert.equal(link.kind, "url"); assert.equal(link.url, "https://example.com/auth");
  await bridge.dispatch({ type: "interactionResponse", key: link.key, action: "cancel" });
  assert.deepEqual(replies[1].result, { action: "cancel", content: null, _meta: null });
});

test("服务器已解决提问后不能再提交过期答案", async () => {
  const { bridge, replies } = fixture();
  bridge._onServerRequest({ id: 10, method: "item/tool/requestUserInput", params: { threadId: "one", questions: [{ id: "q", question: "继续？", options: null }] } });
  const key = bridge.snapshot().pendingApprovals[0].key;
  bridge._onNotification({ method: "serverRequest/resolved", params: { requestId: 10 } });
  await assert.rejects(bridge.dispatch({ type: "interactionResponse", key, answers: { q: { answers: ["继续"] } } }), /失效/);
  assert.equal(replies.length, 0);
});

test("未知消息保留可读内容且不输出二进制或凭据", () => {
  const item = { type: "futureMessage", id: "new", text: "新增结果", details: { token: "sensitive-value", client_secret: "sensitive-client-secret", data: "a".repeat(50000) } };
  const event = itemToEvent(item);
  assert(event.text.includes("新增结果")); assert(event.text.includes("futureMessage"));
  assert(event.text.length <= 8192); assert(!event.text.includes("sensitive-value")); assert(!event.text.includes("a".repeat(1024)));
  assert(!event.text.includes("sensitive-client-secret"));
  assert.equal(historyEvents({ id: "one", turns: [{ id: "turn", items: [item] }] }).length, 1);
  assert(itemToEvent({ type: "functionCallOutput", name: "tool", output: "工具实际结果" }).text.includes("工具实际结果"));
  const { bridge } = fixture();
  bridge._onNotification({ method: "warning", params: { threadId: "one", message: "配置提示" } });
  assert(bridge.eventLog.some(e => e.text.includes("配置提示")));
  assert(itemToEvent({ type: "futureTool", result: { content: { text: "新对象格式" } }, contentItems: [null, { type: "futureContent" }] }).text.includes("新对象格式"));
});

test("不支持的 JSON Schema 约束明确报错，不将无效表单作为已回答", async () => {
  const { bridge, replies } = fixture();
  bridge._onServerRequest({ id: 20, method: "mcpServer/elicitation/request", params: { mode: "openai/form", threadId: "one", requestedSchema: { type: "object", properties: { n: { type: "integer" } }, allOf: [{ properties: { n: { minimum: 10 } } }] } } });
  const a = bridge.snapshot().pendingApprovals[0];
  await assert.rejects(bridge.dispatch({ type: "interactionResponse", key: a.key, action: "accept", content: { n: 1 } }), /支持/);
  assert.equal(replies.length, 0);
  await bridge.dispatch({ type: "interactionResponse", key: a.key, action: "decline" });
  assert.equal(replies[0].result.action, "decline");
});

test("表单分支不能覆盖父约束，官方带标题的单选和多选枚举可提交", async () => {
  const { bridge, replies } = fixture();
  bridge._onServerRequest({ id: 21, method: "mcpServer/elicitation/request", params: { mode: "openai/form", threadId: "one", requestedSchema: { type: "object", properties: { n: { type: "number", minimum: 10, oneOf: [{ minimum: 0, maximum: 20 }] } } } } });
  let a = bridge.snapshot().pendingApprovals[0];
  await assert.rejects(bridge.dispatch({ type: "interactionResponse", key: a.key, action: "accept", content: { n: 1 } }));
  await bridge.dispatch({ type: "interactionResponse", key: a.key, action: "cancel" });
  bridge._onServerRequest({ id: 22, method: "mcpServer/elicitation/request", params: { mode: "form", threadId: "one", requestedSchema: { type: "object", properties: { mode: { type: "string", minLength: 3, oneOf: [{ const: "safe", title: "安全" }, { const: "fast", title: "快速" }] }, tags: { type: "array", minItems: 1, items: { anyOf: [{ const: "a", title: "选项 A" }, { const: "b", title: "选项 B" }] } } } } } });
  a = bridge.snapshot().pendingApprovals[0];
  await bridge.dispatch({ type: "interactionResponse", key: a.key, action: "accept", content: { mode: "safe", tags: ["a", "b"] } });
  assert.deepEqual(replies[1].result.content, { mode: "safe", tags: ["a", "b"] });
});

test("历史分页切换项目后只登记新项目的相对文件", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-message-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = path.join(dir, "old"), current = path.join(dir, "current"); fs.mkdirSync(old); fs.mkdirSync(current);
  fs.writeFileSync(path.join(old, "result.txt"), "旧项目内容"); fs.writeFileSync(path.join(current, "result.txt"), "新项目内容");
  const bridge = new CodexBridge({ defaultCwd: old }, () => {}); bridge.state.codexConnected = true;
  bridge.codex.request = async method => {
    if (method === "thread/read") return { thread: { id: "new", cwd: current } };
    if (method === "thread/turns/list") return { data: [{ id: "turn", status: "completed" }], nextCursor: null };
    return { data: [{ id: "file", type: "agentMessage", text: "[文件](result.txt)" }, { id: "image", type: "mcpToolCall", result: { content: [{ type: "image", data: png, mimeType: "image/png" }] } }], nextCursor: null };
  };
  await bridge.dispatch({ type: "readThread", threadId: "new", historyMode: "paged" });
  const events = bridge.snapshot().recentEvents;
  const file = events.find(e => e.itemId === "file"); assert.equal(file.files.length, 1);
  assert.equal(Buffer.from((await bridge.files.read({ attachmentId: file.files[0].id, threadId: "new" })).data, "base64").toString(), "新项目内容");
  assert.equal(events.find(e => e.itemId === "image").files.length, 1);
  assert(!JSON.stringify(bridge.eventLog).includes(png));
});

test("计划增量复用同一条消息，工具进度不会无限增加日志", () => {
  const { bridge } = fixture();
  for (let i = 0; i < 100; i++) {
    bridge._onNotification({ method: "item/plan/delta", params: { threadId: "one", turnId: "turn", itemId: "plan", delta: "步骤" } });
    bridge._onNotification({ method: "item/mcpToolCall/progress", params: { threadId: "one", turnId: "turn", itemId: "tool", message: "进度 " + i } });
  }
  assert.equal(bridge.eventLog.length, 2);
  assert.equal(bridge.eventLog.find(e => e.itemId === "plan").text, "步骤".repeat(100));
  assert(bridge.eventLog.some(e => e.text.includes("进度 99")));
});
