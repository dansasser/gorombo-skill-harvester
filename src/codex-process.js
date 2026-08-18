import { spawn } from "node:child_process";
import fs from "node:fs";
import { buildCodexInvocation, resolveVerifiedCodexLaunchPlan, terminateOwnedChild } from "./codex-launcher.js";
import path from "node:path";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const BASE_ENV_KEYS = new Set([
  "ALL_PROXY", "APPDATA", "CODEX_API_KEY", "CODEX_HOME", "COLORTERM", "COMSPEC",
  "HOME", "HOMEDRIVE", "HOMEPATH", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LANGUAGE",
  "LC_ALL", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS", "NO_COLOR", "NO_PROXY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_ORG_ID",
  "OPENAI_PROJECT", "OPENAI_PROJECT_ID", "PATH", "PATHEXT", "SSL_CERT_DIR",
  "SSL_CERT_FILE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR",
  "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"
]);

export function buildCodexProcessEnv(base = process.env, overrides = {}, allowedEnvKeys = []) {
  if (!base || typeof base !== "object" || !overrides || typeof overrides !== "object" || !Array.isArray(allowedEnvKeys) || allowedEnvKeys.length > 32) throw new Error("codex_environment_invalid");
  const allowed = new Set(BASE_ENV_KEYS);
  for (const key of allowedEnvKeys) {
    const normalized = String(key || "").toUpperCase();
    if (!ENV_NAME.test(normalized)) throw new Error("codex_environment_invalid");
    allowed.add(normalized);
  }
  const merged = { ...base, ...overrides };
  const result = {};
  for (const [key, value] of Object.entries(merged)) {
    if (allowed.has(key.toUpperCase()) && typeof value === "string") result[key] = value;
  }
  return result;
}
export function buildCodexExecArgs(options) {
  if (!["read-only", "workspace-write", "danger-full-access"].includes(options.sandbox)) throw new Error("task_sandbox_invalid");
  if (typeof options.cwd !== "string" || !path.isAbsolute(options.cwd)) throw new Error("task_cwd_invalid");
  const model = options.model || null;
  if (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model))) throw new Error("task_model_invalid");
  const common = ["exec", "--json", "--color", "never", "--sandbox", options.sandbox, "--cd", options.cwd, "--skip-git-repo-check", "-c", 'approval_policy="never"'];
  if (model) common.push("--model", model);
  if (options.threadId) return [...common, "resume", options.threadId, "-"];
  return [...common, "-"];
}

export function parseCodexEventLine(line, state) {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new Error("codex_event_too_large");
  let event;
  try { event = JSON.parse(line); } catch { throw new Error("codex_event_invalid"); }
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("codex_event_invalid");
  if (event.type === "thread.started" && typeof event.thread_id === "string") state.threadId = event.thread_id;
  if (event.type === "item.completed" && event.item && event.item.type === "agent_message" && typeof event.item.text === "string") state.lastMessage = event.item.text;
  if (event.type === "item.completed" && event.item && event.item.type === "error" && typeof event.item.message === "string") state.errorText = event.item.message.slice(0, 2000);
  if (event.type === "turn.completed") state.turnCompleted = true;
  return state;
}

function classifyFailure(state, timedOut, cancelled) {
  if (cancelled) return { ok: false, category: "cancelled", safeMessage: "The task was cancelled." };
  if (timedOut) return { ok: false, category: "timeout", safeMessage: "The Codex task exceeded its time limit." };
  const message = String(state.errorText || "").toLowerCase();
  if (message.includes("not authenticated") || message.includes("login")) return { ok: false, category: "authentication", safeMessage: "Codex is not authenticated on the host." };
  if (message.includes("model") && (message.includes("available") || message.includes("not found"))) return { ok: false, category: "model", safeMessage: "The configured Codex model is not available." };
  if (message.includes("approval")) return { ok: false, category: "approval_required", safeMessage: "The task requires host approval." };
  return { ok: false, category: "execution", safeMessage: "The Codex task did not complete successfully." };
}

