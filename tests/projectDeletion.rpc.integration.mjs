import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { SessionHub } from "../core/sessionHub.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexapp-project-rpc-"));
const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = dir;
const completed = [], messages = [];
const hub = new SessionHub({ defaultCwd: dir }, m => messages.push(m), undefined, { dataDir: path.join(dir, "app") });
const model = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  if (!req.url.endsWith("/responses")) { res.writeHead(200, {"content-type":"application/json"}).end('{"data":[]}'); return; }
  const id = "resp_fixture", item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{type:"output_text",text:"fixture",annotations:[]}] };
  res.writeHead(200, {"content-type":"text/event-stream"});
  for (const value of [
    {type:"response.created",response:{id,status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
    {type:"response.output_text.delta",output_index:0,item_id:item.id,content_index:0,delta:"fixture"},
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.completed",response:{id,status:"completed",output:[item],usage:{input_tokens:2,output_tokens:2,total_tokens:4}}},
  ]) res.write("event: " + value.type + "\ndata: " + JSON.stringify(value) + "\n\n");
  res.end();
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
try {
  await fs.writeFile(path.join(dir,"config.toml"),'model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local fixture"\nwire_api = "responses"\nbase_url = "http://127.0.0.1:' + model.address().port + '/v1"\nrequires_openai_auth = false\n');
  const client = hub.control.codex; client.start(); client.onExit = () => {};
  client.onNotification = m => { if (m.method === "turn/completed") completed.push(m.params.turn); hub.notification(m); };
  await client.request("initialize", { clientInfo: { name: "project_delete_test", version: "1" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {}); hub.state.codexConnected = true;
  const {project} = await client.request("project/create", { name: "Deletion fixture", roots: [{path:dir}], idempotencyKey: crypto.randomUUID() });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const {thread} = await client.request("thread/start", { cwd: dir, projectId: project.id, model:"gpt-5.4", sandbox:"read-only", approvalPolicy:"never" });
    ids.push(thread.id);
    await client.request("turn/start", {threadId:thread.id,input:[{type:"text",text:"local fixture",text_elements:[]}]});
    for (let n = 0; n < 200 && completed.length <= i; n++) await new Promise(r => setTimeout(r, 50));
    assert.equal(completed[i]?.status, "completed");
    if (i) await client.request("thread/archive", {threadId:thread.id});
  }
  await fs.writeFile(path.join(dir,"keep.txt"),"keep");
  await hub.dispatch({type:"deleteProject",projectId:project.id,confirmed:true,requestId:"fixture"},"fixture");
  assert.equal((await client.request("project/list",{})).data.length,0);
  for (const archived of [false,true]) assert.equal((await client.request("thread/list",{archived,modelProviders:[]})).data.length,0);
  assert.equal(await fs.readFile(path.join(dir,"keep.txt"),"utf8"),"keep");
  assert.deepEqual(messages.find(m=>m.type==='projectDeleted'&&m.requestId==='fixture').threadIds.sort(),ids.sort());
  console.log("PASS: real Codex project and two persisted threads (including archived) deleted through app command; files retained; public model calls: 0");
} finally {
  const child=hub.control.codex.child;
  if(child?.exitCode===null){const closed=once(child,"close");child.stdin.end();await closed;}
  await new Promise(resolve=>model.close(resolve));
  if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;
  assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert(path.basename(dir).startsWith("codexapp-project-rpc-"));
  await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
