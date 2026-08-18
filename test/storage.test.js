import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLITE_APPLICATION_ID } from "../src/constants.js";
import { sha256 } from "../src/ids.js";
import { openStorage } from "../src/storage.js";

test("fresh storage applies the frozen schema and migration", function () {
  const storage = openStorage(":memory:", { create: true, now: 1234 });
  try {
    const status = storage.integrityCheck();
    assert.equal(status.ok, true);
    assert.equal(status.schemaVersion, 3);
    assert.equal(status.applicationId, SQLITE_APPLICATION_ID);
    assert.equal(storage.getSetting("missing"), null);
    assert.equal(storage.setSetting("mode", { route: "both" }, 1234), 1);
    assert.deepEqual(storage.getSetting("mode"), { route: "both" });
  } finally {
    storage.close();
  }
});

test("version-one storage upgrades in place without changing existing rows", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-storage-"));
  const databaseFile = path.join(root, "state.sqlite3");
  const migrationFile = new URL("../migrations/001-initial.sql", import.meta.url);
  const sql = readFileSync(migrationFile, "utf8");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations(version,checksum,package_version,applied_at) VALUES(1,?,?,?)").run(sha256(sql), "0.1.1", 1000);
    db.exec("PRAGMA application_id = " + SQLITE_APPLICATION_ID);
    db.exec("PRAGMA user_version = 1");
    db.prepare("INSERT INTO settings(key,value_json,version,updated_at) VALUES('preserved','{\"ok\":true}',1,1000)").run();
  } finally {
    db.close();
  }
  const storage = openStorage(databaseFile, { create: false, now: 2000 });
  try {
    assert.equal(storage.integrityCheck().schemaVersion, 3);
    assert.deepEqual(storage.getSetting("preserved"), { ok: true });
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 3);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check").get().count, 0);
    assert.ok(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_alert_deliveries'").get());
  } finally {
    storage.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("version-two storage preserves external alerts while replacing its private source label", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-storage-legacy-"));
  const databaseFile = path.join(root, "state.sqlite3");
  const firstSql = readFileSync(new URL("../migrations/001-initial.sql", import.meta.url), "utf8");
  const currentSecondSql = readFileSync(new URL("../migrations/002-external-alerts.sql", import.meta.url), "utf8");
  const legacySource = ["L", "T", "1"].join("");
  const legacySecondSql = currentSecondSql.replace("external-harvester", legacySource);
  assert.equal(sha256(legacySecondSql), "9a5f4dc7433c2f1010f10b8b9f8f5a9e6b2943a71c2c5405d33c46e693c2610c");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(firstSql);
    db.exec(legacySecondSql);
    db.prepare("INSERT INTO schema_migrations(version,checksum,package_version,applied_at) VALUES(1,?,?,?)").run(sha256(firstSql), "0.1.1", 1000);
    db.prepare("INSERT INTO schema_migrations(version,checksum,package_version,applied_at) VALUES(2,?,?,?)").run(sha256(legacySecondSql), "0.1.2", 1100);
    db.exec("PRAGMA application_id = " + SQLITE_APPLICATION_ID);
    db.exec("PRAGMA user_version = 2");
    db.prepare("INSERT INTO external_alert_deliveries(id,source,external_key,state,message_private,message_digest,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'QUEUED',?,?,?,?,?)")
      .run("out_0123456789abcdef0123456789abcdef", legacySource, "legacy-key", "Source: External Harvester\n\nPreserved alert", "0".repeat(64), 1200, 1200, 1200);
  } finally {
    db.close();
  }
  const storage = openStorage(databaseFile, { create: false, now: 2000 });
  try {
    const row = storage.db.prepare("SELECT source,external_key,message_private FROM external_alert_deliveries").get();
    assert.deepEqual({ ...row }, {
      source: "external-harvester",
      external_key: "legacy-key",
      message_private: "Source: External Harvester\n\nPreserved alert"
    });
    assert.equal(storage.integrityCheck().schemaVersion, 3);
  } finally {
    storage.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("route revisions increment and stored config remains safe JSON", function () {
  const storage = openStorage(":memory:", { create: true, now: 1234 });
  try {
    assert.equal(storage.upsertRoute("telegram", true, "READY", { paired: false }, 1234), 1);
    assert.equal(storage.upsertRoute("telegram", true, "READY", { paired: true }, 1235), 2);
    assert.deepEqual(storage.getRoute("telegram"), {
      route: "telegram", selected: true, revision: 2, state: "READY", safeConfig: { paired: true }, updatedAt: 1235
    });
    assert.equal(storage.setRouteState("telegram", "DEGRADED", 1236).revision, 2);
    assert.equal(storage.getRoute("telegram").state, "DEGRADED");
  } finally {
    storage.close();
  }
});
