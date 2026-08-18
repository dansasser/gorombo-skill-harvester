import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { LEGACY_PRODUCT_NAME } from "./constants.js";
import { buildLayout, buildLegacyLayout, resolveCodexRoot } from "./paths.js";
import { openStorage } from "./storage.js";

function exists(candidate) {
  try { return fs.lstatSync(candidate); }
  catch (error) { if (error && error.code === "ENOENT") return null; throw error; }
}

function safeDirectory(candidate, code) {
  const info = exists(candidate);
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(code);
  return info;
}

async function recommendationDigests(root) {
  const result = [];
  const info = exists(root);
  if (!info) return result;
  safeDirectory(root, "legacy_state_unsafe");
  for (const name of (await fsp.readdir(root)).sort()) {
    const file = path.join(root, name);
    const fileInfo = await fsp.lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error("legacy_state_unsafe");
    result.push([name, createHash("sha256").update(await fsp.readFile(file)).digest("hex")]);
  }
  return result;
}

function validateDatabase(layout) {
  if (!exists(layout.databaseFile)) return;
  const storage = openStorage(layout.databaseFile, { create: false });
  try { if (!storage.integrityCheck().ok) throw new Error("storage_integrity_failed"); }
  finally { storage.close(); }
}

function legacyServiceDescriptor(legacy, options) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  if (platform === "linux") return path.join(home, ".config", "systemd", "user", LEGACY_PRODUCT_NAME + ".service");
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", "com.gorombo." + LEGACY_PRODUCT_NAME + ".plist");
  if (platform === "win32") return path.join(legacy.runtimeDir, "service-task.xml");
  return null;
}

export function inspectIdentityMigration(options = {}) {
  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: options.env, home: options.home });
  const canonical = buildLayout(codexRoot);
  const legacy = buildLegacyLayout(codexRoot);
  const canonicalExists = Boolean(exists(canonical.productRoot));
  const legacyExists = Boolean(exists(legacy.productRoot));
  if (canonicalExists && legacyExists) return { status: "collision" };
  if (canonicalExists) return { status: "already_migrated" };
  if (legacyExists) return { status: "migration_required" };
  return { status: "legacy_state_absent" };
}

export async function migrateLegacyState(options = {}) {
  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: options.env, home: options.home });
  const canonical = buildLayout(codexRoot);
  const legacy = buildLegacyLayout(codexRoot);
  const canonicalInfo = exists(canonical.productRoot);
  const legacyInfo = exists(legacy.productRoot);
  if (canonicalInfo && legacyInfo) throw new Error("state_identity_collision");
  if (canonicalInfo) return { status: "already_migrated" };
  if (!legacyInfo) throw new Error("legacy_state_missing");
  safeDirectory(legacy.productRoot, "legacy_state_unsafe");
  const serviceDescriptor = legacyServiceDescriptor(legacy, options);
  if (serviceDescriptor && exists(serviceDescriptor)) throw new Error("legacy_service_still_installed");
  if (exists(legacy.runtimeLock)) throw new Error("legacy_runtime_active_or_uncertain");
  validateDatabase(legacy);
  const before = await recommendationDigests(legacy.recommendationsDir);
  await fsp.rename(legacy.productRoot, canonical.productRoot);
  safeDirectory(canonical.productRoot, "migrated_state_unsafe");
  validateDatabase(canonical);
  const after = await recommendationDigests(canonical.recommendationsDir);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("migrated_state_digest_mismatch");
  return { status: "migrated", stateRootRelative: ".gorombo/gorombo-skill-harvester" };
}
