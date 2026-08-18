import fs from "node:fs";
import { PRODUCT_VERSION } from "./constants.js";
import { scanSafeContent } from "./content.js";
import { sendControlCommand } from "./control.js";
import { appendCompletionSpool, removeCompletionSpool } from "./completion-spool.js";
import { createCompletionEvent, acceptCompletion } from "./harvester.js";
import { sha256, stableJson } from "./ids.js";
import { resolveCodexRoot, resolveCompletionLayout } from "./paths.js";
import { acquireRuntimeLock, releaseRuntimeLock } from "./runtime-lock.js";
import { openStorage } from "./storage.js";

const MAX_HOOK_BYTES = 1024 * 1024;

function sanitizeEvidenceText(value) {
  if (typeof value !== "string") return null;
  let text = value.normalize("NFC").replace(/\r\n?/gu, "\n");
  text = text.replace(/<hook_prompt\b[\s\S]*?<\/hook_prompt>/giu, " ");
  text = text.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[private credential removed]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[private credential removed]");
  text = text.replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/giu, "[private value removed]");
  text = text.replace(/[A-Za-z]:[\\/][^\s"'<>]*/gu, "[private path removed]");
  text = text.replace(/\\\\[^\s"'<>]+/gu, "[private path removed]");
  text = text.replace(/\/(?:home|root|Users|opt|etc|var|tmp)\/[^\s"'<>]*/gu, "[private path removed]");
  text = text.replace(/\s+/gu, " ").trim();
  if (!text) return null;
  text = Array.from(text).slice(0, 2000).join("");
  return scanSafeContent(text).ok ? text : null;
}

function successfulGoalCompletion(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  if (input.hook_event_name !== "PostToolUse") return false;
  const toolName = String(input.tool_name || "").toLowerCase();
  if (!(toolName === "update_goal" || toolName.endsWith(".update_goal") || toolName.endsWith("__update_goal"))) return false;
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput) || toolInput.status !== "complete") return false;
  const response = input.tool_response;
  if (response && typeof response === "object" && (response.isError === true || response.error || response.status === "failed")) return false;
  return true;
}

function generationIdentity(input) {
  const toolUseId = typeof input.tool_use_id === "string" && Buffer.byteLength(input.tool_use_id, "utf8") <= 256
    ? input.tool_use_id
    : stableJson({ sessionId: input.session_id, turnId: input.turn_id || null, toolInput: input.tool_input || {} });
  return Number.parseInt(sha256(Buffer.from(toolUseId, "utf8")).slice(0, 12), 16);
}

function addEvidence(items, kind, value) {
  const text = sanitizeEvidenceText(value);
  if (text) items.push({ kind, text });
}

export async function completionEventFromHook(input, options = {}) {
  if (!successfulGoalCompletion(input)) return null;
  const rawTaskId = input.session_id;
  if (typeof rawTaskId !== "string" || rawTaskId.length < 1 || Buffer.byteLength(rawTaskId, "utf8") > 256) throw new Error("completion_task_id_invalid");
  const evidence = [];
  addEvidence(evidence, "user_request", input.user_prompt);
  addEvidence(evidence, "user_request", input.goal_objective);
  addEvidence(evidence, "user_request", input.tool_input && input.tool_input.objective);
  addEvidence(evidence, "user_request", input.tool_input && input.tool_input.summary);
  addEvidence(evidence, "agent_result", input.tool_response && input.tool_response.summary);
  addEvidence(evidence, "agent_result", input.tool_response && input.tool_response.message);
  const unique = [];
  const seen = new Set();
  for (const item of evidence) {
    const key = item.kind + "\0" + item.text;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  if (unique.length === 0) unique.push({ kind: "agent_result", text: "A Codex goal completed successfully and may contain reusable work." });
  return createCompletionEvent({
    taskId: rawTaskId,
    generation: generationIdentity(input),
    completedAt: Number.isSafeInteger(input.completed_at) && input.completed_at >= 0 ? input.completed_at : Date.now(),
    sourceRevision: options.sourceRevision || "@gorombo/gorombo-skill-harvester@" + PRODUCT_VERSION + ":hook-v1",
    evidence: unique.slice(0, 32)
  });
}

export async function submitCompletionEvent(event, options = {}) {
  const codexRoot = resolveCodexRoot({ env: options.env || process.env, explicitRoot: options.codexRoot });
  const layout = resolveCompletionLayout(codexRoot);
  if (!fs.existsSync(layout.databaseFile)) throw new Error("onboarding_required");
  const spool = await (options.appendCompletionSpool || appendCompletionSpool)(layout, event);
  try {
    return await (options.sendControl || sendControlCommand)(layout, "completion.submit", { event }, { timeoutMs: options.timeoutMs || 5000 });
  } catch {}

  let ownership;
  try { ownership = await (options.acquireRuntimeLock || acquireRuntimeLock)(layout); }
  catch { return { status: spool.status }; }
  let storage;
  let result;
  let released = false;
  try {
    storage = openStorage(layout.databaseFile, { create: false });
    result = acceptCompletion(storage, event);
  } finally {
    if (storage) storage.close();
    released = await (options.releaseRuntimeLock || releaseRuntimeLock)(layout, ownership);
  }
  if (!released) throw new Error("runtime_lock_lost");
  await (options.removeCompletionSpool || removeCompletionSpool)(layout, event);
  return result;
}

export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_HOOK_BYTES) throw new Error("hook_input_too_large");
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("hook_input_invalid"); }
  return value;
}

export async function runCompletionHook(options = {}) {
  const input = options.input || await readHookInput(options.stream);
  const event = await completionEventFromHook(input, options);
  if (!event) return { status: "ignored" };
  const result = await submitCompletionEvent(event, options);
  return { status: "queued", result };
}
