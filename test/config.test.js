import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, parseEnvText, redact, taskPolicyFromEnv, telegramAllowedUsers, validateConfig } from "../src/config.js";

test("environment parser accepts inert values and rejects interpolation", function () {
  const env = parseEnvText("TELEGRAM_BOT_TOKEN='123:abc'\nTELEGRAM_ALLOWED_USER_IDS=246802468\n");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "123:abc");
  assert.throws(function () { parseEnvText("X=$HOME\n"); }, /environment_file_invalid/);
  assert.throws(function () { parseEnvText("X=1\nX=2\n"); }, /environment_file_invalid/);
});

test("route configuration is exact and consistent", function () {
  assert.equal(validateConfig(defaultConfig("both")).routeMode, "both");
  const invalid = defaultConfig("telegram");
  invalid.session.enabled = true;
  assert.throws(function () { validateConfig(invalid); }, /config_invalid/);
});

test("private task policy and allowed user parsing are bounded", function () {
  assert.deepEqual(taskPolicyFromEnv({ GOROMBO_SKILL_HARVESTER_TASK_SANDBOX: "read-only" }), { sandbox: "read-only", cwd: null, model: null });
  assert.deepEqual(taskPolicyFromEnv({ GOROMBO_SKILL_HARVESTER_TASK_SANDBOX: "workspace-write", GOROMBO_SKILL_HARVESTER_TASK_MODEL: "gpt-fixture" }), { sandbox: "workspace-write", cwd: null, model: "gpt-fixture" });
  assert.deepEqual(taskPolicyFromEnv({ HARVESTER_V2_TASK_SANDBOX: "workspace-write", HARVESTER_V2_TASK_MODEL: "gpt-fixture" }), { sandbox: "workspace-write", cwd: null, model: "gpt-fixture" });
  assert.deepEqual(taskPolicyFromEnv({ GOROMBO_SKILL_HARVESTER_TASK_SANDBOX: "read-only", HARVESTER_V2_TASK_SANDBOX: "read-only" }), { sandbox: "read-only", cwd: null, model: null });
  assert.throws(function () { taskPolicyFromEnv({ GOROMBO_SKILL_HARVESTER_TASK_SANDBOX: "read-only", HARVESTER_V2_TASK_SANDBOX: "workspace-write" }); }, /task_environment_conflict/);
  assert.throws(function () { taskPolicyFromEnv({ GOROMBO_SKILL_HARVESTER_TASK_MODEL: "bad model" }); }, /task_model_invalid/);
  assert.deepEqual([...telegramAllowedUsers({ TELEGRAM_ALLOWED_USER_IDS: "1, 2" })], ["1", "2"]);
  assert.throws(function () { telegramAllowedUsers({ TELEGRAM_ALLOWED_USER_IDS: "all" }); }, /telegram_allowed_users_invalid/);
});

test("redaction removes recognized credentials", function () {
  const token = ["123456", "ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef"].join(":");
  assert.equal(redact("token " + token, [token]), "token [REDACTED]");
});
