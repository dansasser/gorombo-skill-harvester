import { activeBinding, beginPairingInTransaction } from "./pairing.js";
import { acceptTelegramTaskInTransaction, cancelTaskInTransaction } from "./tasks.js";
import { telegramCommand, telegramMessage } from "./telegram.js";
import { queueTelegramReplyInTransaction } from "./telegram-replies.js";

function updateIdentity(update) {
  if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER) throw new Error("telegram_update_invalid");
  return String(update.update_id);
}

function recordUpdate(storage, identity, bindingId, taskId, state, now) {
  storage.db.prepare("INSERT INTO telegram_updates(update_identity,binding_id,task_id,state,received_at) VALUES(?,?,?,?,?)")
    .run(identity, bindingId || null, taskId || null, state, now);
}

function advanceCursor(storage, nextOffset, now) {
  const current = storage.getSetting("telegram.update_cursor");
  const prior = current === null ? 0 : current;
  if (!Number.isSafeInteger(prior) || prior < 0) throw new Error("telegram_cursor_invalid");
  const value = Math.max(prior, nextOffset);
  storage.setSetting("telegram.update_cursor", value, now);
  return value;
}

function routeReady(storage) {
  const route = storage.getRoute("telegram");
  return Boolean(route && route.selected && route.state === "READY");
}

