import fs from "node:fs";
import { loadPrivateEnv, readConfig, taskPolicyFromEnv, telegramAllowedUsers } from "./config.js";
import { PRODUCT_VERSION } from "./constants.js";
import { buildLayout, buildLegacyLayout, resolveCodexRoot } from "./paths.js";
import { readHeartbeat } from "./runtime-lock.js";
import { openStorage } from "./storage.js";

const READINESS_STATES = new Set(["READY", "NEEDS_ONBOARDING", "MIGRATION_REQUIRED", "DEGRADED", "RECOVERY_REQUIRED"]);

function safeReason(error, fallback = "readiness_failed") {
  const value = String(error && (error.code || error.message) || fallback);
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : fallback;
}

function selectedRoutes(storage) {
  const result = {};
  for (const route of ["telegram", "session"]) {
    const row = storage.getRoute(route);
    result[route] = row
      ? { selected: row.selected, state: row.state }
      : { selected: false, state: "DISABLED" };
  }
  return result;
}

function stateCounts(storage, table) {
  const rows = storage.db.prepare("SELECT state,COUNT(*) AS count FROM " + table + " GROUP BY state").all();
  const values = Object.create(null);
  for (const row of rows) values[row.state] = Number(row.count);
  return values;
}

function latestOnboarding(storage) {
  const row = storage.db.prepare("SELECT state FROM onboarding_runs ORDER BY started_at DESC,id DESC LIMIT 1").get();
  return row ? row.state : "NOT_STARTED";
}

