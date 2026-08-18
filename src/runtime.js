import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./app-server.js";
import { AssessmentWorker } from "./assessment-worker.js";
import { buildCodexProcessEnv } from "./codex-process.js";
import { loadPrivateEnv, readConfig, taskPolicyFromEnv, telegramAllowedUsers } from "./config.js";
import { ControlServer } from "./control.js";
import { drainCompletionSpool, removeCompletionSpool, watchCompletionSpool } from "./completion-spool.js";
import { enqueueExternalTelegramAlert, ExternalAlertDispatcher } from "./external-alerts.js";
import { acceptCompletion, reconcileHarvester } from "./harvester.js";
import { sha256 } from "./ids.js";
import { OutboxDispatcher, enqueueTelegramRouteTest, pauseRoute, resumeRoute } from "./outbox.js";
import { approvePairing, primaryTelegramBinding, primaryTelegramBindingById } from "./pairing.js";
import { buildLayout, resolveCodexRoot } from "./paths.js";
import { preparePreflight } from "./preflight.js";
import { storageReadiness } from "./readiness.js";
import { acquireRuntimeLock, readHeartbeat, releaseRuntimeLock, writeHeartbeat } from "./runtime-lock.js";
import { clearSessionRoute, createSession, createSessionAdapter, listSessions, selectSession, testSessionRoute, verifySessionRoute } from "./session-route.js";
import { openStorage } from "./storage.js";
import { TaskResultDispatcher } from "./task-result-dispatcher.js";
import { TaskWorker } from "./task-worker.js";
import { cancelTaskById, recoverUncertainTasks } from "./tasks.js";
import { TelegramReplyDispatcher } from "./telegram-replies.js";
import { TelegramSendGate } from "./telegram-send-gate.js";
import { TelegramUpdateLoop } from "./telegram-update-loop.js";
import { TelegramClient } from "./telegram.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ROUTES = new Set(["telegram", "session"]);
const CONTROL_COMMANDS = new Set([
  "status", "wake", "completion.submit", "pair.approve", "route.test",
  "route.pause", "route.resume", "external-alert.enqueue", "task.cancel", "session.list",
  "session.select", "session.create", "session.clear", "shutdown"
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactPayload(payload, keys) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw codedError("control_payload_invalid");
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw codedError("control_payload_invalid");
  return payload;
}

function safeRoute(value) {
  if (!ROUTES.has(value)) throw codedError("route_invalid");
  return value;
}

function safeTaskId(value) {
  if (typeof value !== "string" || !/^tsk_[a-f0-9]{32}$/u.test(value)) throw codedError("task_id_invalid");
  return value;
}

function clockValue(value) {
  const clock = value || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
  if (typeof clock.now !== "function" || typeof clock.setTimeout !== "function" ||
      typeof clock.clearTimeout !== "function" || typeof clock.queueMicrotask !== "function") {
    throw codedError("runtime_clock_invalid");
  }
  return clock;
}

function stopWasUncertain(result) {
  return Boolean(result && (result.graceExpired === true || result.status === "grace_expired"));
}

function sessionTestMessage() {
  return [
    "Gorombo Skill Harvester",
    "",
    "Codex session delivery test",
    "",
    "This confirms that skill recommendation alerts can be delivered to the selected Codex session.",
    "No skill recommendation was created."
  ].join("\n");
}

function safeSessionRows(rows) {
  return rows.filter(function (row) { return row && typeof row.name === "string"; }).map(function (row) {
    return { name: row.name, status: typeof row.status === "string" ? row.status : "unknown" };
  });
}

function ensureTaskDirectory(policy) {
  if (!policy || typeof policy.cwd !== "string") throw codedError("task_cwd_missing");
  let info;
  try { info = fs.lstatSync(policy.cwd); }
  catch { throw codedError("task_cwd_invalid"); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw codedError("task_cwd_invalid");
}

export async function startRuntime(options = {}) {
  const clock = clockValue(options.clock);
  const heartbeatIntervalMs = options.heartbeatIntervalMs === undefined ? 30_000 : options.heartbeatIntervalMs;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs > 300_000) throw codedError("heartbeat_interval_invalid");

  const environment = options.env || process.env;
  let codexLaunchPlan = options.codexLaunchPlan || null;
  const preflightOptions = {
    ...(options.preflightOptions || {}),
    env: options.codexEnv || environment,
    executable: options.codexExecutable,
    launchPlan: codexLaunchPlan
  };
  let prepared;
  if (options.runPreflight) prepared = await options.runPreflight(preflightOptions);
  else prepared = await (options.preparePreflight || preparePreflight)(preflightOptions);
  if (!codexLaunchPlan && prepared && prepared.launchPlan) codexLaunchPlan = prepared.launchPlan;
  if (!codexLaunchPlan) throw codedError("codex_launch_plan_missing");
  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: environment, home: options.home });
  const layout = buildLayout(codexRoot);
  let config;
  try { config = await readConfig(layout.configFile); }
  catch (error) {
    if (error && error.code === "ENOENT") throw codedError("onboarding_required");
    throw error;
  }
  const priorHeartbeat = await readHeartbeat(layout);
  if (priorHeartbeat && priorHeartbeat.state === "RECOVERY_REQUIRED") throw codedError("runtime_recovery_required");

  let privateEnv = Object.create(null);
  let telegramToken = null;
  let allowedUsers = null;
  let taskPolicy = null;
  if (config.telegram.enabled) {
    try { privateEnv = options.privateEnv || await loadPrivateEnv(layout.environmentFile); }
    catch (error) {
      if (error && error.code === "ENOENT") throw codedError("telegram_environment_missing");
      throw error;
    }
    telegramToken = privateEnv[config.telegram.tokenEnv];
    if (typeof telegramToken !== "string" || telegramToken.length < 8) throw codedError("telegram_token_missing");
    allowedUsers = telegramAllowedUsers(privateEnv);
    taskPolicy = taskPolicyFromEnv(privateEnv);
    ensureTaskDirectory(taskPolicy);
  }

  const storage = openStorage(layout.databaseFile, { create: false });
  const integrity = storage.integrityCheck();
  if (!integrity.ok) {
    storage.close();
    throw codedError("storage_integrity_failed");
  }

  let ownership = null;
  let control = null;
  let assessmentWorker = null;
  let outbox = null;
  let telegramClient = null;
  let telegramIdentity = null;
  let telegramGate = null;
  let telegramReplies = null;
  let externalAlerts = null;
  let taskResults = null;
  let taskWorker = null;
  let telegramUpdates = null;
  let appClient = null;
  let completionWatcher = null;
  let completionDrainTail = Promise.resolve();
  let heartbeatTimer = null;
  let heartbeatInFlight = null;
  let shutdownTimer = null;
  let stopping = false;
  let stopped = false;
  let stopPromise = null;
  let runtimeState = "STARTING";
  let generation = 0;
  let lastHeartbeatAt = null;
  const componentErrors = { telegram: null, session: null, runtime: null, completion: null };
  let resolveDone;
  const done = new Promise(function (resolve) { resolveDone = resolve; });
  const pluginRoot = options.pluginRoot || PACKAGE_ROOT;
  const adapters = Object.create(null);

  function baseStatus() {
    return storageReadiness(storage, {
      heartbeatAgeMs: lastHeartbeatAt === null ? null : Math.max(0, clock.now() - lastHeartbeatAt)
    });
  }

  function healthState() {
    const snapshot = baseStatus();
    const updateStatus = telegramUpdates ? telegramUpdates.status() : null;
    const taskStatus = taskWorker ? taskWorker.status() : null;
    const resultStatus = taskResults ? taskResults.status() : null;
    const externalAlertStatus = externalAlerts ? externalAlerts.status() : null;
    if (snapshot.recoveryRequired || componentErrors.runtime || componentErrors.completion) return "RECOVERY_REQUIRED";
    const transportDegraded = config.telegram.enabled && (
      componentErrors.telegram ||
      !updateStatus || !updateStatus.running || Boolean(updateStatus.errorCode) ||
      !telegramReplies || !telegramReplies.running ||
      !externalAlertStatus || !externalAlertStatus.running ||
      !taskStatus || !taskStatus.running || Boolean(taskStatus.errorCode) ||
      !resultStatus || !resultStatus.running || Boolean(resultStatus.errorCode)
    );
    const workerDegraded = !assessmentWorker || !assessmentWorker.running || !outbox || !outbox.running;
    if (snapshot.status === "READY" && !transportDegraded && !workerDegraded && !componentErrors.session) return "RUNNING";
    return "DEGRADED";
  }

  async function writeState(state) {
    generation += 1;
    const record = await writeHeartbeat(layout, ownership, state, generation, clock.now());
    runtimeState = state;
    lastHeartbeatAt = record.observedAt;
    return record;
  }

  async function publishHealth() {
    if (stopping || stopped) return runtimeState;
    const state = healthState();
    await writeState(state);
    return state;
  }

  function armHeartbeat() {
    if (stopping || stopped || heartbeatTimer !== null) return;
    heartbeatTimer = clock.setTimeout(function () {
      heartbeatTimer = null;
      if (stopping || stopped) return;
      heartbeatInFlight = publishHealth().catch(function () {
        componentErrors.runtime = "runtime_heartbeat_failed";
        runtimeState = "RECOVERY_REQUIRED";
      }).finally(function () {
        heartbeatInFlight = null;
        armHeartbeat();
      });
    }, heartbeatIntervalMs);
  }

  async function drainCompletionInbox() {
    const run = completionDrainTail.then(async function () {
      let processed = 0;
      for (;;) {
        const batch = await (options.drainCompletionSpool || drainCompletionSpool)(storage, layout, { now: clock.now(), limit: 256 });
        processed += batch.processed;
        if (batch.remaining === 0) break;
      }
      componentErrors.completion = null;
      if (processed > 0 && assessmentWorker) assessmentWorker.wake();
      return processed;
    });
    completionDrainTail = run.catch(function () {});
    return await run.catch(function (error) {
      componentErrors.completion = "completion_spool_unavailable";
      throw error;
    });
  }

  function requestCompletionDrain() {
    void drainCompletionInbox().catch(function () {
      if (!stopping && !stopped) void publishHealth().catch(function () {});
    });
  }

  function wakeAll() {
    if (assessmentWorker) assessmentWorker.wake();
    if (outbox) outbox.wake();
    if (telegramReplies) telegramReplies.wake();
    if (externalAlerts) externalAlerts.wake();
    if (taskResults) taskResults.wake();
    if (taskWorker) taskWorker.wake();
  }

  function safeStatus() {
    const snapshot = baseStatus();
    const updateStatus = telegramUpdates ? telegramUpdates.status() : null;
    const taskStatus = taskWorker ? taskWorker.status() : null;
    const resultStatus = taskResults ? taskResults.status() : null;
    const externalAlertStatus = externalAlerts ? externalAlerts.status() : null;
    const displayedState = stopping || stopped ? runtimeState : healthState();
    return {
      ...snapshot,
      status: displayedState,
      runtime: {
        serving: !stopping && !stopped,
        completionHandoff: {
          watching: Boolean(completionWatcher),
          errorCode: componentErrors.completion
        },
        telegram: {
          selected: config.telegram.enabled,
          running: Boolean(telegramUpdates && updateStatus && updateStatus.running),
          errorCode: componentErrors.telegram || updateStatus && updateStatus.errorCode || null
        },
        session: {
          selected: config.session.enabled,
          running: Boolean(appClient && !componentErrors.session),
          errorCode: componentErrors.session
        },
        workers: {
          assessment: Boolean(assessmentWorker && assessmentWorker.running),
          delivery: Boolean(outbox && outbox.running),
          externalAlerts: Boolean(externalAlerts && externalAlertStatus && externalAlertStatus.running),
          tasks: Boolean(taskWorker && taskStatus && taskStatus.running),
          taskResults: Boolean(taskResults && resultStatus && resultStatus.running)
        }
      }
    };
  }

  async function controlHandler(command, payload) {
    if (!CONTROL_COMMANDS.has(command)) throw codedError("control_command_unsupported");
    if (stopping && command !== "status") throw codedError("runtime_stopping");

    if (command === "status") {
      exactPayload(payload, []);
      return safeStatus();
    }
    if (command === "wake") {
      exactPayload(payload, []);
      await drainCompletionInbox();
      wakeAll();
      return { status: "woken" };
    }
    if (command === "completion.submit") {
      exactPayload(payload, ["event"]);
      const result = acceptCompletion(storage, payload.event, clock.now());
      await (options.removeCompletionSpool || removeCompletionSpool)(layout, payload.event);
      if (assessmentWorker) assessmentWorker.wake();
      return { status: result.status };
    }
    if (command === "external-alert.enqueue") {
      exactPayload(payload, ["key", "message"]);
      if (!telegramIdentity || !allowedUsers || !externalAlerts) throw codedError("telegram_unavailable");
      const binding = primaryTelegramBinding(storage, telegramIdentity.botIdentity, allowedUsers);
      if (!binding) throw codedError("telegram_unpaired");
      const result = enqueueExternalTelegramAlert(storage, {
        key: payload.key,
        message: payload.message,
        targetBindingId: binding.id
      }, clock.now());
      externalAlerts.wake();
      return { result: result.result };
    }
    if (command === "pair.approve") {
      exactPayload(payload, ["code"]);
      if (!telegramIdentity || !telegramToken || !telegramReplies) throw codedError("telegram_unavailable");
      const result = approvePairing(storage, {
        code: payload.code,
        botIdentity: telegramIdentity.botIdentity,
        token: telegramToken
      }, clock.now());
      if (result.wakeReplies) telegramReplies.wake();
      await publishHealth();
      return { status: "approved" };
    }
    if (command === "route.test") {
      exactPayload(payload, ["route"]);
      const route = safeRoute(payload.route);
      if (route === "telegram") {
        if (!telegramIdentity || !allowedUsers || !outbox) throw codedError("telegram_unavailable");
        const queued = enqueueTelegramRouteTest(storage, {
          botIdentity: telegramIdentity.botIdentity,
          allowedUsers
        }, clock.now());
        outbox.wake();
        return { status: queued.status, route };
      }
      if (!appClient) throw codedError("session_unavailable");
      const message = sessionTestMessage();
      const result = await testSessionRoute(storage, appClient, message, sha256(Buffer.from(message, "utf8")), {
        now: clock.now,
        timeoutMs: options.sessionTimeoutMs
      });
      if (result.category === "accepted") componentErrors.session = null;
      await publishHealth();
      return { status: result.category === "accepted" ? "accepted" : "not_accepted", category: result.category, route };
    }
    if (command === "route.pause") {
      exactPayload(payload, ["route"]);
      const route = safeRoute(payload.route);
      const current = storage.getRoute(route);
      if (!current || !current.selected) throw codedError("route_unconfigured");
      const paused = pauseRoute(storage, route, "route_disabled", clock.now());
      await publishHealth();
      return { status: "paused", route, deliveries: paused };
    }
    if (command === "route.resume") {
      exactPayload(payload, ["route"]);
      const route = safeRoute(payload.route);
      if (route === "session") throw codedError("session_reselection_required");
      const current = storage.getRoute(route);
      if (!current || !current.selected || current.state !== "DEGRADED") throw codedError("route_resume_invalid");
      if (!telegramIdentity || !primaryTelegramBinding(storage, telegramIdentity.botIdentity, allowedUsers)) throw codedError("telegram_unpaired");
      const resumed = resumeRoute(storage, route, clock.now());
      if (outbox) outbox.wake();
      if (externalAlerts) externalAlerts.wake();
      await publishHealth();
      return { status: "resumed", route, deliveries: resumed };
    }
    if (command === "task.cancel") {
      exactPayload(payload, ["taskId"]);
      const taskId = safeTaskId(payload.taskId);
      if (!taskWorker || !taskResults) throw codedError("tasks_unavailable");
      const result = cancelTaskById(storage, taskId, clock.now());
      if (!result) return { status: "not_active" };
      if (result.state === "cancelled") {
        taskResults.wake();
        return { status: "cancelled" };
      }
      return { status: taskWorker.cancel(taskId) ? "aborting" : "not_active" };
    }
    if (command === "session.list") {
      exactPayload(payload, []);
      if (!appClient) throw codedError("session_unavailable");
      const rows = await listSessions(appClient);
      componentErrors.session = null;
      return { sessions: safeSessionRows(rows) };
    }
    if (command === "session.select") {
      exactPayload(payload, ["name"]);
      if (!appClient) throw codedError("session_unavailable");
      const selected = await selectSession(storage, appClient, payload.name, clock.now());
      componentErrors.session = null;
      await publishHealth();
      return { status: selected.state.toLowerCase(), name: selected.displayName };
    }
    if (command === "session.create") {
      exactPayload(payload, ["name", "workingDirectory"]);
      if (!appClient) throw codedError("session_unavailable");
      const selected = await createSession(storage, appClient, payload.name, payload.workingDirectory, clock.now());
      componentErrors.session = null;
      await publishHealth();
      return { status: selected.state.toLowerCase(), name: selected.displayName };
    }
    if (command === "session.clear") {
      exactPayload(payload, []);
      if (!appClient) throw codedError("session_unavailable");
      const result = clearSessionRoute(storage, clock.now());
      await publishHealth();
      return result;
    }
    exactPayload(payload, []);
    if (shutdownTimer === null) {
      shutdownTimer = clock.setTimeout(function () {
        shutdownTimer = null;
        void stopRuntime();
      }, 10);
    }
    return { status: "shutdown_requested" };
  }

  async function stopComponent(component) {
    if (!component || typeof component.stop !== "function") return false;
    try { return stopWasUncertain(await component.stop()); }
    catch { return true; }
  }

  async function stopRuntime() {
    if (stopPromise) return await stopPromise;
    stopPromise = (async function () {
      stopping = true;
      let recoveryRequired = false;
      if (shutdownTimer !== null) {
        clock.clearTimeout(shutdownTimer);
        shutdownTimer = null;
      }
      if (heartbeatTimer !== null) {
        clock.clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (heartbeatInFlight) {
        try { await heartbeatInFlight; }
        catch { recoveryRequired = true; }
      }
      if (completionWatcher) {
        try { completionWatcher.close(); }
        catch { recoveryRequired = true; }
        completionWatcher = null;
      }
      try { await completionDrainTail; }
      catch { recoveryRequired = true; }
      if (componentErrors.completion) recoveryRequired = true;
      try { await writeState("STOPPING"); }
      catch {
        recoveryRequired = true;
        componentErrors.runtime = "runtime_lock_lost";
        runtimeState = "RECOVERY_REQUIRED";
      }

      recoveryRequired = await stopComponent(telegramUpdates) || recoveryRequired;
      recoveryRequired = await stopComponent(taskWorker) || recoveryRequired;
      recoveryRequired = await stopComponent(assessmentWorker) || recoveryRequired;
      recoveryRequired = await stopComponent(outbox) || recoveryRequired;
      recoveryRequired = await stopComponent(externalAlerts) || recoveryRequired;
      recoveryRequired = await stopComponent(telegramReplies) || recoveryRequired;
      recoveryRequired = await stopComponent(taskResults) || recoveryRequired;
      if (telegramGate) telegramGate.close();
      if (appClient) {
        try { await appClient.close(); }
        catch { recoveryRequired = true; }
      }
      if (control) {
        try { await control.close(); }
        catch { recoveryRequired = true; }
      }
      if (!recoveryRequired) {
        try { storage.close(); }
        catch { recoveryRequired = true; }
      }
      try { await writeState(recoveryRequired ? "RECOVERY_REQUIRED" : "STOPPED"); }
      catch {
        recoveryRequired = true;
        runtimeState = "RECOVERY_REQUIRED";
      }
      if (!recoveryRequired) {
        let released = false;
        try { released = await releaseRuntimeLock(layout, ownership); }
        catch {}
        if (!released) {
          recoveryRequired = true;
          runtimeState = "RECOVERY_REQUIRED";
          try { await writeState("RECOVERY_REQUIRED"); } catch {}
        }
      }
      stopping = false;
      stopped = true;
      const result = { status: recoveryRequired ? "recovery_required" : "stopped" };
      resolveDone(result);
      return result;
    })();
    return await stopPromise;
  }

  try {
    ownership = await acquireRuntimeLock(layout, options.lockOptions || {});
    await writeState("STARTING");
    completionWatcher = await (options.watchCompletionSpool || watchCompletionSpool)(
      layout,
      requestCompletionDrain,
      function () {
        componentErrors.completion = "completion_spool_watch_failed";
        runtimeState = "RECOVERY_REQUIRED";
        if (!stopping && !stopped) void writeState("RECOVERY_REQUIRED").catch(function () {});
      }
    );
    await drainCompletionInbox();
    control = options.controlServer || new ControlServer(layout, controlHandler, { ownership });
    await control.start();

    await reconcileHarvester(storage, layout, function () {}, clock.now());
    recoverUncertainTasks(storage, clock.now());

    if (config.session.enabled) {
      appClient = options.appServerClient || new CodexAppServerClient({
        executable: options.codexExecutable,
        launchPlan: codexLaunchPlan,
        cwd: options.sessionWorkingDirectory || taskPolicy && taskPolicy.cwd || pluginRoot,
        env: options.codexEnv || environment,
        requestTimeoutMs: options.sessionTimeoutMs
      });
      adapters.session = createSessionAdapter({
        storage,
        client: appClient,
        timeoutMs: options.sessionTimeoutMs,
        now: clock.now
      });
      try {
        await appClient.start();
        const binding = storage.db.prepare("SELECT 1 AS present FROM session_routes LIMIT 1").get();
        if (binding) {
          const verified = await verifySessionRoute(storage, appClient, { allowSelected: true, now: clock.now() });
          if (!verified.ok) componentErrors.session = verified.result.safeError.code;
        }
      } catch {
        componentErrors.session = "session_unavailable";
        const route = storage.getRoute("session");
        if (route && route.selected) storage.setRouteState("session", "DEGRADED", clock.now());
      }
    }

    if (config.telegram.enabled) {
      telegramClient = options.telegramClient || new TelegramClient({
        token: telegramToken,
        fetch: options.fetch,
        now: clock.now
      });
      try {
        telegramIdentity = await telegramClient.getIdentity();
        telegramGate = new TelegramSendGate({ client: telegramClient, clock });
        const bindingProvider = async function (targetBindingId) {
          return targetBindingId
            ? primaryTelegramBindingById(storage, targetBindingId, telegramIdentity.botIdentity, allowedUsers)
            : primaryTelegramBinding(storage, telegramIdentity.botIdentity, allowedUsers);
        };
        adapters.telegram = telegramGate.alertAdapter(bindingProvider);
        externalAlerts = new ExternalAlertDispatcher({
          storage,
          adapter: adapters.telegram,
          resolveBinding: function () {
            return primaryTelegramBinding(storage, telegramIdentity.botIdentity, allowedUsers);
          },
          clock,
          attemptTimeoutMs: options.deliveryTimeoutMs,
          stopGraceMs: options.stopGraceMs
        });
        telegramReplies = new TelegramReplyDispatcher({
          storage,
          client: telegramGate,
          clock,
          attemptTimeoutMs: options.deliveryTimeoutMs,
          stopGraceMs: options.stopGraceMs
        });
        taskResults = new TaskResultDispatcher({
          storage,
          sender: telegramGate,
          clock,
          attemptTimeoutMs: options.deliveryTimeoutMs,
          stopGraceMs: options.stopGraceMs
        });
        taskWorker = new TaskWorker({
          storage,
          runTask: options.runTask,
          taskPolicy,
          allowedUsers,
          executable: options.codexExecutable,
          launchPlan: codexLaunchPlan,
          env: buildCodexProcessEnv({}, options.codexEnv || environment, options.allowedEnvKeys || []),
          allowedEnvKeys: options.allowedEnvKeys || [],
          clock,
          stopGraceMs: options.stopGraceMs,
          onResultQueued: async function () { taskResults.wake(); }
        });
        telegramUpdates = new TelegramUpdateLoop({
          storage,
          client: telegramClient,
          context: {
            botIdentity: telegramIdentity.botIdentity,
            username: telegramIdentity.username,
            token: telegramToken,
            allowedUsers,
            randomBytes: options.randomBytes
          },
          clock,
          stopGraceMs: options.stopGraceMs,
          onResult: async function (result) {
            if (result.wakeReplies) telegramReplies.wake();
            if (result.wakeTasks) taskWorker.wake();
            if (result.wakeTaskResults) taskResults.wake();
            if (result.abortTaskId) taskWorker.cancel(result.abortTaskId);
          }
        });
      } catch {
        componentErrors.telegram = "telegram_unavailable";
        const route = storage.getRoute("telegram");
        if (route && route.selected) storage.setRouteState("telegram", "DEGRADED", clock.now());
      }
    }

    outbox = new OutboxDispatcher({
      storage,
      adapters,
      clock,
      attemptTimeoutMs: options.deliveryTimeoutMs,
      stopGraceMs: options.stopGraceMs,
      onCompleted: async function () {
        if (externalAlerts) externalAlerts.wake();
      }
    });
    assessmentWorker = new AssessmentWorker({
      storage,
      layout,
      pluginRoot,
      config,
      executable: options.codexExecutable,
      launchPlan: codexLaunchPlan,
      env: options.codexEnv || environment,
      assess: options.assess,
      publish: options.publish,
      wakeDeliveries: async function () { outbox.wake(); },
      clock,
      stopGraceMs: options.stopGraceMs
    });

    assessmentWorker.start();
    outbox.start();
    if (externalAlerts) externalAlerts.start();
    if (telegramReplies) telegramReplies.start();
    if (taskResults) taskResults.start();
    if (taskWorker) taskWorker.start();
    if (telegramUpdates) telegramUpdates.start();
    await publishHealth();
    armHeartbeat();

    return {
      layout,
      ownership,
      storage,
      components: {
        assessmentWorker,
        outbox,
        externalAlerts,
        telegramReplies,
        taskResults,
        taskWorker,
        telegramUpdates,
        telegramGate,
        appClient,
        completionWatcher
      },
      status: safeStatus,
      handleControl: controlHandler,
      stop: stopRuntime,
      done
    };
  } catch (error) {
    stopping = true;
    let cleanupUncertain = false;
    if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
    if (completionWatcher) {
      try { completionWatcher.close(); }
      catch { cleanupUncertain = true; }
      completionWatcher = null;
    }
    try { await completionDrainTail; } catch { cleanupUncertain = true; }
    cleanupUncertain = await stopComponent(telegramUpdates) || cleanupUncertain;
    cleanupUncertain = await stopComponent(taskWorker) || cleanupUncertain;
    cleanupUncertain = await stopComponent(assessmentWorker) || cleanupUncertain;
    cleanupUncertain = await stopComponent(outbox) || cleanupUncertain;
    cleanupUncertain = await stopComponent(externalAlerts) || cleanupUncertain;
    cleanupUncertain = await stopComponent(telegramReplies) || cleanupUncertain;
    cleanupUncertain = await stopComponent(taskResults) || cleanupUncertain;
    if (telegramGate) telegramGate.close();
    try { if (appClient) await appClient.close(); } catch { cleanupUncertain = true; }
    try { if (control) await control.close(); } catch { cleanupUncertain = true; }
    if (ownership) {
      try { await writeState("RECOVERY_REQUIRED"); } catch { cleanupUncertain = true; }
    }
    if (!cleanupUncertain) {
      try { storage.close(); } catch { cleanupUncertain = true; }
    }
    if (ownership && !cleanupUncertain) {
      try { await releaseRuntimeLock(layout, ownership); } catch {}
    }
    throw error;
  }
}
