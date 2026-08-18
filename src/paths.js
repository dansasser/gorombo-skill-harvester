import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from "./constants.js";

const DIRECTORY_NAMES = ["goromboRoot", "productRoot", "completionSpoolDir", "recommendationsDir", "runtimeDir", "logsDir", "backupsDir", "recoveryDir"];

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inspectExistingDirectory(candidate) {
  const info = fs.lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("codex_root_invalid");
  const real = fs.realpathSync.native(candidate);
  if (!samePath(real, candidate)) throw new Error("codex_root_redirected");
}

export function resolveCodexRoot(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const selected = options.explicitRoot || env.CODEX_HOME || path.join(home, ".codex");
  if (typeof selected !== "string" || selected.length === 0 || !path.isAbsolute(selected)) throw new Error("codex_root_unresolved");
  const normalized = path.resolve(selected);
  if (fs.existsSync(normalized)) inspectExistingDirectory(normalized);
  else {
    const parent = path.dirname(normalized);
    if (!fs.existsSync(parent)) throw new Error("codex_root_parent_unavailable");
    inspectExistingDirectory(parent);
  }
  return normalized;
}

function buildProductLayout(codexRoot, productName) {
  if (!path.isAbsolute(codexRoot)) throw new Error("codex_root_unresolved");
  const goromboRoot = path.join(codexRoot, ".gorombo");
  const productRoot = path.join(goromboRoot, productName);
  return Object.freeze({
    codexRoot,
    goromboRoot,
    environmentFile: path.join(goromboRoot, ".env"),
    productRoot,
    configFile: path.join(productRoot, "config.json"),
    databaseFile: path.join(productRoot, "state.sqlite3"),
    completionSpoolDir: path.join(productRoot, "completion-spool"),
    recommendationsDir: path.join(productRoot, "recommendations"),
    runtimeDir: path.join(productRoot, "run"),
    runtimeLock: path.join(productRoot, "run", "runtime.lock"),
    wakeEndpoint: path.join(productRoot, "run", "wake"),
    heartbeatFile: path.join(productRoot, "run", "heartbeat.json"),
    logsDir: path.join(productRoot, "logs"),
    backupsDir: path.join(productRoot, "backups"),
    recoveryDir: path.join(productRoot, "recovery")
  });
}

export function buildLayout(codexRoot) {
  return buildProductLayout(codexRoot, PRODUCT_NAME);
}

export function buildLegacyLayout(codexRoot) {
  return buildProductLayout(codexRoot, LEGACY_PRODUCT_NAME);
}

export function resolveCompletionLayout(codexRoot) {
  const canonical = buildLayout(codexRoot);
  if (fs.existsSync(canonical.databaseFile)) return canonical;
  const legacy = buildLegacyLayout(codexRoot);
  if (!fs.existsSync(canonical.productRoot) && fs.existsSync(legacy.databaseFile)) return legacy;
  return canonical;
}

export function assertContained(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return path.resolve(candidate);
  throw new Error("path_outside_owned_root");
}

async function ensurePrivateDirectory(parent, candidate) {
  assertContained(parent, candidate);
  if (fs.existsSync(candidate)) {
    const info = await fsp.lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("owned_path_unsafe");
  } else await fsp.mkdir(candidate, { mode: 0o700 });
  if (process.platform !== "win32") await fsp.chmod(candidate, 0o700);
  const realParent = await fsp.realpath(parent);
  const realCandidate = await fsp.realpath(candidate);
  assertContained(realParent, realCandidate);
}

export async function ensureOwnedDirectory(ownedRoot, candidate) {
  const root = path.resolve(ownedRoot);
  const target = assertContained(root, candidate);
  const rootInfo = await fsp.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("owned_path_unsafe");
  const rootReal = await fsp.realpath(root);
  if (!samePath(rootReal, root)) throw new Error("owned_path_unsafe");
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await fsp.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("owned_path_unsafe");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      try { await fsp.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (!mkdirError || mkdirError.code !== "EEXIST") throw mkdirError; }
      const info = await fsp.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("owned_path_unsafe");
    }
    const real = await fsp.realpath(current);
    assertContained(rootReal, real);
    if (!samePath(real, current)) throw new Error("owned_path_unsafe");
    if (process.platform !== "win32") await fsp.chmod(current, 0o700);
  }
  return target;
}

export async function ensureOwnedLayout(layout) {
  if (!fs.existsSync(layout.codexRoot)) await fsp.mkdir(layout.codexRoot, { mode: 0o700 });
  inspectExistingDirectory(layout.codexRoot);
  let parent = layout.codexRoot;
  for (const name of DIRECTORY_NAMES) {
    const candidate = layout[name];
    if (name === "productRoot") parent = layout.goromboRoot;
    else if (name !== "goromboRoot") parent = layout.productRoot;
    await ensurePrivateDirectory(parent, candidate);
    if (name === "goromboRoot") parent = layout.goromboRoot;
  }
  return layout;
}

export function validateStoredRelative(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) throw new Error("relative_path_invalid");
  if (value.includes("\\") || value.includes("\0") || /[\x00-\x1f\x7f]/u.test(value)) throw new Error("relative_path_invalid");
  const parts = value.split("/");
  if (parts.length > 16 || parts.some(function (part) { return part === "" || part === "." || part === ".."; })) throw new Error("relative_path_invalid");
  if (path.isAbsolute(value) || /^[A-Za-z]:/u.test(value) || value.startsWith("//")) throw new Error("relative_path_invalid");
  return value;
}

export function resolveStoredRelative(parent, value) {
  validateStoredRelative(value);
  return assertContained(parent, path.join(parent, ...value.split("/")));
}

export function toStoredRelative(parent, absolutePath) {
  const contained = assertContained(parent, absolutePath);
  return validateStoredRelative(path.relative(parent, contained).split(path.sep).join("/"));
}
