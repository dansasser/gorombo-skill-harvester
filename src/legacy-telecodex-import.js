import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadPrivateEnv, parseEnvText, taskPolicyFromEnv, telegramAllowedUsers } from "./config.js";
import { createId } from "./ids.js";
import { onboard } from "./onboarding.js";
import { buildLayout, ensureOwnedLayout, resolveCodexRoot } from "./paths.js";
import { acquireRuntimeLock, releaseRuntimeLock } from "./runtime-lock.js";
import { openStorage } from "./storage.js";
import { TelegramClient } from "./telegram.js";
import { normalizeTelegramIdentity } from "./telegram-identity.js";

const MAX_LEGACY_PAIRING_BYTES = 64 * 1024;

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.size === right.size);
}

async function readBoundedText(file, maximumBytes, code) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(code);
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) throw new Error(code);
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try { handle = await fsp.open(file, fs.constants.O_RDONLY | noFollow); }
  catch { throw new Error(code); }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened) || opened.size > maximumBytes) throw new Error(code);
    const buffer = await handle.readFile();
    if (buffer.length > maximumBytes) throw new Error(code);
    const after = await fsp.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(opened, after)) throw new Error(code);
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) throw new Error(code);
    return text;
  } finally {
    await handle.close();
  }
}

async function exactDirectory(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(code);
  const resolved = path.resolve(value);
  const info = await fsp.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
  return resolved;
}

function legacyPairing(text, allowedUsers) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("legacy_pairing_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !value.paired || typeof value.paired !== "object" || Array.isArray(value.paired) ||
      !value.pending || typeof value.pending !== "object" || Array.isArray(value.pending)) throw new Error("legacy_pairing_invalid");
  const eligible = [];
  for (const record of Object.values(value.paired)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("legacy_pairing_invalid");
    let userIdentity;
    let chatIdentity;
    try {
      userIdentity = normalizeTelegramIdentity(record.senderId);
      chatIdentity = normalizeTelegramIdentity(record.chatId);
    } catch {
      throw new Error("legacy_pairing_invalid");
    }
    if (!Number.isSafeInteger(record.pairedAt) || record.pairedAt < 0) throw new Error("legacy_pairing_invalid");
    if (allowedUsers.has(userIdentity)) eligible.push({ userIdentity, chatIdentity, approvedAt: record.pairedAt });
  }
  if (eligible.length !== 1) throw new Error(eligible.length === 0 ? "legacy_pairing_missing" : "legacy_pairing_conflict");
  return eligible[0];
}

function mappedLegacyEnvironment(env, taskCwd) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (typeof token !== "string" || token.length < 8 || token.length > 4096 || /\s/u.test(token)) throw new Error("legacy_telegram_token_invalid");
  const allowedUsers = telegramAllowedUsers(env);
  const approvalPolicy = env.CODEX_APPROVAL_POLICY || "never";
  if (approvalPolicy !== "never") throw new Error("legacy_approval_policy_unsupported");
  const sandbox = env.CODEX_SANDBOX_MODE || "read-only";
  const model = env.CODEX_MODEL || null;
  const taskPolicy = taskPolicyFromEnv({
    GOROMBO_SKILL_HARVESTER_TASK_CWD: taskCwd,
    GOROMBO_SKILL_HARVESTER_TASK_SANDBOX: sandbox,
    ...(model ? { GOROMBO_SKILL_HARVESTER_TASK_MODEL: model } : {})
  });
  return {
    token,
    allowedUsers,
    allowedUserText: [...allowedUsers].join(","),
    taskCwd: taskPolicy.cwd,
    sandbox: taskPolicy.sandbox,
    model: taskPolicy.model
  };
}

function quoteEnvironmentValue(value) {
  const text = String(value);
  if (text.includes("\r") || text.includes("\n") || text.includes("\0")) throw new Error("environment_value_invalid");
  if (!text.includes("'")) return "'" + text + "'";
  if (!text.includes('"')) return '"' + text + '"';
  throw new Error("environment_value_invalid");
}

