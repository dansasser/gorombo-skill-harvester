#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importLegacyTelecodex } from "./legacy-telecodex-import.js";
import { inspectIdentityMigration, migrateLegacyState } from "./identity-migration.js";
import { onboard } from "./onboarding.js";
import { buildLayout, resolveCodexRoot } from "./paths.js";
import { runPreflight } from "./preflight.js";
import { recoverRuntime } from "./recovery.js";
import { inspectReadiness } from "./readiness.js";
import { installService, restartService, serviceStatus, startService, stopService, uninstallService } from "./service.js";
import { sendControlCommand } from "./control.js";
import { normalizeExternalAlertBody, normalizeExternalAlertKey } from "./external-alerts.js";
import { startRuntime } from "./runtime.js";

const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  ONBOARDING: 2,
  DEGRADED: 3,
  RECOVERY: 4,
  USAGE: 64
});

function safeCode(error) {
  const value = String(error && (error.code || error.message) || "internal_error");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : "internal_error";
}

function writeJson(stream, value) {
  stream.write(JSON.stringify(value) + "\n");
}

function statusExit(status) {
  if (status === "NEEDS_ONBOARDING") return EXIT.ONBOARDING;
  if (status === "MIGRATION_REQUIRED") return EXIT.ONBOARDING;
  if (status === "DEGRADED" || status === "STARTING" || status === "STOPPING") return EXIT.DEGRADED;
  if (status === "RECOVERY_REQUIRED") return EXIT.RECOVERY;
  return EXIT.OK;
}

function routeValue(value) {
  if (!["telegram", "session", "both"].includes(value)) throw new Error("route_mode_invalid");
  return value;
}

function selectedRoute(value) {
  if (!["telegram", "session"].includes(value)) throw new Error("route_invalid");
  return value;
}

function exactArgs(argv, expected) {
  if (argv.length !== expected) throw new Error("usage_invalid");
}

function publicOnboarding(result) {
  return {
    status: result.status,
    onboardingId: result.onboardingId,
    routeMode: result.routeMode,
    environmentFileRelative: result.environmentFileRelative,
    requiredEnvironmentVariables: result.requiredEnvironmentVariables,
    reasonCode: result.reasonCode
  };
}

