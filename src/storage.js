import fs from "node:fs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PRODUCT_VERSION, SCHEMA_VERSION, SQLITE_APPLICATION_ID } from "./constants.js";
import { sha256 } from "./ids.js";

const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, file: fileURLToPath(new URL("../migrations/001-initial.sql", import.meta.url)) }),
  Object.freeze({ version: 2, file: fileURLToPath(new URL("../migrations/002-external-alerts.sql", import.meta.url)) }),
  Object.freeze({ version: 3, file: fileURLToPath(new URL("../migrations/003-generic-external-alert-source.sql", import.meta.url)) })
]);

const LEGACY_MIGRATION_CHECKSUMS = Object.freeze(new Map([
  [2, new Set(["9a5f4dc7433c2f1010f10b8b9f8f5a9e6b2943a71c2c5405d33c46e693c2610c"])]
]));

function pragmaNumber(db, name) {
  const row = db.prepare("PRAGMA " + name).get();
  return Number(row[name]);
}

export class Storage {
  constructor(db, migrationChecksum) {
    this.db = db;
    this.migrationChecksum = migrationChecksum;
  }

  close() { this.db.close(); }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  getSetting(key) {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value_json) : null;
  }

  setSetting(key, value, now = Date.now()) {
    const current = this.db.prepare("SELECT version FROM settings WHERE key = ?").get(key);
    const version = current ? Number(current.version) + 1 : 1;
    this.db.prepare(
      "INSERT INTO settings(key,value_json,version,updated_at) VALUES(?,?,?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=excluded.version,updated_at=excluded.updated_at"
    ).run(key, JSON.stringify(value), version, now);
    return version;
  }

  configureRoute(route, selected, state, safeConfig = {}, now = Date.now()) {
    if (!["telegram", "session"].includes(route)) throw new Error("route_invalid");
    if (!["DISABLED", "UNCONFIGURED", "CONFIGURED", "VERIFYING", "READY", "DEGRADED", "RECOVERY_REQUIRED"].includes(state)) throw new Error("route_state_invalid");
    const current = this.db.prepare("SELECT revision FROM route_configurations WHERE route = ?").get(route);
    const revision = current ? Number(current.revision) + 1 : 1;
    this.db.prepare(
      "INSERT INTO route_configurations(route,selected,revision,state,safe_config_json,updated_at) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(route) DO UPDATE SET selected=excluded.selected,revision=excluded.revision,state=excluded.state,safe_config_json=excluded.safe_config_json,updated_at=excluded.updated_at"
    ).run(route, selected ? 1 : 0, revision, state, JSON.stringify(safeConfig), now);
    return revision;
  }

  upsertRoute(route, selected, state, safeConfig = {}, now = Date.now()) {
    return this.configureRoute(route, selected, state, safeConfig, now);
  }

  setRouteState(route, state, now = Date.now()) {
    if (!["telegram", "session"].includes(route)) throw new Error("route_invalid");
    if (!["DISABLED", "UNCONFIGURED", "CONFIGURED", "VERIFYING", "READY", "DEGRADED", "RECOVERY_REQUIRED"].includes(state)) throw new Error("route_state_invalid");
    const changed = this.db.prepare("UPDATE route_configurations SET state=?,updated_at=? WHERE route=?").run(state, now, route);
    if (Number(changed.changes) !== 1) throw new Error("route_missing");
    return this.getRoute(route);
  }

  getRoute(route) {
    const row = this.db.prepare("SELECT route,selected,revision,state,safe_config_json,updated_at FROM route_configurations WHERE route = ?").get(route);
    if (!row) return null;
    return { route: row.route, selected: Boolean(row.selected), revision: Number(row.revision), state: row.state, safeConfig: JSON.parse(row.safe_config_json), updatedAt: Number(row.updated_at) };
  }

  integrityCheck() {
    const quick = this.db.prepare("PRAGMA quick_check").get();
    const foreign = this.db.prepare("PRAGMA foreign_key_check").all();
    return { ok: quick.quick_check === "ok" && foreign.length === 0, schemaVersion: pragmaNumber(this.db, "user_version"), applicationId: pragmaNumber(this.db, "application_id") };
  }
}

function configure(db) {
  db.exec("PRAGMA foreign_keys = ON;PRAGMA journal_mode = WAL;PRAGMA synchronous = FULL;PRAGMA busy_timeout = 5000;");
}

export function openStorage(databaseFile, options = {}) {
  if (databaseFile !== ":memory:" && !options.create && !fs.existsSync(databaseFile)) throw new Error("storage_missing");
  const db = new DatabaseSync(databaseFile);
  configure(db);
  const migrations = MIGRATIONS.map(function (migration) {
    const sql = readFileSync(migration.file, "utf8");
    return { ...migration, sql, checksum: sha256(sql) };
  });
  let userVersion = pragmaNumber(db, "user_version");
  const applicationId = pragmaNumber(db, "application_id");
  if (userVersion === 0) {
    if (!options.create) {
      db.close();
      throw new Error("migration_required");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of migrations) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version,checksum,package_version,applied_at) VALUES(?,?,?,?)").run(migration.version, migration.checksum, PRODUCT_VERSION, options.now || Date.now());
      }
      db.exec("PRAGMA application_id = " + SQLITE_APPLICATION_ID);
      db.exec("PRAGMA user_version = " + SCHEMA_VERSION);
      db.exec("COMMIT");
      userVersion = SCHEMA_VERSION;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      db.close();
      throw error;
    }
  } else if (userVersion < 1 || userVersion > SCHEMA_VERSION || applicationId !== SQLITE_APPLICATION_ID) {
    db.close();
    throw new Error("schema_identity_mismatch");
  }

  for (const migration of migrations.filter(function (candidate) { return candidate.version <= userVersion; })) {
    const stored = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(migration.version);
    const legacyChecksums = LEGACY_MIGRATION_CHECKSUMS.get(migration.version);
    if (!stored || stored.checksum !== migration.checksum && !legacyChecksums?.has(stored.checksum)) {
      db.close();
      throw new Error("migration_checksum_mismatch");
    }
  }

  if (userVersion < SCHEMA_VERSION) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of migrations.filter(function (candidate) { return candidate.version > userVersion; })) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations(version,checksum,package_version,applied_at) VALUES(?,?,?,?)").run(migration.version, migration.checksum, PRODUCT_VERSION, options.now || Date.now());
        db.exec("PRAGMA user_version = " + migration.version);
      }
      db.exec("COMMIT");
      userVersion = SCHEMA_VERSION;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      db.close();
      throw error;
    }
  }

  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  if (foreign.length > 0) {
    db.close();
    throw new Error("storage_foreign_key_failed");
  }
  return new Storage(db, migrations[migrations.length - 1].checksum);
}