function privateEnvironmentText(mapped) {
  const lines = [
    "TELEGRAM_BOT_TOKEN=" + quoteEnvironmentValue(mapped.token),
    "TELEGRAM_ALLOWED_USER_IDS=" + quoteEnvironmentValue(mapped.allowedUserText),
    "GOROMBO_SKILL_HARVESTER_TASK_CWD=" + quoteEnvironmentValue(mapped.taskCwd),
    "GOROMBO_SKILL_HARVESTER_TASK_SANDBOX=" + quoteEnvironmentValue(mapped.sandbox)
  ];
  if (mapped.model) lines.push("GOROMBO_SKILL_HARVESTER_TASK_MODEL=" + quoteEnvironmentValue(mapped.model));
  const content = lines.join("\n") + "\n";
  parseEnvText(content);
  return content;
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

function existingEnvironmentMatches(env, mapped) {
  let allowed;
  let policy;
  try {
    allowed = telegramAllowedUsers(env);
    policy = taskPolicyFromEnv(env);
  } catch {
    return false;
  }
  return env.TELEGRAM_BOT_TOKEN === mapped.token &&
    sameSet(allowed, mapped.allowedUsers) &&
    policy.cwd === mapped.taskCwd &&
    policy.sandbox === mapped.sandbox &&
    policy.model === mapped.model;
}

async function installPrivateEnvironment(layout, content, mapped) {
  const temporary = path.join(layout.goromboRoot, ".env.import." + process.pid + "." + createId("bak") + ".tmp");
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created = false;
  try {
    await fsp.link(temporary, layout.environmentFile);
    created = true;
    if (process.platform !== "win32") await fsp.chmod(layout.environmentFile, 0o600);
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  } finally {
    await fsp.unlink(temporary).catch(function () {});
  }
  if (created) return true;
  let existing;
  try { existing = await loadPrivateEnv(layout.environmentFile); }
  catch { throw new Error("legacy_environment_conflict"); }
  if (!existingEnvironmentMatches(existing, mapped)) throw new Error("legacy_environment_conflict");
  return false;
}

function importBinding(storage, botIdentity, pairing, now) {
  const route = storage.getRoute("telegram");
  if (!route || !route.selected || route.state !== "CONFIGURED") throw new Error("telegram_route_not_configured");
  const rows = storage.db.prepare("SELECT * FROM telegram_bindings ORDER BY approved_at,id").all();
  if (rows.length > 0) {
    if (rows.length !== 1) throw new Error("legacy_pairing_conflict");
    const row = rows[0];
    const exact = row.bot_identity === botIdentity &&
      row.user_identity === pairing.userIdentity &&
      row.chat_identity === pairing.chatIdentity &&
      row.chat_type === "private" &&
      row.state === "ACTIVE" &&
      Number(row.is_primary) === 1;
    if (!exact) throw new Error("legacy_pairing_conflict");
    return { imported: false };
  }
  storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,chat_type,is_primary,state,approved_at) VALUES(?,?,?,?,'private',1,'ACTIVE',?)")
    .run(createId("bnd"), botIdentity, pairing.userIdentity, pairing.chatIdentity, pairing.approvedAt || now);
  return { imported: true };
}

export async function importLegacyTelecodex(options = {}) {
  const legacyRoot = await exactDirectory(options.legacyRoot, "legacy_root_invalid");
  const taskCwd = await exactDirectory(options.taskCwd, "task_cwd_invalid");
  if (typeof options.legacyEnv !== "string" || !path.isAbsolute(options.legacyEnv)) throw new Error("legacy_environment_invalid");
  const legacyEnvText = await readBoundedText(path.resolve(options.legacyEnv), 1024 * 1024, "legacy_environment_invalid");
  let legacyEnv;
  try { legacyEnv = parseEnvText(legacyEnvText); }
  catch { throw new Error("legacy_environment_invalid"); }
  const mapped = mappedLegacyEnvironment(legacyEnv, taskCwd);
  const pairingText = await readBoundedText(path.join(legacyRoot, "pairing.json"), MAX_LEGACY_PAIRING_BYTES, "legacy_pairing_invalid");
  const pairing = legacyPairing(pairingText, mapped.allowedUsers);

  const telegram = options.telegramClient || new TelegramClient({ token: mapped.token, fetch: options.fetch });
  const identity = await telegram.getIdentity(options.signal);
  const botIdentity = normalizeTelegramIdentity(identity && identity.botIdentity);

  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: options.env, home: options.home });
  const layout = buildLayout(codexRoot);
  await ensureOwnedLayout(layout);
  const environmentCreated = await installPrivateEnvironment(layout, privateEnvironmentText(mapped), mapped);

  await (options.onboard || onboard)({
    routeMode: "telegram",
    codexRoot,
    env: options.env,
    home: options.home,
    codexExecutable: options.codexExecutable,
    preflightOptions: options.preflightOptions,
    runPreflight: options.runPreflight
  });

  const now = options.now === undefined ? Date.now() : options.now;
  const acquire = options.acquireRuntimeLock || acquireRuntimeLock;
  const release = options.releaseRuntimeLock || releaseRuntimeLock;
  const ownership = await acquire(layout, { ...(options.lockOptions || {}), now });
  let failure = null;
  let result = null;
  try {
    const storage = openStorage(layout.databaseFile, { create: false });
    try {
      result = storage.transaction(function () {
        return importBinding(storage, botIdentity, pairing, now);
      });
    } finally {
      storage.close();
    }
  } catch (error) {
    failure = error;
  }
  try {
    const released = await release(layout, ownership);
    if (!released && !failure) failure = new Error("runtime_lock_lost");
  } catch (error) {
    if (!failure) failure = error;
  }
  if (failure) throw failure;

  return {
    status: result.imported ? "imported" : "already_imported",
    route: "telegram",
    bindingState: "ACTIVE",
    environmentState: environmentCreated ? "created" : "unchanged",
    environmentFileRelative: ".gorombo/.env"
  };
}
