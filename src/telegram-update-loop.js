import { processTelegramUpdate, readTelegramCursor } from "./telegram-inbound.js";

function retryDelay(failures) {
  return Math.min(30_000, 1000 * (2 ** Math.min(5, Math.max(0, failures - 1))));
}

function orderedUpdateBatch(updates) {
  if (!Array.isArray(updates) || updates.length > 100) throw new Error("telegram_updates_contract_invalid");
  const seen = new Set();
  const ordered = updates.slice();
  for (const update of ordered) {
    if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER || seen.has(update.update_id)) {
      throw new Error("telegram_updates_contract_invalid");
    }
    seen.add(update.update_id);
  }
  ordered.sort(function (left, right) { return left.update_id - right.update_id; });
  return ordered;
}

export class TelegramUpdateLoop {
  constructor(options) {
    this.storage = options.storage;
    this.client = options.client;
    this.context = options.context;
    this.processUpdate = options.processUpdate || processTelegramUpdate;
    this.onResult = options.onResult || async function () {};
    this.clock = options.clock || { now: Date.now, setTimeout, clearTimeout, queueMicrotask };
    this.stopGraceMs = options.stopGraceMs || 30_000;
    this.running = false;
    this.cursor = null;
    this.loopPromise = null;
    this.activeAbort = null;
    this.retryTimer = null;
    this.retryResolve = null;
    this.lastErrorCode = null;
    this.failures = 0;
  }

  start() {
    if (this.running) return;
    this.cursor = readTelegramCursor(this.storage);
    this.running = true;
    this.clock.queueMicrotask(() => { void this.run().catch(function () {}); });
  }

  async waitAfterFailure() {
    const delay = retryDelay(this.failures);
    await new Promise((resolve) => {
      this.retryResolve = resolve;
      this.retryTimer = this.clock.setTimeout(resolve, delay);
    });
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryResolve = null;
  }

  async publishResult(result) {
    while (this.running) {
      try {
        await this.onResult(result);
        this.failures = 0;
        this.lastErrorCode = null;
        return true;
      } catch {
        this.failures += 1;
        this.lastErrorCode = "telegram_result_wake_failed";
        await this.waitAfterFailure();
      }
    }
    return false;
  }

  async run() {
    if (!this.running || this.loopPromise) return this.loopPromise;
    this.loopPromise = (async () => {
      while (this.running) {
        const controller = new AbortController();
        this.activeAbort = controller;
        let updates;
        try {
          updates = orderedUpdateBatch(await this.client.getUpdates(this.cursor, controller.signal));
        } catch (error) {
          if (!this.running || controller.signal.aborted) break;
          this.failures += 1;
          this.lastErrorCode = error && error.message === "telegram_updates_contract_invalid"
            ? "telegram_updates_contract_invalid"
            : "telegram_updates_failed";
          await this.waitAfterFailure();
          continue;
        } finally {
          if (this.activeAbort === controller) this.activeAbort = null;
        }
        let processingFailed = false;
        for (const update of updates) {
          if (!this.running) break;
          let result;
          try {
            result = await this.processUpdate(this.storage, update, this.context, this.clock.now());
            if (!result || !Number.isSafeInteger(result.cursor) || result.cursor < this.cursor) throw new Error("telegram_cursor_invalid");
            this.cursor = result.cursor;
          } catch {
            this.failures += 1;
            this.lastErrorCode = "telegram_update_processing_failed";
            processingFailed = true;
            break;
          }
          if (!await this.publishResult(result)) break;
        }
        if (!this.running) break;
        if (processingFailed) {
          this.cursor = readTelegramCursor(this.storage);
          await this.waitAfterFailure();
          continue;
        }
        this.failures = 0;
        this.lastErrorCode = null;
      }
    })();
    try { await this.loopPromise; }
    finally { this.loopPromise = null; }
  }

  status() {
    return {
      running: this.running,
      cursor: this.cursor,
      failureCount: this.failures,
      errorCode: this.lastErrorCode
    };
  }

  async stop() {
    if (!this.running) return { status: "stopped" };
    this.running = false;
    if (this.activeAbort) this.activeAbort.abort();
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.retryResolve) this.retryResolve();
    this.retryResolve = null;
    if (!this.loopPromise) return { status: "stopped" };
    let graceTimer = null;
    const settled = await Promise.race([
      this.loopPromise.then(function () { return true; }, function () { return true; }),
      new Promise((resolve) => { graceTimer = this.clock.setTimeout(function () { resolve(false); }, this.stopGraceMs); })
    ]);
    if (settled && graceTimer !== null) this.clock.clearTimeout(graceTimer);
    return { status: settled ? "stopped" : "grace_expired" };
  }
}