export async function runCodexTask(options) {
  if (typeof options.prompt !== "string" || options.prompt.trim().length === 0 || Buffer.byteLength(options.prompt, "utf8") > 16_000) throw new Error("task_text_invalid");
  if (!fs.existsSync(options.cwd) || !fs.lstatSync(options.cwd).isDirectory()) throw new Error("task_cwd_invalid");
  const terminationGraceMs = options.terminationGraceMs === undefined ? 5000 : options.terminationGraceMs;
  const terminationConfirmMs = options.terminationConfirmMs === undefined ? 5000 : options.terminationConfirmMs;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1 || terminationGraceMs > 60_000 ||
      !Number.isSafeInteger(terminationConfirmMs) || terminationConfirmMs < 1 || terminationConfirmMs > 60_000) {
    throw new Error("task_termination_options_invalid");
  }
  const terminateProcessTree = options.terminateProcessTree || terminateOwnedChild;
  if (typeof terminateProcessTree !== "function") throw new Error("task_termination_options_invalid");
  const args = buildCodexExecArgs(options);
  const processEnv = buildCodexProcessEnv(process.env, options.env || {}, options.allowedEnvKeys || []);
  let launchPlan = options.launchPlan;
  if (!launchPlan) {
    try {
      launchPlan = (await resolveVerifiedCodexLaunchPlan({
        executable: options.executable,
        env: { ...process.env, ...(options.env || {}) },
        spawn: options.launcherSpawn
      })).plan;
    } catch {
      return { ok: false, category: "launch", safeMessage: "Codex could not be started." };
    }
  }
  const invocation = buildCodexInvocation(launchPlan, args);
  const spawnImpl = options.spawn || spawn;
  const state = { threadId: options.threadId || null, lastMessage: null, errorText: null, turnCompleted: false };
  return await new Promise(function (resolve) {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let total = 0;
    let buffer = "";
    let child;
    let timer = null;
    let terminationTimer = null;
    let confirmationTimer = null;
    let terminationStarted = false;
    let childClosed = false;
    let closedCode = null;
    let treeConfirmed = false;
    const finish = function (value) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (terminationTimer !== null) clearTimeout(terminationTimer);
      if (confirmationTimer !== null) clearTimeout(confirmationTimer);
      if (options.signal) options.signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const unconfirmed = function () {
      finish({
        ok: false,
        category: "termination_unconfirmed",
        safeMessage: "Codex task termination could not be confirmed."
      });
    };
    const finishTerminated = function () {
      if (!treeConfirmed || !childClosed) return false;
      finish(classifyFailure(state, timedOut, cancelled));
      return true;
    };
    const beginTermination = function (reason) {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      else if (reason === "cancelled") cancelled = true;
      Promise.resolve().then(function () {
        return terminateProcessTree(child, false);
      }).then(function (confirmed) {
        if (confirmed === true) {
          treeConfirmed = true;
          finishTerminated();
        }
      }).catch(function () {});
      terminationTimer = setTimeout(function () {
        Promise.resolve().then(function () {
          return terminateProcessTree(child, true);
        }).then(function (confirmed) {
          treeConfirmed = confirmed === true;
          if (finishTerminated()) return;
          confirmationTimer = setTimeout(unconfirmed, terminationConfirmMs);
        }).catch(function () {
          confirmationTimer = setTimeout(unconfirmed, terminationConfirmMs);
        });
      }, terminationGraceMs);
    };
    const abort = function () { beginTermination("cancelled"); };
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: processEnv,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      return finish({ ok: false, category: "launch", safeMessage: "Codex could not be started." });
    }
    timer = setTimeout(function () {
      beginTermination("timeout");
    }, options.timeoutMs || 30 * 60 * 1000);
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    child.on("error", function () { finish({ ok: false, category: "launch", safeMessage: "Codex could not be started." }); });
    child.stdout.on("data", function (chunk) {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        state.errorText = "event output too large";
        beginTermination("failure");
        return;
      }
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/u, "");
        buffer = buffer.slice(index + 1);
        if (line) {
          try { parseCodexEventLine(line, state); }
          catch { state.errorText = "invalid event output"; beginTermination("failure"); }
        }
      }
    });
    let stderrBytes = 0;
    child.stderr.on("data", function (chunk) {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        state.errorText = "event output too large";
        beginTermination("failure");
      }
    });
    child.on("close", function (code) {
      childClosed = true;
      closedCode = code;
      if (buffer.trim()) {
        try { parseCodexEventLine(buffer.trim(), state); } catch { state.errorText = "invalid event output"; }
      }
      if (terminationStarted) {
        finishTerminated();
        return;
      }
      if (closedCode === 0 && state.turnCompleted && typeof state.lastMessage === "string" && state.lastMessage.trim()) {
        const text = state.lastMessage.normalize("NFC").trim();
        if (Buffer.byteLength(text, "utf8") <= 64 * 1024) return finish({ ok: true, threadId: state.threadId, resultText: text });
      }
      finish(classifyFailure(state, timedOut, cancelled));
    });
    child.stdin.on("error", function () {});
    child.stdin.end(options.prompt, "utf8");
  });
}
