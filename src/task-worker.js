import { runCodexTask } from "./codex-process.js";
import { claimTask, completeTask, markTaskClaimRecoveryRequired, taskClaimReady } from "./tasks.js";

function notificationDelay(failures) {
  return Math.min(30_000, 1000 * (2 ** Math.min(5, Math.max(0, failures - 1))));
}

export class TaskWorker {
  constructor(options) {
    if (!options || !options.storage || !options.taskPolicy || typeof options.taskPolicy.cwd !== "string" || !(options.allowedUsers instanceof Set)) throw new Error("task_worker_options_invalid");
    this.storage = options.storage;
    this.runTask = options.runTask || runCodexTask;
    this.taskPolicy = { ...options.taskPolicy };
    this.allowedUsers = new Set(options.allowedUsers);
    this.executable = options.executable;
    this.launchPlan = options.launchPlan || null;
    this.env = options.env || {};
    this.allowedEnvKeys = options.allowedEnvKeys || [];
    this.onResultQueued = options.onResultQueued || async function () {};
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
    this.stopGraceMs = options.stopGraceMs || 30_000;
    this.running = false;
    this.pumpPromise = null;
    this.wakeAgain = false;
    this.active = null;
    this.notifyTimer = null;
    this.notifyResolve = null;
    this.notificationFailures = 0;
    this.lastErrorCode = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.wake();
  }

  wake() {
    if (!this.running) return;
    if (this.pumpPromise) {
      this.wakeAgain = true;
      return;
    }
    this.clock.queueMicrotask(() => { void this.pump().catch(function () {}); });
  }

  async waitForNotificationRetry() {
    await new Promise((resolve) => {
      this.notifyResolve = resolve;
      this.notifyTimer = this.clock.setTimeout(resolve, notificationDelay(this.notificationFailures));
    });
    if (this.notifyTimer !== null) this.clock.clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.notifyResolve = null;
  }

  async publishResult(completion) {
    while (this.running) {
      try {
        await this.onResultQueued(completion);
        this.notificationFailures = 0;
        this.lastErrorCode = null;
        return true;
      } catch {
        this.notificationFailures += 1;
        this.lastErrorCode = "task_result_wake_failed";
        await this.waitForNotificationRetry();
      }
    }
    return false;
  }

  async pump() {
    if (!this.running || this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = (async () => {
      do {
        this.wakeAgain = false;
        let claim;
        while (this.running && (claim = claimTask(this.storage, this.clock.now()))) {
          const active = { claim, controller: new AbortController(), abandoned: false };
          this.active = active;
          if (!taskClaimReady(this.storage, claim, this.allowedUsers)) {
            markTaskClaimRecoveryRequired(this.storage, claim, "binding_or_user_inactive", this.clock.now());
            if (this.active === active) this.active = null;
            continue;
          }
          let result;
          try {
            result = await this.runTask({
              prompt: claim.requestText,
              cwd: this.taskPolicy.cwd,
              sandbox: this.taskPolicy.sandbox,
              model: this.taskPolicy.model,
              executable: this.executable,
              launchPlan: this.launchPlan,
              env: this.env,
              allowedEnvKeys: this.allowedEnvKeys,
              timeoutMs: this.taskPolicy.timeoutMs,
              signal: active.controller.signal
            });
          } catch {
            result = { ok: false, category: "execution", safeMessage: "The Codex task did not complete successfully." };
          }
          if (this.active === active) this.active = null;
          if (active.abandoned) continue;
          if (result && result.ok === false && result.category === "termination_unconfirmed") {
            markTaskClaimRecoveryRequired(this.storage, claim, "task_termination_unconfirmed", this.clock.now());
            this.lastErrorCode = "task_termination_unconfirmed";
            this.running = false;
            break;
          }
          if (!result || typeof result !== "object" || (result.ok !== true && result.ok !== false)) {
            result = { ok: false, category: "execution", safeMessage: "The Codex task returned an invalid result." };
          }
          let completion;
          try {
            completion = completeTask(this.storage, claim, result, this.clock.now());
          } catch {
            markTaskClaimRecoveryRequired(this.storage, claim, "task_completion_invalid", this.clock.now());
            completion = null;
            this.lastErrorCode = "task_completion_invalid";
          }
          if (completion && completion.status !== "stale" && completion.deliveryId) await this.publishResult(completion);
        }
      } while (this.running && this.wakeAgain);
    })();
    try { await this.pumpPromise; }
    finally {
      this.pumpPromise = null;
      if (this.running && this.wakeAgain) this.wake();
    }
  }

  cancel(taskId) {
    if (!this.active || this.active.claim.taskId !== taskId || this.active.abandoned) return false;
    this.active.controller.abort();
    return true;
  }

  status() {
    return {
      running: this.running,
      activeTaskId: this.active ? this.active.claim.taskId : null,
      notificationFailures: this.notificationFailures,
      errorCode: this.lastErrorCode
    };
  }

  async stop() {
    if (!this.running && !this.pumpPromise) return { status: "stopped" };
    this.running = false;
    this.wakeAgain = false;
    if (this.notifyTimer !== null) this.clock.clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    if (this.notifyResolve) this.notifyResolve();
    this.notifyResolve = null;
    if (this.active) this.active.controller.abort();
    if (!this.pumpPromise) return { status: "stopped" };
    let graceTimer = null;
    const settled = await Promise.race([
      this.pumpPromise.then(function () { return true; }, function () { return true; }),
      new Promise((resolve) => { graceTimer = this.clock.setTimeout(function () { resolve(false); }, this.stopGraceMs); })
    ]);
    if (settled && graceTimer !== null) this.clock.clearTimeout(graceTimer);
    if (!settled && this.active) {
      this.active.abandoned = true;
      markTaskClaimRecoveryRequired(this.storage, this.active.claim, "task_stop_uncertain", this.clock.now());
      this.lastErrorCode = "task_stop_uncertain";
    }
    return { status: settled ? "stopped" : "grace_expired" };
  }
}
