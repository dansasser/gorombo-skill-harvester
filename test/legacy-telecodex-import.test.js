import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { loadPrivateEnv } from "../src/config.js";
import { importLegacyTelecodex } from "../src/legacy-telecodex-import.js";
import { buildLayout } from "../src/paths.js";
import { openStorage } from "../src/storage.js";

const fakeToken = ["123456", "abcdefghijklmnopqrstuv"].join(":");

async function fixture() {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-import-"));
  const codexRoot = path.join(parent, ".codex");
  const legacyRoot = path.join(parent, "legacy");
  const taskCwd = path.join(parent, "work");
  const legacyEnv = path.join(parent, "telecodex.env");
  await Promise.all([fsp.mkdir(codexRoot), fsp.mkdir(legacyRoot), fsp.mkdir(taskCwd)]);
  const pairing = JSON.stringify({
    pending: {},
    paired: {
      "200": {
        senderId: 200,
        chatId: 200,
        createdAt: 10,
        expiresAt: 20,
        pairedAt: 30
      }
    }
  }, null, 2);
  const environment = [
    "TELEGRAM_BOT_TOKEN=" + fakeToken,
    "TELEGRAM_ALLOWED_USER_IDS=200",
    "CODEX_SANDBOX_MODE=workspace-write",
    "CODEX_APPROVAL_POLICY=never",
    "CODEX_MODEL=gpt-fixture",
    ""
  ].join("\n");
  await fsp.writeFile(path.join(legacyRoot, "pairing.json"), pairing, { mode: 0o600 });
  await fsp.writeFile(legacyEnv, environment, { mode: 0o600 });
  return { parent, codexRoot, legacyRoot, legacyEnv, taskCwd, pairing, environment };
}

async function preflightOk() {
  return { ok: true, nodeVersion: "fixture" };
}

test("legacy import carries the approved private binding and task settings without provider polling or sending", async function () {
  const value = await fixture();
  const providerCalls = [];
  const telegramClient = {
    getIdentity: async function () {
      providerCalls.push("getMe");
      return { botIdentity: "100", username: "fixture_bot" };
    },
    getUpdates: async function () { providerCalls.push("getUpdates"); throw new Error("unexpected_get_updates"); },
    sendText: async function () { providerCalls.push("sendMessage"); throw new Error("unexpected_send"); }
  };
  try {
    const first = await importLegacyTelecodex({
      ...value,
      telegramClient,
      runPreflight: preflightOk,
      now: 1000
    });
    assert.deepEqual(first, {
      status: "imported",
      route: "telegram",
      bindingState: "ACTIVE",
      environmentState: "created",
      environmentFileRelative: ".gorombo/.env"
    });
    assert.deepEqual(providerCalls, ["getMe"]);
    assert.equal(await fsp.readFile(path.join(value.legacyRoot, "pairing.json"), "utf8"), value.pairing);
    assert.equal(await fsp.readFile(value.legacyEnv, "utf8"), value.environment);

    const layout = buildLayout(value.codexRoot);
    const privateEnv = await loadPrivateEnv(layout.environmentFile);
    assert.equal(privateEnv.TELEGRAM_BOT_TOKEN, fakeToken);
    assert.equal(privateEnv.TELEGRAM_ALLOWED_USER_IDS, "200");
    assert.equal(privateEnv.GOROMBO_SKILL_HARVESTER_TASK_CWD, value.taskCwd);
    assert.equal(privateEnv.GOROMBO_SKILL_HARVESTER_TASK_SANDBOX, "workspace-write");
    assert.equal(privateEnv.GOROMBO_SKILL_HARVESTER_TASK_MODEL, "gpt-fixture");

    const storage = openStorage(layout.databaseFile, { create: false });
    let revision;
    try {
      const binding = storage.db.prepare("SELECT * FROM telegram_bindings").get();
      assert.equal(binding.bot_identity, "100");
      assert.equal(binding.user_identity, "200");
      assert.equal(binding.chat_identity, "200");
      assert.equal(binding.state, "ACTIVE");
      assert.equal(binding.is_primary, 1);
      assert.equal(binding.approved_at, 30);
      assert.equal(storage.getRoute("telegram").state, "CONFIGURED");
      revision = storage.getRoute("telegram").revision;
    } finally {
      storage.close();
    }

    const beforeEnvironment = await fsp.readFile(layout.environmentFile);
    const second = await importLegacyTelecodex({
      ...value,
      telegramClient,
      runPreflight: preflightOk,
      now: 2000
    });
    assert.equal(second.status, "already_imported");
    assert.equal(second.environmentState, "unchanged");
    assert.deepEqual(providerCalls, ["getMe", "getMe"]);
    assert.deepEqual(await fsp.readFile(layout.environmentFile), beforeEnvironment);
    const verify = openStorage(layout.databaseFile, { create: false });
    try {
      assert.equal(verify.db.prepare("SELECT COUNT(*) AS count FROM telegram_bindings").get().count, 1);
      assert.equal(verify.getRoute("telegram").revision, revision);
    } finally {
      verify.close();
    }
  } finally {
    await fsp.rm(value.parent, { recursive: true, force: true });
  }
});

test("legacy import rejects ambiguous pairing before creating private product state", async function () {
  const value = await fixture();
  try {
    const paired = JSON.parse(value.pairing);
    paired.paired["201"] = { senderId: 201, chatId: 201, createdAt: 10, expiresAt: 20, pairedAt: 31 };
    await fsp.writeFile(path.join(value.legacyRoot, "pairing.json"), JSON.stringify(paired), { mode: 0o600 });
    await fsp.writeFile(value.legacyEnv, value.environment.replace("200", "200,201"), { mode: 0o600 });
    await assert.rejects(importLegacyTelecodex({
      ...value,
      telegramClient: { getIdentity: async function () { throw new Error("must_not_call"); } },
      runPreflight: preflightOk
    }), /legacy_pairing_conflict/);
    await assert.rejects(fsp.lstat(buildLayout(value.codexRoot).goromboRoot), function (error) { return error && error.code === "ENOENT"; });
  } finally {
    await fsp.rm(value.parent, { recursive: true, force: true });
  }
});

test("legacy import CLI requires explicit runtime paths and emits only safe state", async function () {
  const stdout = [];
  let captured = null;
  const exit = await runCli([
    "import", "telecodex",
    "--legacy-root", path.resolve("legacy-fixture"),
    "--legacy-env", path.resolve("legacy-fixture.env"),
    "--task-cwd", path.resolve("task-fixture")
  ], {
    importLegacyTelecodex: async function (options) {
      captured = options;
      return { status: "imported", route: "telegram", bindingState: "ACTIVE", environmentState: "created", environmentFileRelative: ".gorombo/.env" };
    },
    stdout: { write: function (value) { stdout.push(value); } },
    stderr: { write: function () {} }
  });
  assert.equal(exit, 0);
  assert.equal(path.isAbsolute(captured.legacyRoot), true);
  assert.equal(path.isAbsolute(captured.legacyEnv), true);
  assert.equal(path.isAbsolute(captured.taskCwd), true);
  const visible = JSON.parse(stdout.join(""));
  assert.deepEqual(Object.keys(visible).sort(), ["bindingState", "environmentFileRelative", "environmentState", "route", "status"]);
});
