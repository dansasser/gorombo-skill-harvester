import { DELIVERY_ATTEMPT_TIMEOUT_MS } from "./constants.js";
import { createId } from "./ids.js";
import { claimTaskResult, completeTaskResult, deferTaskResultClaim, nextTaskResultDueAt, recoverExpiredTaskResultLeases, taskResultClaimReady } from "./tasks.js";

async function sendWithDeadline(sender, claim, controller, clock, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = clock.setTimeout(function () {
      controller.abort();
      resolve({ category: "ambiguous", safeError: { code: "task_result_timeout" } });
    }, timeoutMs);
  });
  const send = Promise.resolve().then(function () {
    return sender.sendText(claim.chatIdentity, claim.message, controller.signal);
  }).catch(function () {
    return { category: "ambiguous", safeError: { code: "task_result_unknown" } };
  });
  const result = await Promise.race([send, timeout]);
  if (timer !== null) clock.clearTimeout(timer);
  if (result && result.category === "accepted") {
    result.safeReceipt = { ...(result.safeReceipt || {}), method: "sendMessage", messageDigest: claim.messageDigest };
  }
  return result;
}

export class TaskResultDispatcher {
  constructor(options) {
    this.storage = options.storage;
    this.sender = options.sender || options.client;
    if (!this.storage || !this.sender || typeof this.sender.sendText !== "function") throw new Error("task_result_dispatcher_options_invalid");
    this.workerId = options.workerId || createId("run");
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
    this.attemptTimeoutMs = options.attemptTimeoutMs || DELIVERY_ATTEMPT_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs || 30_000;
    this.running = false;
    this.timer = null;
    this.generation = 0;
    this.pumpPromise = null;
    this.wakeAgain = false;
    this.activeAbort = null;
    this.lastErrorCode = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    recoverExpiredTaskResultLeases(this.storage, this.clock.now());
    this.wake();
  }

  wake() {
    if (!this.running) return;
    this.generation += 1;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.pumpPromise) {
      this.wakeAgain = true;
      return;
    }
    this.clock.queueMicrotask(() => { void this.pump().catch(function () {}); });
  }

  async pump() {
    if (!this.running || this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = (async () => {
      do {
        this.wakeAgain = false;
        recoverExpiredTaskResultLeases(this.storage, this.clock.now());
        let claim;
        while (this.running && (claim = claimTaskResult(this.storage, this.workerId, this.clock.now()))) {
          if (!taskResultClaimReady(this.storage, claim, this.clock.now())) {
            deferTaskResultClaim(this.storage, claim, "route_unavailable", this.clock.now());
            continue;
          }
          const controller = new AbortController();
          this.activeAbort = controller;
          let result;
          try { result = await sendWithDeadline(this.sender, claim, controller, this.clock, this.attemptTimeoutMs); }
          finally { if (this.activeAbort === controller) this.activeAbort = null; }
          try {
            completeTaskResult(this.storage, claim, result, this.clock.now());
            this.lastErrorCode = null;
          } catch {
            this.lastErrorCode = "task_result_adapter_invalid";
            try {
              completeTaskResult(this.storage, claim, { category: "permanent", safeError: { code: "task_result_adapter_invalid" } }, this.clock.now());
            } catch {}
          }
        }
      } while (this.running && this.wakeAgain);
    })();
    try { await this.pumpPromise; }
    finally {
      this.pumpPromise = null;
      if (this.running) this.schedule();
    }
  }

  schedule() {
    if (!this.running) return;
    const due = nextTaskResultDueAt(this.storage);
    if (due === null) return;
    const generation = ++this.generation;
    const delay = Math.max(0, Math.min(2_147_483_647, due - this.clock.now()));
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.running && generation === this.generation) this.wake();
    }, delay);
  }

  status() {
    return { running: this.running, errorCode: this.lastErrorCode };
  }

  async stop() {
    if (!this.running) return { status: "stopped" };
    this.running = false;
    this.generation += 1;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.activeAbort) this.activeAbort.abort();
    if (!this.pumpPromise) return { status: "stopped" };
    let graceTimer = null;
    const settled = await Promise.race([
      this.pumpPromise.then(function () { return true; }, function () { return true; }),
      new Promise((resolve) => { graceTimer = this.clock.setTimeout(function () { resolve(false); }, this.stopGraceMs); })
    ]);
    if (settled && graceTimer !== null) this.clock.clearTimeout(graceTimer);
    return { status: settled ? "stopped" : "grace_expired" };
  }
}
