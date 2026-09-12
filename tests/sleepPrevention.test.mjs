import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SleepPrevention, WINDOWS_SLEEP_SCRIPT, createSleepPrevention } from "../core/sleepPrevention.mjs";

function fixture({ behavior = "ready", ...options } = {}) {
  const children = [], calls = [], logs = [];
  const lifetime = new EventEmitter();
  const spawnHelper = (...args) => {
    calls.push(args);
    if (behavior === "throw") throw new Error("spawn denied");
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0; child.unrefs = 0;
    child.unref = () => { child.unrefs++; };
    child.kill = () => { child.kills++; queueMicrotask(() => child.emit("close", 1)); return true; };
    child.stdin.on("finish", () => { if (behavior !== "ignoreStop") queueMicrotask(() => child.emit("close", 0)); });
    children.push(child);
    setImmediate(() => {
      if (behavior === "exit") { child.stderr.write("API failed"); child.emit("close", 1); }
      else if (behavior !== "timeout") { child.stdout.write('noise\n{"event":"rea'); child.stdout.write('dy"}\n'); }
    });
    return child;
  };
  const guard = new SleepPrevention({ platform: "win32", spawnHelper, lifetime, logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) }, ...options });
  return { guard, children, calls, logs, lifetime };
}

test("native script holds a continuous system request, permits screen-off and releases on EOF", () => {
  assert.match(WINDOWS_SLEEP_SCRIPT, /SystemRequired = 0x00000001/);
  assert.match(WINDOWS_SLEEP_SCRIPT, /Continuous = 0x80000000/);
  assert.match(WINDOWS_SLEEP_SCRIPT, /Console.ReadLine\(\)/);
  assert.match(WINDOWS_SLEEP_SCRIPT, /finally[\s\S]*SetThreadExecutionState\(Continuous\)/);
  assert.equal(/DisplayRequired|powercfg|ES_AWAYMODE_REQUIRED|0x00000002/.test(WINDOWS_SLEEP_SCRIPT), false);
});

test("disabled and non-Windows services do not spawn or modify power settings", async () => {
  for (const options of [{ enabled: false }, { platform: "linux" }, { platform: "darwin" }]) {
    const { guard, calls } = fixture(options);
    await guard.start(); await guard.stop();
    assert.equal(calls.length, 0);
    assert.equal(guard.status().active, false);
  }
  assert.equal(createSleepPrevention({ preventSleep: false }).status().enabled, false);
});

test("startup waits for native acknowledgement, is idempotent and launches hidden", async () => {
  const { guard, calls, children, lifetime } = fixture();
  const first = guard.start(); const second = guard.start();
  assert.equal(first, second);
  assert.equal(guard.status().active, false);
  assert.equal((await first).active, true);
  await guard.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].windowsHide, true);
  assert.deepEqual(calls[0][2].stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(children[0].unrefs, 1);
  assert.equal(lifetime.listenerCount("exit"), 1);
  await guard.stop();
  assert.equal(guard.status().active, false);
  assert.equal(children[0].kills, 0);
  assert.equal(lifetime.listenerCount("exit"), 0);
});

test("startup failures remain non-fatal but never report an active blocker", async () => {
  for (const behavior of ["throw", "exit", "timeout"]) {
    const { guard, logs } = fixture({ behavior, startupTimeout: 20 });
    const status = await guard.start();
    assert.equal(status.active, false);
    assert.ok(status.error);
    assert.match(logs[0], /unavailable/);
    await guard.stop();
  }
});

test("unexpected helper termination clears active status and permits a clean restart", async () => {
  const { guard, children, logs } = fixture();
  await guard.start(); children[0].emit("close", 1);
  assert.equal(guard.status().active, false);
  assert.match(guard.status().error, /unexpectedly/);
  assert.match(logs.at(-1), /unexpectedly/);
  await guard.start();
  assert.equal(children.length, 2);
  assert.equal(guard.status().error, null);
  await guard.stop();
});

test("shutdown during startup and repeated shutdowns release the same helper", async () => {
  const { guard, children } = fixture();
  const start = guard.start(); const stop = guard.stop();
  assert.equal(stop, guard.stop());
  await start; await stop;
  assert.equal(children.length, 1);
  assert.equal(guard.status().active, false);
  await guard.stop();
});

test("an unresponsive helper is stopped by its own process handle only", async () => {
  const { guard, children } = fixture({ behavior: "ignoreStop", stopTimeout: 20 });
  await guard.start(); await guard.stop();
  assert.equal(children[0].kills, 1);
  assert.equal(guard.status().active, false);
});

test("normal parent exit terminates only its helper and removes its exit listener", async () => {
  const { guard, children, lifetime } = fixture();
  await guard.start(); lifetime.emit("exit");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children[0].kills, 1);
  assert.equal(guard.status().active, false);
  assert.equal(lifetime.listenerCount("exit"), 0);
});
