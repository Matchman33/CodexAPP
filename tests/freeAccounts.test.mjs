import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("旧会员账号迁移为免费账号，停用与密码重置独立，历史计费数据不丢失", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexapp-free-"));
  try {
    const source = `
      import { DatabaseSync } from 'node:sqlite';
      import assert from 'node:assert/strict';
      const legacy = new DatabaseSync(process.env.DB_PATH);
      legacy.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY,email TEXT UNIQUE,salt TEXT,hash TEXT,email_verified INTEGER,verify_token TEXT,verify_expires INTEGER,created_at INTEGER,membership_until INTEGER); CREATE TABLE codes (code TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('old','old@example.com','salt','hash',1,NULL,NULL,1,1); INSERT INTO codes VALUES ('legacy-code');");
      legacy.close();
      const db = await import(${JSON.stringify(new URL("../cloud/db.mjs", import.meta.url).href)});
      assert.equal(db.getById('old').disabled, 0);
      assert.equal(db.getById('old').membership_until, 1);
      assert.equal(db.counts().enabled, 1);
      db.setDisabled('old', true);
      assert.equal(db.getById('old').disabled, 1);
      assert.equal(db.getById('old').auth_version, 1);
      db.updatePassword('old', 'new-salt', 'new-hash');
      assert.equal(db.getById('old').disabled, 1);
      db.setDisabled('old', false);
      assert.equal(db.getById('old').disabled, 0);
      assert.equal(db.getById('old').auth_version, 3);
      assert.equal(db.getById('old').membership_until, 1);
      const check = new DatabaseSync(process.env.DB_PATH);
      assert.equal(check.prepare('SELECT code FROM codes').get().code, 'legacy-code');
      check.close();
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, DB_PATH: path.join(dir, "accounts.db") }, encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith("codexapp-free-"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