function recoveryCount(storage, routes) {
  let total = 0;
  total += Number(storage.db.prepare("SELECT COUNT(*) AS count FROM completion_events WHERE state='RECOVERY_REQUIRED'").get().count);
  total += Number(storage.db.prepare("SELECT COUNT(*) AS count FROM recommendations WHERE visibility_state='RECOVERY_REQUIRED'").get().count);
  total += Number(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RECOVERY_REQUIRED'").get().count);
  for (const route of Object.values(routes)) if (route.state === "RECOVERY_REQUIRED") total += 1;
  return total;
}

export function storageReadiness(storage, options = {}) {
  const routes = selectedRoutes(storage);
  const onboarding = latestOnboarding(storage);
  const outboxStates = stateCounts(storage, "delivery_outbox");
  const externalAlertStates = stateCounts(storage, "external_alert_deliveries");
  const taskStates = stateCounts(storage, "tasks");
  const selected = Object.values(routes).filter(function (route) { return route.selected; });
  const recoveryRequired = recoveryCount(storage, routes) > 0;
  let status = "NEEDS_ONBOARDING";
  if (recoveryRequired) status = "RECOVERY_REQUIRED";
  else if (selected.some(function (route) { return route.state === "DEGRADED"; })) status = "DEGRADED";
  else if (selected.length > 0 && selected.every(function (route) { return route.state === "READY"; }) && onboarding === "COMPLETED") status = "READY";
  const nextRows = storage.db.prepare(
    "SELECT MIN(due) AS due FROM (" +
    "SELECT next_attempt_at AS due FROM delivery_outbox WHERE state IN ('QUEUED','RETRY_WAIT') " +
    "UNION ALL SELECT lease_expires_at AS due FROM delivery_outbox WHERE state='SENDING' " +
    "UNION ALL SELECT next_attempt_at AS due FROM telegram_reply_deliveries WHERE state IN ('QUEUED','RETRY_WAIT') " +
    "UNION ALL SELECT lease_expires_at AS due FROM telegram_reply_deliveries WHERE state='SENDING' " +
    "UNION ALL SELECT next_attempt_at AS due FROM task_result_deliveries WHERE state IN ('QUEUED','RETRY_WAIT') " +
    "UNION ALL SELECT lease_expires_at AS due FROM task_result_deliveries WHERE state='SENDING' " +
    "UNION ALL SELECT next_attempt_at AS due FROM external_alert_deliveries WHERE state IN ('QUEUED','RETRY_WAIT') " +
    "UNION ALL SELECT lease_expires_at AS due FROM external_alert_deliveries WHERE state='SENDING')"
  ).get();
  return {
    status,
    packageVersion: PRODUCT_VERSION,
    onboarding,
    database: "healthy",
    routes,
    outbox: {
      queued: (outboxStates.QUEUED || 0) + (externalAlertStates.QUEUED || 0),
      sending: (outboxStates.SENDING || 0) + (externalAlertStates.SENDING || 0),
      retryWait: (outboxStates.RETRY_WAIT || 0) + (externalAlertStates.RETRY_WAIT || 0),
      paused: outboxStates.PAUSED || 0,
      deadLetter: (outboxStates.DEAD_LETTER || 0) + (externalAlertStates.DEAD_LETTER || 0)
    },
    tasks: {
      queued: taskStates.QUEUED || 0,
      running: taskStates.RUNNING || 0,
      recoveryRequired: taskStates.RECOVERY_REQUIRED || 0
    },
    nextDueAt: nextRows && nextRows.due !== null ? Number(nextRows.due) : null,
    heartbeatAgeMs: options.heartbeatAgeMs === undefined ? null : options.heartbeatAgeMs,
    recoveryRequired
  };
}

function privateFilePresent(file) {
  const info = fs.lstatSync(file);
  return info.isFile() && !info.isSymbolicLink();
}

function telegramConfigurationIssue(config, layout, env) {
  if (!config.telegram.enabled) return null;
  if (!privateFilePresent(layout.environmentFile)) return "telegram_environment_missing";
  const token = env[config.telegram.tokenEnv];
  if (typeof token !== "string" || token.length < 8 || /replace|your-bot-token/iu.test(token)) return "telegram_token_missing";
  telegramAllowedUsers(env);
  const policy = taskPolicyFromEnv(env);
  if (typeof policy.cwd !== "string") return "task_cwd_missing";
  const info = fs.lstatSync(policy.cwd);
  if (!info.isDirectory() || info.isSymbolicLink()) return "task_cwd_invalid";
  return null;
}

export async function inspectReadiness(options = {}) {
  let layout;
  let productExists = false;
  try {
    const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: options.env, home: options.home });
    layout = buildLayout(codexRoot);
    let productInfo;
    try { productInfo = fs.lstatSync(layout.productRoot); }
    catch (error) {
      if (error && error.code === "ENOENT") {
        const legacy = buildLegacyLayout(codexRoot);
        if (fs.existsSync(legacy.productRoot)) {
          return {
            status: "MIGRATION_REQUIRED",
            packageVersion: PRODUCT_VERSION,
            onboarding: "PRESERVED",
            database: "preserved",
            routes: { telegram: { selected: false, state: "DISABLED" }, session: { selected: false, state: "DISABLED" } },
            outbox: { queued: 0, sending: 0, retryWait: 0, paused: 0, deadLetter: 0 },
            tasks: { queued: 0, running: 0, recoveryRequired: 0 },
            nextDueAt: null,
            heartbeatAgeMs: null,
            recoveryRequired: false,
            reasonCode: "state_identity_migration_required"
          };
        }
        return {
          status: "NEEDS_ONBOARDING",
          packageVersion: PRODUCT_VERSION,
          onboarding: "NOT_STARTED",
          database: "absent",
          routes: {
            telegram: { selected: false, state: "DISABLED" },
            session: { selected: false, state: "DISABLED" }
          },
          outbox: { queued: 0, sending: 0, retryWait: 0, paused: 0, deadLetter: 0 },
          tasks: { queued: 0, running: 0, recoveryRequired: 0 },
          nextDueAt: null,
          heartbeatAgeMs: null,
          recoveryRequired: false,
          reasonCode: "onboarding_required"
        };
      }
      throw error;
    }
    productExists = true;
    if (!productInfo.isDirectory() || productInfo.isSymbolicLink()) throw new Error("owned_path_unsafe");
    const config = await readConfig(layout.configFile);
    const storage = openStorage(layout.databaseFile, { create: false });
    let snapshot;
    try {
      const integrity = storage.integrityCheck();
      if (!integrity.ok) throw new Error("storage_integrity_failed");
      snapshot = storageReadiness(storage);
    } finally {
      storage.close();
    }
    let heartbeat = null;
    try { heartbeat = await readHeartbeat(layout); } catch {}
    if (heartbeat) snapshot.heartbeatAgeMs = Math.max(0, Date.now() - heartbeat.observedAt);
    if (heartbeat && heartbeat.state === "RECOVERY_REQUIRED") {
      snapshot.status = "RECOVERY_REQUIRED";
      snapshot.recoveryRequired = true;
      snapshot.reasonCode = "runtime_recovery_required";
      return snapshot;
    }
    let issue = null;
    let env = Object.create(null);
    if (config.telegram.enabled) {
      try {
        env = await loadPrivateEnv(layout.environmentFile);
        issue = telegramConfigurationIssue(config, layout, env);
      } catch (error) {
        issue = safeReason(error, "telegram_configuration_invalid");
      }
    }
    if (issue) {
      snapshot.status = snapshot.onboarding === "COMPLETED" ? "DEGRADED" : "NEEDS_ONBOARDING";
      snapshot.reasonCode = issue;
    }
    if (!READINESS_STATES.has(snapshot.status)) throw new Error("readiness_state_invalid");
    return snapshot;
  } catch (error) {
    const code = safeReason(error);
    const needs = !productExists || ["ENOENT", "storage_missing", "telegram_environment_missing"].includes(code);
    return {
      status: needs ? "NEEDS_ONBOARDING" : "RECOVERY_REQUIRED",
      packageVersion: PRODUCT_VERSION,
      onboarding: needs ? "NOT_STARTED" : "UNKNOWN",
      database: needs ? "absent" : "unhealthy",
      routes: {
        telegram: { selected: false, state: "DISABLED" },
        session: { selected: false, state: "DISABLED" }
      },
      outbox: { queued: 0, sending: 0, retryWait: 0, paused: 0, deadLetter: 0 },
      tasks: { queued: 0, running: 0, recoveryRequired: 0 },
      nextDueAt: null,
      heartbeatAgeMs: null,
      recoveryRequired: !needs,
      reasonCode: code
    };
  }
}
