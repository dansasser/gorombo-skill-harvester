import { TELEGRAM_MESSAGE_LIMIT } from "./constants.js";
import { normalizeTelegramIdentity } from "./pairing.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

function tokenValue(token) {
  if (typeof token !== "string" || token.length < 8 || token.length > 4096 || /\s/u.test(token)) throw new Error("telegram_token_invalid");
  return token;
}

async function boundedJson(response) {
  const declared = response.headers && response.headers.get ? Number(response.headers.get("content-length")) : 0;
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("telegram_response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("telegram_response_too_large");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("telegram_response_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("telegram_response_invalid");
  return value;
}

function retryAfter(body) {
  const seconds = body && body.parameters && body.parameters.retry_after;
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export class TelegramClient {
  constructor(options) {
    this.token = tokenValue(options.token);
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    if (typeof this.fetch !== "function") throw new Error("telegram_fetch_unavailable");
    if (typeof this.now !== "function") throw new Error("telegram_clock_invalid");
    this.baseUrl = "https://api.telegram.org/bot" + this.token + "/";
  }

  async call(method, payload, signal) {
    const response = await this.fetch(this.baseUrl + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal
    });
    const body = await boundedJson(response);
    return { response, body };
  }

  async getIdentity(signal) {
    const { response, body } = await this.call("getMe", {}, signal);
    if (!response.ok || body.ok !== true || !body.result) throw new Error(response.status === 401 ? "telegram_token_rejected" : "telegram_getme_failed");
    return { botIdentity: normalizeTelegramIdentity(body.result.id), username: typeof body.result.username === "string" ? body.result.username : null };
  }

  async getUpdates(offset, signal) {
    const { response, body } = await this.call("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, signal);
    if (!response.ok || body.ok !== true || !Array.isArray(body.result)) throw new Error("telegram_updates_failed");
    return body.result;
  }

  async sendText(chatIdentity, text, signal) {
    const chatId = normalizeTelegramIdentity(chatIdentity);
    if (typeof text !== "string" || text.length === 0 || Array.from(text).length > TELEGRAM_MESSAGE_LIMIT) return { category: "permanent", safeError: { code: "message_invalid" } };
    try {
      const { response, body } = await this.call("sendMessage", { chat_id: chatId, text }, signal);
      if (response.ok && body.ok === true && body.result && Number.isSafeInteger(body.result.message_id)) {
        return { category: "accepted", providerReceiptRef: String(body.result.message_id), safeReceipt: { method: "sendMessage" } };
      }
      if (response.status === 429) {
        const delay = retryAfter(body);
        return delay === null
          ? { category: "retryable", safeError: { code: "rate_limit_invalid" } }
          : { category: "rateLimited", retryAfterAt: this.now() + delay, safeError: { code: "rate_limited", providerClass: "429" } };
      }
      if ([400, 401, 403, 404].includes(response.status)) return { category: "routeBlocked", safeError: { code: "telegram_route_blocked", providerClass: String(response.status) } };
      if (response.status >= 500) return { category: "retryable", safeError: { code: "telegram_server_error", providerClass: String(response.status) } };
      return { category: "permanent", safeError: { code: "telegram_contract_invalid", providerClass: String(response.status) } };
    } catch (error) {
      if (error && error.message === "telegram_response_too_large") return { category: "permanent", safeError: { code: "telegram_response_too_large" } };
      if (error && error.message === "telegram_response_invalid") return { category: "permanent", safeError: { code: "telegram_contract_invalid" } };
      return { category: "ambiguous", safeError: { code: signal && signal.aborted ? "telegram_send_cancelled" : "telegram_send_unknown" } };
    }
  }

  alertAdapter(bindingProvider) {
    return {
      send: async (envelope, signal) => {
        const binding = await bindingProvider(envelope && envelope.targetBindingId ? envelope.targetBindingId : null);
        if (!binding) return { category: "routeBlocked", safeError: { code: "telegram_unpaired" } };
        const result = await this.sendText(binding.chatIdentity, envelope.plainText, signal);
        if (result.category === "accepted") result.safeReceipt.renderedDigest = envelope.renderedDigest;
        return result;
      }
    };
  }
}

export function telegramMessage(update) {
  if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id) || !update.message || typeof update.message !== "object") return null;
  const message = update.message;
  if (!message.from || message.from.id === undefined || !message.chat || message.chat.id === undefined) return null;
  const text = typeof message.text === "string" ? message.text.normalize("NFC").trim() : null;
  const chatType = typeof message.chat.type === "string" ? message.chat.type : null;
  const chatIdentity = chatType === "private"
    ? normalizeTelegramIdentity(message.chat.id)
    : Number.isSafeInteger(message.chat.id) ? String(message.chat.id) : null;
  if (chatIdentity === null) return null;
  return {
    updateIdentity: String(update.update_id),
    userIdentity: normalizeTelegramIdentity(message.from.id),
    chatIdentity,
    chatType,
    text,
    hasAttachment: Boolean(message.document || message.photo || message.video || message.audio || message.voice)
  };
}

export function telegramCommand(text, username = null) {
  if (typeof text !== "string") return null;
  const match = text.match(/^\/(start|status|cancel|help)(?:@([A-Za-z0-9_]+))?[ \t]*$/u);
  if (!match || (match[2] && username && match[2].toLowerCase() !== username.toLowerCase())) return null;
  return match[1];
}
