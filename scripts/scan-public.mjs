#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function resolveNpmCli() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(function (candidate) { return typeof candidate === "string" && path.isAbsolute(candidate); });
  for (const candidate of candidates) {
    try {
      const info = await fsp.lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {}
  }
  throw new Error("npm_cli_unavailable");
}

function run(executable, args, label, encoding = "utf8") {
  const result = spawnSync(executable, args, {
    cwd: packageRoot,
    encoding,
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.error, undefined, label + "_launch_failed");
  assert.equal(result.status, 0, label + "_failed");
  return result.stdout;
}

function normalizeRelative(value, label) {
  assert.equal(typeof value, "string", label + "_path_invalid");
  const relative = value.replace(/\\/gu, "/");
  assert.ok(relative.length > 0 && !path.posix.isAbsolute(relative), label + "_path_invalid");
  assert.equal(relative.split("/").some(function (part) { return part === "" || part === "." || part === ".."; }), false, label + "_path_invalid");
  return relative;
}

async function gitRepositoryFiles() {
  const marker = path.join(packageRoot, ".git");
  try {
    await fsp.lstat(marker);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }

  const rootText = run("git", ["-C", packageRoot, "rev-parse", "--show-toplevel"], "git_root").trim();
  const actualRoot = await fsp.realpath(rootText);
  const expectedRoot = await fsp.realpath(packageRoot);
  assert.equal(path.normalize(actualRoot).toLowerCase(), path.normalize(expectedRoot).toLowerCase(), "git_root_mismatch");

  const raw = run("git", ["-C", packageRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], "git_inventory", null);
  assert.ok(Buffer.isBuffer(raw), "git_inventory_invalid");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  assert.ok(decoded === "" || decoded.endsWith("\0"), "git_inventory_not_nul_terminated");
  const entries = decoded === "" ? [] : decoded.slice(0, -1).split("\0").map(function (entry) {
    return normalizeRelative(entry, "repository");
  });
  assert.equal(new Set(entries).size, entries.length, "git_inventory_duplicate");
  return entries.sort();
}

const npmCli = await resolveNpmCli();
const packText = run(process.execPath, [npmCli, "pack", "--dry-run", "--json"], "npm_pack");
const packReport = JSON.parse(packText);
assert.ok(Array.isArray(packReport) && packReport.length === 1, "npm_pack_report_invalid");
const packageFiles = packReport[0].files.map(function (entry) {
  return normalizeRelative(entry.path, "package");
}).sort();
assert.equal(new Set(packageFiles).size, packageFiles.length, "npm_pack_inventory_duplicate");

const repositoryFiles = await gitRepositoryFiles();
const packageSet = new Set(packageFiles);
const repositorySet = new Set(repositoryFiles || []);
const publicFiles = [...new Set([...packageFiles, ...(repositoryFiles || [])])].sort();

const credentialPatterns = [
  ["telegram_token", /\b[0-9]{6,12}:[A-Za-z0-9_-]{20,}\b/u],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._-]{16,}\b/iu],
  ["basic_auth", /\bBasic\s+[A-Za-z0-9+/]{20,}={0,2}\b/u],
  ["github_token", /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u],
  ["aws_access_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ["google_api_key", /\bAIza[A-Za-z0-9_-]{30,}\b/u],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["stripe_live_key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u],
  ["credentialed_database_url", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^/\s:@]+:[^/\s@]+@/iu]
];
const unixMarkers = ["/" + "Users/", "/" + "home/", "/" + "root/", "/" + "opt/ai/"];
const windowsPath = /(?:^|[\s("'(])[A-Za-z]:[\\/](?:Users|Documents|home|root|opt)[\\/][^\s"'<>]*/mu;
const privateMachineLabel = new RegExp("\\b(?:" + [["D", "T", "1"].join(""), ["L", "T", "1"].join("")].join("|") + ")\\b", "u");
const privateNetworkAddress = /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})\b/u;
const privateUri = /(?:file|vscode):\/\/[^\s"'<>]+/iu;
const localHttpUrl = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|[A-Za-z0-9.-]+\.local)(?::\d+)?(?:[/?#]|$)/iu;
const urlPattern = /\bhttps?:\/\/[^\s<>"')\]}]+/giu;

function normalizedSystemText(value) {
  return value.replace(/\\\\/gu, "\\").replace(/\\\//gu, "/").toLowerCase();
}

const systemMarkers = new Set();
for (const candidate of [packageRoot, os.homedir(), os.hostname()]) {
  if (typeof candidate === "string" && candidate.length >= 3 && candidate !== "/app") systemMarkers.add(normalizedSystemText(candidate));
}
for (const records of Object.values(os.networkInterfaces())) {
  for (const record of records || []) {
    if (record && typeof record.address === "string" && !record.internal && record.address.length >= 7) {
      systemMarkers.add(normalizedSystemText(record.address));
    }
  }
}

function assertPublicArtifact(relative) {
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  assert.equal(base === ".env" || base.startsWith(".env.") && base !== ".env.example", false, "private_env_artifact:" + relative);
  assert.equal(lower.split("/").includes(".gorombo"), false, "private_state_artifact:" + relative);
  assert.equal(/\.(?:log|db|sqlite3?|wal|shm)$/u.test(base), false, "private_runtime_artifact:" + relative);
}

function assertPublicUrl(rawUrl, relative) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  assert.equal(parsed.username === "" && parsed.password === "", true, "credentialed_url:" + relative);
  const host = parsed.hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  assert.equal(host === "localhost" || host === "::1" || host === "0.0.0.0" || host.endsWith(".local"), false, "local_url:" + relative);
  assert.equal(privateNetworkAddress.test(host), false, "private_url:" + relative);
}

let scannedBytes = 0;
let packageBytes = 0;
let repositoryBytes = 0;

for (const relative of publicFiles) {
  assertPublicArtifact(relative);
  const absolute = path.resolve(packageRoot, relative);
  const containment = path.relative(packageRoot, absolute);
  assert.ok(containment === "" || !containment.startsWith("..") && !path.isAbsolute(containment), "public_path_outside_root:" + relative);
  const info = await fsp.lstat(absolute);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "public_regular_file_required:" + relative);
  const bytes = await fsp.readFile(absolute);
  scannedBytes += bytes.length;
  if (packageSet.has(relative)) packageBytes += bytes.length;
  if (repositorySet.has(relative)) repositoryBytes += bytes.length;

  const text = bytes.toString("utf8");
  const normalizedText = normalizedSystemText(text);
  for (const [name, pattern] of credentialPatterns) {
    assert.equal(pattern.test(text), false, name + ":" + relative);
  }
  assert.equal(windowsPath.test(text), false, "windows_machine_path:" + relative);
  assert.equal(privateMachineLabel.test(text), false, "private_machine_label:" + relative);
  assert.equal(privateNetworkAddress.test(text), false, "private_network_address:" + relative);
  assert.equal(privateUri.test(text), false, "private_uri:" + relative);
  assert.equal(localHttpUrl.test(text), false, "local_url:" + relative);
  for (const marker of unixMarkers) assert.equal(text.includes(marker), false, "unix_machine_path:" + relative);
  for (const marker of systemMarkers) {
    assert.equal(normalizedText.includes(marker), false, "current_system_marker:" + relative);
  }
  for (const match of text.matchAll(urlPattern)) assertPublicUrl(match[0], relative);
}

process.stdout.write(JSON.stringify({
  status: "ok",
  mode: repositoryFiles === null ? "package-only" : "repository-and-package",
  packageFiles: packageFiles.length,
  repositoryFiles: repositoryFiles === null ? 0 : repositoryFiles.length,
  files: publicFiles.length,
  packageBytes,
  repositoryBytes,
  bytes: scannedBytes
}) + "\n");
