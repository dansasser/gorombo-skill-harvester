import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createId } from "./ids.js";
import { normalizeTelegramIdentity } from "./telegram-identity.js";
import { queueTelegramReplyInTransaction } from "./telegram-replies.js";

const CODE = /^[0-9A-F]{6}$/u;
const PAIRING_TTL_MS = 60 * 60 * 1000;
const identity = normalizeTelegramIdentity;

export function pairingCodeDigest(token, botIdentity, code) {
  if (typeof token !== "string" || token.length === 0 || !CODE.test(code)) throw new Error("pairing_input_invalid");
  return createHmac("sha256", token).update("gorombo-skill-harvester/pairing/v1\0" + identity(botIdentity) + "\0" + code, "utf8").digest("hex");
}

export function legacyPairingCodeDigest(token, botIdentity, code) {
  if (typeof token !== "string" || token.length === 0 || !CODE.test(code)) throw new Error("pairing_input_invalid");
  return createHmac("sha256", token).update("harvester-v2/pairing/v1\0" + identity(botIdentity) + "\0" + code, "utf8").digest("hex");
}

export function beginPairingInTransaction(storage, options, now = Date.now()) {
  if (options.chatType !== "private" || typeof options.token !== "string" || options.token.length === 0) throw new Error("pairing_input_invalid");
  const botIdentity = identity(options.botIdentity);
  const userIdentity = identity(options.userIdentity);
  const chatIdentity = identity(options.chatIdentity);
  storage.db.prepare("UPDATE pairing_requests SET state='EXPIRED',resolved_at=? WHERE state='PENDING' AND expires_at<=?").run(now, now);
  storage.db.prepare("UPDATE pairing_requests SET state='REJECTED',resolved_at=? WHERE bot_identity=? AND user_identity=? AND state='PENDING'").run(now, botIdentity, userIdentity);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = (options.randomBytes || randomBytes)(3).toString("hex").toUpperCase();
    const digest = pairingCodeDigest(options.token, botIdentity, code);
    try {
      const id = createId("par");
      storage.db.prepare("INSERT INTO pairing_requests(id,code_digest,bot_identity,user_identity,chat_identity,chat_type,state,created_at,expires_at) VALUES(?,?,?,?,?,'private','PENDING',?,?)")
        .run(id, digest, botIdentity, userIdentity, chatIdentity, now, now + PAIRING_TTL_MS);
      return { requestId: id, code, expiresAt: now + PAIRING_TTL_MS };
    } catch (error) {
      if (!String(error && error.message).includes("UNIQUE")) throw error;
    }
  }
  throw new Error("pairing_code_exhausted");
}

export function beginPairing(storage, options, now = Date.now()) {
  return storage.transaction(function () { return beginPairingInTransaction(storage, options, now); });
}

export function approvePairing(storage, options, now = Date.now()) {
  const code = String(options.code || "").trim().toUpperCase();
  if (!CODE.test(code)) throw new Error("pairing_code_invalid");
  const botIdentity = identity(options.botIdentity);
  const digests = [pairingCodeDigest(options.token, botIdentity, code), legacyPairingCodeDigest(options.token, botIdentity, code)];
  return storage.transaction(function () {
    storage.db.prepare("UPDATE pairing_requests SET state='EXPIRED',resolved_at=? WHERE state='PENDING' AND expires_at<=?").run(now, now);
    const row = storage.db.prepare("SELECT * FROM pairing_requests WHERE code_digest IN (?,?) AND bot_identity=?").get(digests[0], digests[1], botIdentity);
    if (!row || row.state !== "PENDING" || row.chat_type !== "private" || Number(row.expires_at) <= now) throw new Error("pairing_code_invalid");
    const matched = digests.find(function (digest) { return timingSafeEqual(Buffer.from(row.code_digest, "hex"), Buffer.from(digest, "hex")); });
    const compared = Boolean(matched);
    if (!compared) throw new Error("pairing_code_invalid");
    const previousPrimary = storage.db.prepare("SELECT id FROM telegram_bindings WHERE bot_identity=? AND chat_type='private' AND state='ACTIVE' AND is_primary=1").get(row.bot_identity);
    const existing = storage.db.prepare("SELECT id FROM telegram_bindings WHERE bot_identity=? AND user_identity=? AND chat_identity=? AND chat_type='private'").get(row.bot_identity, row.user_identity, row.chat_identity);
    const bindingId = existing ? existing.id : createId("bnd");
    storage.db.prepare("UPDATE telegram_bindings SET is_primary=0 WHERE bot_identity=? AND is_primary=1").run(row.bot_identity);
    if (existing) storage.db.prepare("UPDATE telegram_bindings SET chat_type='private',state='ACTIVE',is_primary=1,approved_at=?,revoked_at=NULL WHERE id=?").run(now, bindingId);
    else storage.db.prepare("INSERT INTO telegram_bindings(id,bot_identity,user_identity,chat_identity,chat_type,is_primary,state,approved_at) VALUES(?,?,?,?,'private',1,'ACTIVE',?)")
      .run(bindingId, row.bot_identity, row.user_identity, row.chat_identity, now);
    storage.db.prepare("UPDATE pairing_requests SET state='USED',resolved_at=? WHERE id=? AND state='PENDING'").run(now, row.id);
    const selectedRoute = storage.getRoute("telegram");
    if (selectedRoute && selectedRoute.selected && (!previousPrimary || previousPrimary.id !== bindingId)) storage.configureRoute("telegram", true, "CONFIGURED", selectedRoute.safeConfig, now);
    const route = storage.getRoute("telegram");
    const message = route && route.selected && route.state === "READY"
      ? "Gorombo Skill Harvester is paired and ready. Send /help for commands."
      : "Gorombo Skill Harvester pairing approved.\n\nRun the local Telegram route test to finish setup.";
    const confirmation = queueTelegramReplyInTransaction(storage, { sourceIdentity: "pairing:" + row.id, purpose: "CONFIRMATION", bindingId, chatIdentity: row.chat_identity, message }, now);
    return { bindingId, botIdentity: row.bot_identity, userIdentity: row.user_identity, chatIdentity: row.chat_identity, confirmationDeliveryId: confirmation.deliveryId, wakeReplies: true };
  });
}

