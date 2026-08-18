import { createHash, randomBytes } from "node:crypto";

const PREFIXES = new Set(["onb", "evt", "asm", "rec", "out", "att", "rcp", "rpl", "par", "bnd", "ses", "tst", "tsk", "run", "op", "bak"]);

export function createId(prefix) {
  if (!PREFIXES.has(prefix)) throw new Error("invalid_id_prefix");
  return prefix + "_" + randomBytes(16).toString("hex");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(function (key) {
    return JSON.stringify(key) + ":" + stableJson(value[key]);
  }).join(",") + "}";
}

export function correlationKey(value) {
  return sha256("gorombo-skill-harvester/completion/v1\0" + stableJson(value));
}
