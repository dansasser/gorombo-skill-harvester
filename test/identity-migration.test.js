import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectIdentityMigration, migrateLegacyState } from "../src/identity-migration.js";
import { buildLayout, buildLegacyLayout, resolveCompletionLayout } from "../src/paths.js";
import { openStorage } from "../src/storage.js";

test("legacy product state moves atomically without changing database or recommendation bytes", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-migration-"));
  try {
    const legacy = buildLegacyLayout(root);
    const canonical = buildLayout(root);
    await fsp.mkdir(legacy.recommendationsDir, { recursive: true });
    const storage = openStorage(legacy.databaseFile, { create: true, now: 1 });
    storage.close();
    await fsp.writeFile(path.join(legacy.recommendationsDir, "rec_fixture.md"), "# Preserved\n", "utf8");
    assert.deepEqual(inspectIdentityMigration({ codexRoot: root }), { status: "migration_required" });
    assert.equal(resolveCompletionLayout(root).productRoot, legacy.productRoot);
    const result = await migrateLegacyState({ codexRoot: root });
    assert.equal(result.status, "migrated");
    await assert.rejects(fsp.lstat(legacy.productRoot), { code: "ENOENT" });
    assert.equal(await fsp.readFile(path.join(canonical.recommendationsDir, "rec_fixture.md"), "utf8"), "# Preserved\n");
    const reopened = openStorage(canonical.databaseFile, { create: false });
    try { assert.equal(reopened.integrityCheck().ok, true); } finally { reopened.close(); }
    assert.deepEqual(await migrateLegacyState({ codexRoot: root }), { status: "already_migrated" });
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("legacy migration refuses active or uncertain runtime ownership and root collisions", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-migration-blocked-"));
  try {
    const legacy = buildLegacyLayout(root);
    const canonical = buildLayout(root);
    await fsp.mkdir(legacy.runtimeDir, { recursive: true });
    await fsp.writeFile(legacy.runtimeLock, "{}\n", "utf8");
    await assert.rejects(migrateLegacyState({ codexRoot: root }), /legacy_runtime_active_or_uncertain/);
    await fsp.unlink(legacy.runtimeLock);
    await fsp.mkdir(canonical.productRoot, { recursive: true });
    await assert.rejects(migrateLegacyState({ codexRoot: root }), /state_identity_collision/);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("legacy migration requires the previous user service to be uninstalled", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-migration-service-"));
  try {
    const legacy = buildLegacyLayout(root);
    await fsp.mkdir(legacy.runtimeDir, { recursive: true });
    await fsp.writeFile(path.join(legacy.runtimeDir, "service-task.xml"), "<Task/>\n", "utf8");
    await assert.rejects(migrateLegacyState({ codexRoot: root, platform: "win32" }), /legacy_service_still_installed/);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
