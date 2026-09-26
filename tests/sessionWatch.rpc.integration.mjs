import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { CodexBridge, resolveCodexBin } from "../core/codexBridge.mjs";
import { HistoryPager } from "../core/historyPaging.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-watch-rpc-"));
const previous = process.env.CODEX_HOME;
process.env.CODEX_HOME = dir;
const bridges = [], turns = [];
let responses = 0;
// The real Codex processes only call this local model fixture, never a public model API.
const model = http.createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  if (!req.url.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'); return; }
  const text = ++responses === 1 ? "watch-initial-fixture" : "watch-updated-fixture";
  const id = "resp_" + responses, item = { id: "msg_" + responses, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = value => res.write("event: " + value.type + "\ndata: " + JSON.stringify(value) + "\n\n");
  event({ type: "response.created", response: { id, status: "in_progress", output: [] } });
  event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event({ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  event({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text });
  event({ type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text });
  event({ type: "response.output_item.done", output_index: 0, item });
  event({ type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } });
  res.end();
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
try {
  await fs.writeFile(path.join(dir, "config.toml"), 'model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local test fixture"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:' + model.address().port + '/v1"\nrequires_openai_auth = false\n');
  const bin = resolveCodexBin(process.env.CODEX_BIN); assert(bin, "Codex executable is required");
  for (let i = 0; i < 2; i++) {
    const b = new CodexBridge({ codexBin: bin, defaultCwd: dir }, () => {});
    bridges.push(b); await b.start(); b.codex.onExit = () => {};
  }
  const [writer, reader] = bridges;
  writer.codex.onNotification = m => { if (m.method === "turn/completed") turns.push(m.params.turn); };
  const { thread } = await writer.codex.request("thread/start", { cwd: dir, model: "gpt-5.4", sandbox: "read-only", approvalPolicy: "never" });
  const turn = async () => {
    const count = turns.length;
    await writer.codex.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "local fixture only", text_elements: [] }] });
    for (let i = 0; i < 200 && turns.length === count; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(turns.length, count + 1, "Local fixture turn timed out");
    assert.equal(turns.at(-1).status, "completed", JSON.stringify(turns.at(-1).error));
  };
  await turn();
  const pager = new HistoryPager(reader.codex), first = await pager.open(thread.id);
  assert(JSON.stringify(first.events).includes("watch-initial-fixture"));
  await turn();
  let second;
  for (let i = 0; i < 30; i++) {
    second = await pager.open(thread.id);
    if (JSON.stringify(second.events).includes("watch-updated-fixture")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(JSON.stringify(second.events).includes("watch-updated-fixture"), "Reader must observe another process's new turn without resume");
  const loaded = await reader.codex.request("thread/loaded/list", {});
  assert(!loaded.data.includes(thread.id), "Polling must not acquire a writer");
  console.log("PASS: real Codex writer and reader, two local fixture turns, external history refresh without resume; public model calls: 0");
} finally {
  for (const b of bridges) {
    b.codex.onExit = () => {};
    if (b.codex.child?.exitCode === null && b.codex.child.signalCode === null) { const closed = once(b.codex.child, "close"); b.codex.child.stdin.end(); await closed; }
  }
  await new Promise(resolve => model.close(resolve));
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("codexapp-watch-rpc-")) throw new Error("Invalid cleanup directory");
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