function bindingView(row) {
  if (!row) return null;
  return { id: row.id, botIdentity: row.bot_identity, userIdentity: row.user_identity, chatIdentity: row.chat_identity, approvedAt: Number(row.approved_at) };
}

function allowedBinding(row, allowedUsers) {
  return Boolean(row && row.chat_type === "private" && (allowedUsers === null || allowedUsers.has(row.user_identity)));
}

export function activeBinding(storage, botIdentity, userIdentity, chatIdentity = null) {
  const bot = identity(botIdentity);
  const user = identity(userIdentity);
  const row = chatIdentity === null
    ? storage.db.prepare("SELECT * FROM telegram_bindings WHERE bot_identity=? AND user_identity=? AND chat_type='private' AND state='ACTIVE' ORDER BY approved_at DESC LIMIT 1").get(bot, user)
    : storage.db.prepare("SELECT * FROM telegram_bindings WHERE bot_identity=? AND user_identity=? AND chat_identity=? AND chat_type='private' AND state='ACTIVE'").get(bot, user, identity(chatIdentity));
  return bindingView(row);
}

export function primaryTelegramBinding(storage, botIdentity, allowedUsers = null) {
  if (allowedUsers !== null && !(allowedUsers instanceof Set)) throw new Error("telegram_allowed_users_invalid");
  const row = storage.db.prepare("SELECT * FROM telegram_bindings WHERE bot_identity=? AND chat_type='private' AND state='ACTIVE' AND is_primary=1").get(identity(botIdentity));
  return allowedBinding(row, allowedUsers) ? bindingView(row) : null;
}

export function primaryTelegramBindingById(storage, bindingId, botIdentity, allowedUsers = null) {
  if (typeof bindingId !== "string" || !/^bnd_[0-9a-f]{32}$/u.test(bindingId)) return null;
  if (allowedUsers !== null && !(allowedUsers instanceof Set)) throw new Error("telegram_allowed_users_invalid");
  const row = storage.db.prepare("SELECT * FROM telegram_bindings WHERE id=? AND bot_identity=? AND chat_type='private' AND state='ACTIVE' AND is_primary=1").get(bindingId, identity(botIdentity));
  return allowedBinding(row, allowedUsers) ? bindingView(row) : null;
}

export function revokeBinding(storage, bindingId, now = Date.now()) {
  return storage.transaction(function () {
    const row = storage.db.prepare("SELECT is_primary FROM telegram_bindings WHERE id=? AND state='ACTIVE'").get(bindingId);
    if (!row) return false;
    const changed = storage.db.prepare("UPDATE telegram_bindings SET state='REVOKED',is_primary=0,revoked_at=? WHERE id=? AND state='ACTIVE'").run(now, bindingId);
    if (Number(changed.changes) !== 1) return false;
    if (Boolean(row.is_primary)) {
      const route = storage.getRoute("telegram");
      if (route && route.selected) storage.configureRoute("telegram", true, "CONFIGURED", route.safeConfig, now);
    }
    return true;
  });
}

export { normalizeTelegramIdentity };
