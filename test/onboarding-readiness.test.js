import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboard } from "../src/onboarding.js";
import { buildLayout } from "../src/paths.js";
import { inspectReadiness } from "../src/readiness.js";
import { openStorage } from "../src/storage.js";

async function preflightOk() {
  return { ok: true, nodeVersion: "fixture" };
}

test("read-only readiness reports onboarding without creating private state", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-onboarding-"));
  const codexRoot = path.join(root, "codex");
  await fsp.mkdir(codexRoot);
  const layout = buildLayout(codexRoot);
  try {
    const before = await inspectReadiness({ codexRoot });
    assert.equal(before.status, "NEEDS_ONBOARDING");
    await assert.rejects(fsp.lstat(layout.goromboRoot), function (error) { return error && error.code === "ENOENT"; });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("onboarding creates owned state but never creates or fills the private environment file", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-onboarding-"));
  const codexRoot = path.join(root, "codex");
  await fsp.mkdir(codexRoot);
  const layout = buildLayout(codexRoot);
  try {
    const first = await onboard({ codexRoot, routeMode: "telegram", now: 1000, runPreflight: preflightOk });
    assert.equal(first.status, "NEEDS_ONBOARDING");
    assert.equal(first.environmentFileRelative, ".gorombo/.env");
    assert.deepEqual(first.requiredEnvironmentVariables, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "GOROMBO_SKILL_HARVESTER_TASK_CWD"]);
    await assert.rejects(fsp.lstat(layout.environmentFile), function (error) { return error && error.code === "ENOENT"; });
    const storage = openStorage(layout.databaseFile, { create: false });
    try {
      assert.deepEqual(storage.integrityCheck().ok, true);
      assert.equal(storage.getRoute("telegram").state, "UNCONFIGURED");
      assert.equal(storage.getRoute("session").state, "DISABLED");
    } finally {
      storage.close();
    }

    const fakeToken = ["123456", "abcdefghijklmnopqrstuvwxyz"].join(":");
    const envText = [
      "TELEGRAM_BOT_TOKEN=" + fakeToken,
      "TELEGRAM_ALLOWED_USER_IDS=123456789",
      "GOROMBO_SKILL_HARVESTER_TASK_CWD=" + root.replace(/\\/gu, "/"),
      ""
    ].join("\n");
    await fsp.writeFile(layout.environmentFile, envText, { encoding: "utf8", mode: 0o600 });
    const second = await onboard({ codexRoot, routeMode: "telegram", now: 2000, runPreflight: preflightOk });
    assert.equal(second.status, "NEEDS_ONBOARDING");
    const verify = openStorage(layout.databaseFile, { create: false });
    try {
      assert.equal(verify.getRoute("telegram").state, "CONFIGURED");
      assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM onboarding_runs").get().count, 1);
      assert.equal(verify.db.prepare("SELECT state FROM onboarding_runs").get().state, "WAITING_FOR_ROUTE_CONFIGURATION");
    } finally {
      verify.close();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
