import fsp from "node:fs/promises";
import path from "node:path";
import { CONFIG_VERSION, MAX_ENV_BYTES, MAX_SECRET_BYTES } from "./constants.js";

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const ROUTES = new Set(["telegram", "session", "both"]);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(wanted)) throw new Error(code);
}

export function parseEnvText(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_ENV_BYTES) throw new Error("environment_file_invalid");
  const values = Object.create(null);
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (const rawLine of lines) {
    if (/^[ \t]*$/u.test(rawLine) || /^[ \t]*#/u.test(rawLine)) continue;
    if (/^[ \t]*export\b/u.test(rawLine)) throw new Error("environment_file_invalid");
    const match = rawLine.match(/^[ \t]*([A-Z_][A-Z0-9_]{0,127})[ \t]*=[ \t]*(.*)$/u);
    if (!match || !ENV_NAME.test(match[1]) || Object.hasOwn(values, match[1])) throw new Error("environment_file_invalid");
    let value = match[2].replace(/[ \t]+$/u, "");
    if (value.startsWith("'") || value.startsWith('"')) {
      const quote = value[0];
      if (value.length < 2 || value[value.length - 1] !== quote) throw new Error("environment_file_invalid");
      value = value.slice(1, -1);
      if (value.includes(quote)) throw new Error("environment_file_invalid");
    }
    if (/\$\(|\$\{|\$[A-Za-z_]/u.test(value) || value.includes(String.fromCharCode(96)) || value.includes("\0")) throw new Error("environment_file_invalid");
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error("environment_file_invalid");
    values[match[1]] = value;
  }
  return Object.freeze(values);
}

export async function loadPrivateEnv(environmentFile) {
  const info = await fsp.lstat(environmentFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENV_BYTES) throw new Error("environment_file_invalid");
  return parseEnvText(await fsp.readFile(environmentFile, "utf8"));
}

export function defaultConfig(routeMode = "telegram") {
  if (!ROUTES.has(routeMode)) throw new Error("route_mode_invalid");
  return {
    configVersion: CONFIG_VERSION,
    routeMode,
    telegram: { enabled: routeMode === "telegram" || routeMode === "both", tokenEnv: "TELEGRAM_BOT_TOKEN" },
    session: { enabled: routeMode === "session" || routeMode === "both" },
    harvester: {
      completionAdapter: "codex-goal-completion-v1",
      catalogRoots: [
        { anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 100 },
        { anchor: "plugin-root", relativePath: "skills", origin: "plugin", precedence: 200 }
      ]
    },
    contentPolicyVersion: 1
  };
}

export function validateConfig(value) {
  exactKeys(value, ["configVersion", "routeMode", "telegram", "session", "harvester", "contentPolicyVersion"], "config_invalid");
  if (value.configVersion !== CONFIG_VERSION || !ROUTES.has(value.routeMode) || value.contentPolicyVersion !== 1) throw new Error("config_invalid");
  exactKeys(value.telegram, ["enabled", "tokenEnv"], "config_invalid");
  exactKeys(value.session, ["enabled"], "config_invalid");
  exactKeys(value.harvester, ["completionAdapter", "catalogRoots"], "config_invalid");
  if (typeof value.telegram.enabled !== "boolean" || typeof value.session.enabled !== "boolean" || !ENV_NAME.test(value.telegram.tokenEnv)) throw new Error("config_invalid");
  const telegramExpected = value.routeMode === "telegram" || value.routeMode === "both";
  const sessionExpected = value.routeMode === "session" || value.routeMode === "both";
  if (value.telegram.enabled !== telegramExpected || value.session.enabled !== sessionExpected || value.harvester.completionAdapter !== "codex-goal-completion-v1") throw new Error("config_invalid");
  if (!Array.isArray(value.harvester.catalogRoots) || value.harvester.catalogRoots.length === 0) throw new Error("config_invalid");
  const seen = new Set();
  for (const root of value.harvester.catalogRoots) {
    exactKeys(root, ["anchor", "relativePath", "origin", "precedence"], "config_invalid");
    if (!["codex-root", "plugin-root"].includes(root.anchor) || !/^[a-z][a-z0-9-]{0,63}$/u.test(root.origin) || !Number.isInteger(root.precedence) || root.precedence < 0 || root.precedence > 10000) throw new Error("config_invalid");
    if (!/^[^\\/:]+(?:\/[^\\/:]+)*$/u.test(root.relativePath) || root.relativePath.split("/").some(function (part) { return part === "." || part === ".."; })) throw new Error("config_invalid");
    const key = root.anchor + "\0" + root.relativePath;
    if (seen.has(key)) throw new Error("config_invalid");
    seen.add(key);
  }
  return value;
}

export async function readConfig(configFile) {
  const info = await fsp.lstat(configFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("config_invalid");
  return validateConfig(JSON.parse(await fsp.readFile(configFile, "utf8")));
}

export async function writeConfig(configFile, value) {
  validateConfig(value);
  const content = JSON.stringify(value, null, 2) + "\n";
  const directory = path.dirname(configFile);
  const temporary = path.join(directory, ".config." + process.pid + "." + Date.now() + ".tmp");
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, configFile);
  if (process.platform !== "win32") await fsp.chmod(configFile, 0o600);
  return value;
}

export function taskPolicyFromEnv(env) {
  function compatibleValue(canonicalName, legacyName) {
    const canonical = env[canonicalName];
    const legacy = env[legacyName];
    if (canonical !== undefined && legacy !== undefined && canonical !== legacy) throw new Error("task_environment_conflict");
    return canonical !== undefined ? canonical : legacy;
  }
  const sandbox = compatibleValue("GOROMBO_SKILL_HARVESTER_TASK_SANDBOX", "HARVESTER_V2_TASK_SANDBOX") || "read-only";
  if (!SANDBOXES.has(sandbox)) throw new Error("task_sandbox_invalid");
  const cwd = compatibleValue("GOROMBO_SKILL_HARVESTER_TASK_CWD", "HARVESTER_V2_TASK_CWD") || null;
  if (cwd !== null && !path.isAbsolute(cwd)) throw new Error("task_cwd_invalid");
  const model = compatibleValue("GOROMBO_SKILL_HARVESTER_TASK_MODEL", "HARVESTER_V2_TASK_MODEL") || null;
  if (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model))) throw new Error("task_model_invalid");
  return { sandbox, cwd, model };
}

export function telegramAllowedUsers(env) {
  const values = (env.TELEGRAM_ALLOWED_USER_IDS || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean);
  if (values.length === 0 || values.some(function (value) { return !/^[1-9][0-9]{0,19}$/u.test(value); })) throw new Error("telegram_allowed_users_invalid");
  return new Set(values);
}

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join("[REDACTED]");
  return text.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]");
}
