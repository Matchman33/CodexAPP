import test from "node:test";
import assert from "node:assert/strict";
import { WriterControl } from "../core/writerControl.mjs";
const id = "01a0704b-e9f9-7922-b3a3-203506ce0433";
const owner = { pid: 2345, started: "123", canTerminate: true, affectedThreads: [id] };

test("结束返回后必须再次核实目标会话没有持有者", async () => {
  let exited = false, checks = 0;
  const control = new WriterControl({ platform: "win32", runner: async ({ action }) => {
    if (action === "terminate") { exited = true; return { terminated: true }; }
    if (exited) checks++;
    return { owners: exited ? [] : [owner] };
  } });
  const token = (await control.inspect(id)).owners[0].token;
  await control.terminate(id, token, true);
  assert.equal(checks, 1);
});

test("原进程退出后出现新的持有者时提示重新确认，不结束新进程", async () => {
  let exited = false, kills = 0;
  const control = new WriterControl({ platform: "win32", runner: async ({ action }) => {
    if (action === "terminate") { kills++; exited = true; return { terminated: true }; }
    return { owners: [exited ? { ...owner, pid: 6789, started: "456" } : owner] };
  } });
  const token = (await control.inspect(id)).owners[0].token;
  await assert.rejects(control.terminate(id, token, true), /新的进程/);
  assert.equal(kills, 1);
});
