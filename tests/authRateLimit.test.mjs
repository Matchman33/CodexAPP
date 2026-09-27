import test from "node:test";
import assert from "node:assert/strict";
import { createAuthRateLimit } from "../cloud/authRateLimit.mjs";

test("登录仍限制为十五分钟八次，被拒绝的重试不延长窗口", () => {
  let time = 0;
  const limit = createAuthRateLimit({ now: () => time });
  for (let i = 0; i < 8; i++) assert.equal(limit("ip|email"), 0);
  assert.equal(limit("ip|email"), 900);
  time = 899000;
  for (let i = 0; i < 100; i++) assert.equal(limit("ip|email"), 1);
  time = 900000;
  assert.equal(limit("ip|email"), 0);
});

test("等待时间以最早的有效请求为准，不影响其他限流键", () => {
  let time = 0;
  const limit = createAuthRateLimit({ now: () => time });
  for (let i = 0; i < 8; i++) { time = i * 1000; assert.equal(limit("ip|email"), 0); }
  time = 7500;
  assert.equal(limit("ip|email"), 893);
  assert.equal(limit("ip|other"), 0);
  time = 900000;
  assert.equal(limit("ip|email"), 0);
  assert.equal(limit("ip|email"), 1);
});
