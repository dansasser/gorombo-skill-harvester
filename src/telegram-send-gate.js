export class TelegramSendGate {
  constructor(options) {
    if (!options || !options.client || typeof options.client.sendText !== "function") throw new Error("telegram_send_gate_options_invalid");
    this.client = options.client;
    this.clock = options.clock || { queueMicrotask };
    this.queue = [];
    this.active = null;
    this.closed = false;
  }

  sendText(chatIdentity, message, signal) {
    if (this.closed) return Promise.resolve({ category: "retryable", safeError: { code: "telegram_sender_stopped" } });
    return new Promise((resolve) => {
      const entry = { chatIdentity, message, signal, resolve, started: false, abort: null };
      entry.abort = () => {
        if (entry.started) return;
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        resolve({ category: "retryable", safeError: { code: "telegram_send_cancelled_before_start" } });
        this.clock.queueMicrotask(() => { void this.drain(); });
      };
      if (signal && signal.aborted) return entry.abort();
      if (signal) signal.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.clock.queueMicrotask(() => { void this.drain(); });
    });
  }

  async drain() {
    if (this.closed || this.active) return;
    const entry = this.queue.shift();
    if (!entry) return;
    entry.started = true;
    if (entry.signal) entry.signal.removeEventListener("abort", entry.abort);
    if (entry.signal && entry.signal.aborted) {
      entry.resolve({ category: "retryable", safeError: { code: "telegram_send_cancelled_before_start" } });
      this.clock.queueMicrotask(() => { void this.drain(); });
      return;
    }
    this.active = entry;
    let result;
    try {
      result = await this.client.sendText(entry.chatIdentity, entry.message, entry.signal);
    } catch {
      result = { category: "ambiguous", safeError: { code: "telegram_send_unknown" } };
    }
    if (this.active === entry) this.active = null;
    entry.resolve(result);
    this.clock.queueMicrotask(() => { void this.drain(); });
  }

  alertAdapter(bindingProvider) {
    return {
      send: async (envelope, signal) => {
        const binding = await bindingProvider(envelope && envelope.targetBindingId ? envelope.targetBindingId : null);
        if (!binding) return { category: "routeBlocked", safeError: { code: "telegram_unpaired" } };
        const result = await this.sendText(binding.chatIdentity, envelope.plainText, signal);
        if (result && result.category === "accepted") {
          result.safeReceipt = { ...(result.safeReceipt || {}), renderedDigest: envelope.renderedDigest };
        }
        return result;
      }
    };
  }

  status() {
    return { closed: this.closed, active: Boolean(this.active), queued: this.queue.length };
  }

  close() {
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      if (entry.signal) entry.signal.removeEventListener("abort", entry.abort);
      entry.resolve({ category: "retryable", safeError: { code: "telegram_sender_stopped" } });
    }
  }
}
