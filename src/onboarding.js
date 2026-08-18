import fs from "node:fs";
import { createId } from "./ids.js";
import { defaultConfig, loadPrivateEnv, readConfig, taskPolicyFromEnv, telegramAllowedUsers, writeConfig } from "./config.js";
import { ensureOwnedLayout, buildLayout, resolveCodexRoot } from "./paths.js";
import { runPreflight } from "./preflight.js";
import { inspectReadiness } from "./readiness.js";
import { acquireRuntimeLock, readHeartbeat, releaseRuntimeLock } from "./runtime-lock.js";
import { openStorage } from "./storage.js";

const ROUTES = new Set(["telegram", "session", "both"]);

function validTelegramConfiguration(config, layout, env) {
  const token = env[config.telegram.tokenEnv];
  if (typeof token !== "string" || token.length < 8 || /replace|your-bot-token/iu.test(token)) return { valid: false, code: "telegram_token_missing" };
  try { telegramAllowedUsers(env); }
  catch { return { valid: false, code: "telegram_allowed_users_invalid" }; }
  let policy;
  try { policy = taskPolicyFromEnv(env); }
  catch (error) { return { valid: false, code: String(error.message || "task_policy_invalid") }; }
  if (typeof policy.cwd !== "string") return { valid: false, code: "task_cwd_missing" };
  try {
    const info = fs.lstatSync(policy.cwd);
    if (!info.isDirectory() || info.isSymbolicLink()) return { valid: false, code: "task_cwd_invalid" };
  } catch {
    return { valid: false, code: "task_cwd_invalid" };
  }
  return { valid: true, code: null };
}

function routeTarget(routeMode, route) {
  return routeMode === "both" || routeMode === route;
}

function ensureRoute(storage, route, selected, desiredState, now) {
  const current = storage.getRoute(route);
  if (!selected) {
    if (!current || current.selected || current.state !== "DISABLED") storage.upsertRoute(route, false, "DISABLED", {}, now);
    return;
  }
  if (current && current.selected && ["READY", "RECOVERY_REQUIRED"].includes(current.state)) return;
  if (!current || !current.selected || current.state !== desiredState) storage.upsertRoute(route, true, desiredState, {}, now);
}

function recordOnboarding(storage, routeMode, state, reasonCode, now) {
  const open = storage.db.prepare(
    "SELECT id FROM onboarding_runs WHERE state NOT IN ('COMPLETED','CANCELLED','RECOVERY_REQUIRED') ORDER BY started_at DESC,id DESC LIMIT 1"
  ).get();
  const plan = JSON.stringify({ routeMode });
  if (open) {
    storage.db.prepare("UPDATE onboarding_runs SET state=?,requested_route_mode=?,plan_json=?,safe_reason_code=?,completed_at=? WHERE id=?")
      .run(state, routeMode, plan, reasonCode, state === "COMPLETED" ? now : null, open.id);
    return open.id;
  }
  const id = createId("onb");
  storage.db.prepare("INSERT INTO onboarding_runs(id,state,requested_route_mode,plan_json,safe_reason_code,started_at,completed_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, state, routeMode, plan, reasonCode, now, state === "COMPLETED" ? now : null);
  return id;
}

export function completeOnboardingIfReadyInTransaction(storage, now = Date.now()) {
  const rows = storage.db.prepare("SELECT selected,state FROM route_configurations ORDER BY route").all();
  const selected = rows.filter(function (row) { return Boolean(row.selected); });
  if (selected.length === 0 || selected.some(function (row) { return row.state !== "READY"; })) return false;
  const open = storage.db.prepare(
    "SELECT id FROM onboarding_runs WHERE state NOT IN ('COMPLETED','CANCELLED','RECOVERY_REQUIRED') ORDER BY started_at DESC,id DESC LIMIT 1"
  ).get();
  if (!open) return false;
  const changed = storage.db.prepare("UPDATE onboarding_runs SET state='COMPLETED',safe_reason_code=NULL,completed_at=? WHERE id=?")
    .run(now, open.id);
  return Number(changed.changes) === 1;
}

export async function onboard(options = {}) {
  const routeMode = options.routeMode || "telegram";
  if (!ROUTES.has(routeMode)) throw new Error("route_mode_invalid");
  await (options.runPreflight || runPreflight)({
    ...(options.preflightOptions || {}),
    env: options.env,
    executable: options.codexExecutable
  });
  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: options.env, home: options.home });
  const layout = buildLayout(codexRoot);
  await ensureOwnedLayout(layout);
  const now = options.now === undefined ? Date.now() : options.now;
  const acquire = options.acquireRuntimeLock || acquireRuntimeLock;
  const release = options.releaseRuntimeLock || releaseRuntimeLock;
  const ownership = await acquire(layout, { ...(options.lockOptions || {}), now });
  let config;
  let telegram;
  let onboardingId;
  let failure = null;
  try {
    const priorHeartbeat = await readHeartbeat(layout);
    if (priorHeartbeat && priorHeartbeat.state === "RECOVERY_REQUIRED") throw new Error("runtime_recovery_required");
    try {
      config = await readConfig(layout.configFile);
      if (config.routeMode !== routeMode) throw new Error("onboarding_route_change_requires_command");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      config = defaultConfig(routeMode);
      await writeConfig(layout.configFile, config);
    }

    telegram = { valid: !config.telegram.enabled, code: null };
    if (config.telegram.enabled) {
      try {
        const env = await loadPrivateEnv(layout.environmentFile);
        telegram = validTelegramConfiguration(config, layout, env);
      } catch (error) {
        telegram = { valid: false, code: error && error.code === "ENOENT" ? "telegram_environment_missing" : "environment_file_invalid" };
      }
    }

    const storage = openStorage(layout.databaseFile, { create: true, now });
    try {
      storage.transaction(function () {
        ensureRoute(storage, "telegram", routeTarget(routeMode, "telegram"), telegram.valid ? "CONFIGURED" : "UNCONFIGURED", now);
        ensureRoute(storage, "session", routeTarget(routeMode, "session"), "UNCONFIGURED", now);
        const selected = ["telegram", "session"].filter(function (route) { return routeTarget(routeMode, route); });
        const ready = selected.every(function (route) {
          const value = storage.getRoute(route);
          return value && value.selected && value.state === "READY";
        });
        const state = ready ? "COMPLETED" : config.telegram.enabled && !telegram.valid ? "WAITING_FOR_SECRET" : "WAITING_FOR_ROUTE_CONFIGURATION";
        onboardingId = recordOnboarding(storage, routeMode, state, telegram.code, now);
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

  const readiness = await inspectReadiness({ codexRoot, env: options.env, home: options.home });
  return {
    status: readiness.status,
    onboardingId,
    routeMode,
    environmentFile: layout.environmentFile,
    environmentFileRelative: ".gorombo/.env",
    requiredEnvironmentVariables: config.telegram.enabled
      ? ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS", "GOROMBO_SKILL_HARVESTER_TASK_CWD"]
      : [],
    reasonCode: readiness.reasonCode || telegram.code || null
  };
}