function statusMessage(storage, ready, bindingId) {
  const queued = Number(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='QUEUED'").get().count);
  const running = Number(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RUNNING'").get().count);
  const recovery = Number(storage.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state='RECOVERY_REQUIRED'").get().count);
  const alerts = Number(storage.db.prepare("SELECT COUNT(*) AS count FROM delivery_outbox WHERE delivery_kind='recommendation' AND route='telegram' AND state IN ('QUEUED','RETRY_WAIT','SENDING')").get().count);
  const current = storage.db.prepare("SELECT id,state FROM tasks WHERE binding_id=? AND state IN ('QUEUED','RUNNING','WAITING_APPROVAL','RECOVERY_REQUIRED') ORDER BY accepted_at,id LIMIT 1").get(bindingId);
  return [
    "Gorombo Skill Harvester is paired.",
    "Telegram route: " + (ready ? "ready" : "not ready"),
    "Tasks: " + queued + " queued, " + running + " running, " + recovery + " need recovery",
    "Your current task: " + (current ? current.id + " (" + current.state.toLowerCase() + ")" : "none"),
    "Recommendation alerts waiting: " + alerts
  ].join("\n");
}

function queueReply(storage, identity, purpose, bindingId, chatIdentity, message, now) {
  return queueTelegramReplyInTransaction(storage, {
    sourceIdentity: "update:" + identity,
    purpose,
    bindingId,
    chatIdentity,
    message
  }, now);
}

function pairedHelp() {
  return [
    "Send a normal text message to run it as a Codex task.",
    "",
    "Commands:",
    "/status - show safe runtime status",
    "/cancel - cancel your queued task or request cancellation of the running task",
    "/help - show this help"
  ].join("\n");
}

function notPairedMessage() {
  return "Gorombo Skill Harvester is not paired for this chat. Send /start to create a pairing code, then approve it locally.";
}

function taskTextValid(text) {
  return typeof text === "string" && text.trim().length > 0 && Buffer.byteLength(text.normalize("NFC").trim(), "utf8") <= 16_000;
}

export function readTelegramCursor(storage) {
  const value = storage.getSetting("telegram.update_cursor");
  if (value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("telegram_cursor_invalid");
  return value;
}

export function processTelegramUpdate(storage, update, context, now = Date.now()) {
  if (!context || !(context.allowedUsers instanceof Set) || typeof context.botIdentity !== "string" || typeof context.token !== "string") throw new Error("telegram_context_invalid");
  const identity = updateIdentity(update);
  const nextOffset = Number(identity) + 1;
  return storage.transaction(function () {
    const prior = storage.db.prepare("SELECT state,task_id FROM telegram_updates WHERE update_identity=?").get(identity);
    if (prior) {
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "duplicate", cursor, wakeReplies: false, wakeTasks: false, abortTaskId: null };
    }

    let message = null;
    try { message = telegramMessage(update); } catch {}
    if (!message) {
      recordUpdate(storage, identity, null, null, "REJECTED", now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "rejected", reason: "unsupported_update", cursor, wakeReplies: false, wakeTasks: false, abortTaskId: null };
    }

    if (!context.allowedUsers.has(message.userIdentity)) {
      recordUpdate(storage, identity, null, null, "REJECTED", now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "rejected", reason: "user_not_allowed", cursor, wakeReplies: false, wakeTasks: false, abortTaskId: null };
    }

    if (message.chatType !== "private") {
      recordUpdate(storage, identity, null, null, "REJECTED", now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "rejected", reason: "private_chat_required", cursor, wakeReplies: false, wakeTasks: false, abortTaskId: null };
    }

    const binding = activeBinding(storage, context.botIdentity, message.userIdentity, message.chatIdentity);
    const command = telegramCommand(message.text, context.username || null);
    const ready = routeReady(storage);

    if (command === "start") {
      let reply;
      let bindingId = binding && binding.id;
      if (binding) {
        reply = ready
          ? "Gorombo Skill Harvester is already paired and ready. Send /help for commands."
          : "Gorombo Skill Harvester is paired, but the Telegram route still needs a successful local route test.";
      } else {
        const pairing = beginPairingInTransaction(storage, {
          botIdentity: context.botIdentity,
          userIdentity: message.userIdentity,
          chatIdentity: message.chatIdentity,
          chatType: message.chatType,
          token: context.token,
          randomBytes: context.randomBytes
        }, now);
        reply = [
          "Gorombo Skill Harvester pairing code: " + pairing.code,
          "",
          "Approve locally with:",
          "gorombo-skill-harvester pair " + pairing.code,
          "",
          "This code expires in 60 minutes."
        ].join("\n");
      }
      recordUpdate(storage, identity, bindingId, null, "HANDLED", now);
      queueReply(storage, identity, "PAIRING", bindingId, message.chatIdentity, reply, now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: binding ? "already_paired" : "pairing_requested", cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    if (!binding) {
      recordUpdate(storage, identity, null, null, "REJECTED", now);
      queueReply(storage, identity, "REJECTION", null, message.chatIdentity, notPairedMessage(), now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "rejected", reason: "not_paired", cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    if (command === "status") {
      recordUpdate(storage, identity, binding.id, null, "HANDLED", now);
      queueReply(storage, identity, "STATUS", binding.id, message.chatIdentity, statusMessage(storage, ready, binding.id), now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "handled", command, cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    if (command === "help") {
      recordUpdate(storage, identity, binding.id, null, "HANDLED", now);
      queueReply(storage, identity, "HELP", binding.id, message.chatIdentity, pairedHelp(), now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "handled", command, cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    if (command === "cancel") {
      const cancelled = cancelTaskInTransaction(storage, binding.id, now);
      const needsReply = !cancelled || cancelled.state === "abort_required";
      if (needsReply) {
        const text = !cancelled
          ? "There is no queued or running task to cancel."
          : "Cancellation was requested for your running task.\n\nTask ID: " + cancelled.taskId;
        queueReply(storage, identity, "CANCEL", binding.id, message.chatIdentity, text, now);
      }
      recordUpdate(storage, identity, binding.id, cancelled && cancelled.taskId, "HANDLED", now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return {
        status: "handled",
        command,
        cursor,
        wakeReplies: needsReply,
        wakeTasks: false,
        wakeTaskResults: Boolean(cancelled && cancelled.state === "cancelled"),
        abortTaskId: cancelled && cancelled.state === "abort_required" ? cancelled.taskId : null
      };
    }

    if (typeof message.text === "string" && message.text.startsWith("/")) {
      recordUpdate(storage, identity, binding.id, null, "HANDLED", now);
      queueReply(storage, identity, "HELP", binding.id, message.chatIdentity, "Unknown command.\n\n" + pairedHelp(), now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "handled", command: "unknown", cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    if (!ready) {
      recordUpdate(storage, identity, binding.id, null, "REJECTED", now);
      queueReply(storage, identity, "REJECTION", binding.id, message.chatIdentity, "The Telegram route is paired but not ready. Run the local route test before sending tasks.", now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "rejected", reason: "route_not_ready", cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    if (message.hasAttachment || !taskTextValid(message.text)) {
      recordUpdate(storage, identity, binding.id, null, "REJECTED", now);
      queueReply(storage, identity, "REJECTION", binding.id, message.chatIdentity, "Send one text-only task of 16,000 bytes or less.", now);
      const cursor = advanceCursor(storage, nextOffset, now);
      return { status: "rejected", reason: "task_invalid", cursor, wakeReplies: true, wakeTasks: false, abortTaskId: null };
    }

    const accepted = acceptTelegramTaskInTransaction(storage, {
      updateIdentity: identity,
      bindingId: binding.id,
      text: message.text
    }, now);
    const cursor = advanceCursor(storage, nextOffset, now);
    return {
      status: accepted.status,
      taskId: accepted.taskId,
      cursor,
      wakeReplies: false,
      wakeTasks: accepted.status === "queued",
      abortTaskId: null
    };
  });
}