export async function readExternalAlertStdin(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 16_384) throw new Error("external_alert_message_invalid");
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks);
  let message;
  try { message = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new Error("external_alert_message_invalid"); }
  return normalizeExternalAlertBody(message);
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const api = {
    onboard,
    inspectReadiness,
    installService,
    restartService,
    serviceStatus,
    startService,
    stopService,
    uninstallService,
    runPreflight,
    recoverRuntime,
    sendControlCommand,
    startRuntime,
    resolveCodexRoot,
    buildLayout,
    importLegacyTelecodex,
    inspectIdentityMigration,
    migrateLegacyState,
    ...dependencies
  };
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const environment = dependencies.env || process.env;
  const preflightOptions = {
    ...(dependencies.preflightOptions || {}),
    env: environment,
    executable: dependencies.codexExecutable
  };
  const home = dependencies.home;
  const codexRoot = dependencies.codexRoot;
  const currentDirectory = typeof dependencies.cwd === "function"
    ? dependencies.cwd
    : function () { return typeof dependencies.cwd === "string" ? dependencies.cwd : process.cwd(); };
  const processHost = dependencies.processHost || process;
  const stdin = dependencies.stdin || process.stdin;

  async function live(command, payload) {
    const root = api.resolveCodexRoot({ explicitRoot: codexRoot, env: environment, home });
    const layout = api.buildLayout(root);
    return await api.sendControlCommand(layout, command, payload);
  }

  try {
    if (!Array.isArray(argv) || argv.length === 0) throw new Error("usage_invalid");
    const command = argv[0];

    if (command === "status") {
      if (argv.length > 2 || argv.length === 2 && argv[1] !== "--json") throw new Error("usage_invalid");
      const result = await api.inspectReadiness({ codexRoot, env: environment, home });
      writeJson(stdout, result);
      return statusExit(result.status);
    }

    if (command === "preflight") {
      if (argv.length > 2 || argv.length === 2 && argv[1] !== "--json") throw new Error("usage_invalid");
      writeJson(stdout, await api.runPreflight(preflightOptions));
      return EXIT.OK;
    }

    if (command === "doctor") {
      if (argv.length > 2 || argv.length === 2 && argv[1] !== "--json") throw new Error("usage_invalid");
      const preflight = await api.runPreflight(preflightOptions);
      const readiness = await api.inspectReadiness({ codexRoot, env: environment, home });
      writeJson(stdout, { preflight, readiness });
      return statusExit(readiness.status);
    }

    if (command === "onboard") {
      let routeMode = "telegram";
      if (argv.length === 3 && argv[1] === "--route") routeMode = routeValue(argv[2]);
      else if (argv.length !== 1) throw new Error("usage_invalid");
      const result = await api.onboard({
        routeMode, codexRoot, env: environment, home,
        codexExecutable: dependencies.codexExecutable,
        preflightOptions: dependencies.preflightOptions
      });
      const visible = publicOnboarding(result);
      writeJson(stdout, visible);
      return statusExit(visible.status);
    }

    if (command === "migrate") {
      exactArgs(argv, 2);
      if (argv[1] !== "--confirm") throw new Error("usage_invalid");
      const result = await api.migrateLegacyState({ codexRoot, env: environment, home });
      writeJson(stdout, result);
      return EXIT.OK;
    }

    if (command === "import") {
      exactArgs(argv, 8);
      if (argv[1] !== "telecodex" ||
          argv[2] !== "--legacy-root" ||
          argv[4] !== "--legacy-env" ||
          argv[6] !== "--task-cwd" ||
          !path.isAbsolute(argv[3]) ||
          !path.isAbsolute(argv[5]) ||
          !path.isAbsolute(argv[7])) throw new Error("usage_invalid");
      const result = await api.importLegacyTelecodex({
        legacyRoot: path.resolve(argv[3]),
        legacyEnv: path.resolve(argv[5]),
        taskCwd: path.resolve(argv[7]),
        codexRoot,
        env: environment,
        home,
        codexExecutable: dependencies.codexExecutable,
        preflightOptions: dependencies.preflightOptions,
        runPreflight: dependencies.runPreflight,
        telegramClient: dependencies.telegramClient,
        fetch: dependencies.fetch
      });
      writeJson(stdout, result);
      return EXIT.OK;
    }

    if (command === "serve") {
      let serveRoot = codexRoot;
      if (argv.length === 3 && argv[1] === "--codex-root" && typeof argv[2] === "string" && path.isAbsolute(argv[2])) serveRoot = path.resolve(argv[2]);
      else if (argv.length !== 1) throw new Error("usage_invalid");
      const serveEnvironment = serveRoot ? { ...environment, CODEX_HOME: serveRoot } : environment;
      const runtime = await api.startRuntime({
        codexRoot: serveRoot,
        env: serveEnvironment,
        home,
        codexExecutable: dependencies.codexExecutable,
        preflightOptions: dependencies.preflightOptions,
        ...(dependencies.runtimeOptions || {})
      });
      const stop = function () { void runtime.stop(); };
      processHost.once("SIGINT", stop);
      processHost.once("SIGTERM", stop);
      try {
        writeJson(stdout, { status: runtime.status().status });
        const result = await runtime.done;
        return result.status === "stopped" ? EXIT.OK : EXIT.RECOVERY;
      } finally {
        processHost.removeListener("SIGINT", stop);
        processHost.removeListener("SIGTERM", stop);
      }
    }


    if (command === "service") {
      if (!["install", "start", "stop", "restart", "status", "uninstall"].includes(argv[1])) throw new Error("usage_invalid");
      if (argv[1] === "status") {
        if (argv.length > 3 || argv.length === 3 && argv[2] !== "--json" || argv.length < 2) throw new Error("usage_invalid");
      } else exactArgs(argv, 2);
      const options = {
        codexRoot, env: environment, home,
        codexExecutable: dependencies.codexExecutable,
        preflightOptions: dependencies.preflightOptions,
        ...(dependencies.serviceOptions || {})
      };
      let result;
      if (argv[1] === "install") result = await api.installService(options);
      else if (argv[1] === "start") result = await api.startService(options);
      else if (argv[1] === "stop") result = await api.stopService(options);
      else if (argv[1] === "restart") result = await api.restartService(options);
      else if (argv[1] === "uninstall") result = await api.uninstallService(options);
      else result = await api.serviceStatus(options);
      writeJson(stdout, result);
      if (argv[1] === "status" && result.readiness) {
        const readinessExit = statusExit(result.readiness.status);
        if (readinessExit !== EXIT.OK) return readinessExit;
        if (result.serviceState === "recovery_required") return EXIT.RECOVERY;
        if (result.serviceState !== "running" && result.serviceState !== "starting") return EXIT.DEGRADED;
      }
      return EXIT.OK;
    }

    if (command === "recover") {
      exactArgs(argv, 3);
      if (argv[1] !== "runtime" || argv[2] !== "--confirm") throw new Error("usage_invalid");
      writeJson(stdout, await api.recoverRuntime({ codexRoot, env: environment, home }));
      return EXIT.OK;
    }

    if (command === "pair") {
      exactArgs(argv, 2);
      if (!/^[0-9A-F]{6}$/u.test(argv[1])) throw new Error("pairing_code_invalid");
      writeJson(stdout, await live("pair.approve", { code: argv[1] }));
      return EXIT.OK;
    }

    if (command === "alert") {
      exactArgs(argv, 4);
      if (argv[1] !== "ingest" || argv[2] !== "--key") throw new Error("usage_invalid");
      const key = normalizeExternalAlertKey(argv[3]);
      const message = await readExternalAlertStdin(stdin);
      const result = await live("external-alert.enqueue", { key, message });
      if (!result || !["queued", "existing"].includes(result.result)) throw new Error("external_alert_result_invalid");
      writeJson(stdout, { result: result.result });
      return EXIT.OK;
    }

    if (command === "route") {
      exactArgs(argv, 3);
      if (!["test", "pause", "resume"].includes(argv[1])) throw new Error("usage_invalid");
      const route = selectedRoute(argv[2]);
      writeJson(stdout, await live("route." + argv[1], { route }));
      return EXIT.OK;
    }

    if (command === "task") {
      exactArgs(argv, 3);
      if (argv[1] !== "cancel" || !/^tsk_[a-f0-9]{32}$/u.test(argv[2])) throw new Error("usage_invalid");
      writeJson(stdout, await live("task.cancel", { taskId: argv[2] }));
      return EXIT.OK;
    }

    if (command === "session") {
      if (argv[1] === "list") {
        exactArgs(argv, 2);
        writeJson(stdout, await live("session.list", {}));
        return EXIT.OK;
      }
      if (argv[1] === "select") {
        exactArgs(argv, 3);
        writeJson(stdout, await live("session.select", { name: argv[2] }));
        return EXIT.OK;
      }
      if (argv[1] === "create") {
        exactArgs(argv, 3);
        const workingDirectory = path.resolve(currentDirectory());
        writeJson(stdout, await live("session.create", { name: argv[2], workingDirectory }));
        return EXIT.OK;
      }
      if (argv[1] === "clear") {
        exactArgs(argv, 2);
        writeJson(stdout, await live("session.clear", {}));
        return EXIT.OK;
      }
      throw new Error("usage_invalid");
    }

    if (command === "wake") {
      exactArgs(argv, 1);
      writeJson(stdout, await live("wake", {}));
      return EXIT.OK;
    }

    if (command === "shutdown") {
      exactArgs(argv, 1);
      writeJson(stdout, await live("shutdown", {}));
      return EXIT.OK;
    }

    throw new Error("usage_invalid");
  } catch (error) {
    const code = safeCode(error);
    writeJson(stderr, { ok: false, error: { code } });
    if (code === "onboarding_required" || code === "telegram_environment_missing") return EXIT.ONBOARDING;
    if (code.startsWith("codex_")) return EXIT.DEGRADED;
    if (code === "runtime_unavailable" || code === "runtime_lock_busy" || code === "service_not_ready" || code.endsWith("_unavailable")) return EXIT.DEGRADED;
    if (code.includes("recovery") || code.includes("lock_lost") || code.includes("uncertain")) return EXIT.RECOVERY;
    if (code.includes("invalid") || code === "usage_invalid") return EXIT.USAGE;
    return EXIT.INTERNAL;
  }
}

export function isCliEntry(entry = process.argv[1], moduleFile = fileURLToPath(import.meta.url), resolveRealPath = realpathSync) {
  if (!entry) return false;
  try { return resolveRealPath(path.resolve(entry)) === resolveRealPath(moduleFile); }
  catch { return path.resolve(entry) === path.resolve(moduleFile); }
}

if (isCliEntry()) {
  runCli().then(function (code) { process.exitCode = code; }, function () { process.exitCode = EXIT.INTERNAL; });
}
