#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

async function collectFiles(directory) {
  const absolute = path.join(packageRoot, directory);
  const entries = await fsp.readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(absolute, entry.name);
    const relative = path.relative(packageRoot, target).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error("public_symlink_disallowed:" + relative);
    if (entry.isDirectory()) files.push(...await collectFiles(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

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

const npmCli = await resolveNpmCli();

function runNpm(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.error, undefined, "npm_launch_failed");
  assert.equal(result.status, 0, "npm_pack_failed");
  return result.stdout;
}

const report = JSON.parse(runNpm(["pack", "--dry-run", "--json"]));
assert.ok(Array.isArray(report) && report.length === 1, "npm_pack_report_invalid");
const files = report[0].files.map(function (item) { return item.path.replace(/\\/gu, "/"); }).sort();
const required = [
  ".codex-plugin/plugin.json",
  ".env.example",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/README.md",
  "docs/configuration.md",
  "docs/development.md",
  "docs/getting-started.md",
  "docs/migration.md",
  "docs/operations.md",
  "hooks/completion-hook.mjs",
  "hooks/hooks.json",
  "migrations/001-initial.sql",
  "migrations/002-external-alerts.sql",
  "migrations/003-generic-external-alert-source.sql",
  "scripts/scan-public.mjs",
  "scripts/validate-package.mjs",
  "scripts/validate-skill.mjs",
  "scripts/verify-identity.mjs",
  "scripts/verify-release.mjs",
  "skills/gorombo-skill-harvester/SKILL.md",
  "skills/gorombo-skill-harvester/agents/openai.yaml",
  "skills/gorombo-skill-harvester/references/onboarding.md",
  "skills/gorombo-skill-harvester/references/operations.md",
  "src/cli.js",
  "src/codex-launcher.js",
  "test/completion-spool.test.js",
  "test/preflight.test.js",
  "test/package-release.test.js"
];
for (const expected of required) assert.ok(files.includes(expected), "package_file_missing:" + expected);
assert.equal(files.some(function (name) { return name.startsWith("docs/planning/") || name.startsWith("docs/specs/"); }), false, "internal_design_docs_packed");

for (const name of files) {
  assert.equal(name === ".env" || name.endsWith("/.env"), false, "private_env_packed");
  assert.equal(name.includes(".gorombo"), false, "private_state_packed");
  assert.equal(/\.(?:sqlite3?|db|log|tgz)$/iu.test(name), false, "private_artifact_packed");
  assert.equal(/(?:-wal|-shm|runtime\.lock|heartbeat\.json)$/iu.test(name), false, "runtime_artifact_packed");
}
assert.equal(files.includes("package-lock.json"), false, "npm_lockfile_should_not_be_packed");
const sourceTests = await collectFiles("test");
const packedTests = files.filter(function (name) { return /^test\//u.test(name); });
assert.deepEqual(packedTests, sourceTests, "packed_tests_incomplete");

const metadata = JSON.parse(await fsp.readFile(path.join(packageRoot, "package.json"), "utf8"));
assert.equal(metadata.private, false);
assert.equal(metadata.type, "module");
assert.equal(metadata.bin["gorombo-skill-harvester"], "./src/cli.js");
assert.equal(metadata.name, "@gorombo/gorombo-skill-harvester");
assert.equal(metadata.repository.url, "git+https://github.com/dansasser/gorombo-skill-harvester.git");
assert.equal(metadata.homepage, "https://github.com/dansasser/gorombo-skill-harvester#readme");
assert.equal(Object.hasOwn(metadata, "dependencies"), false, "runtime_dependencies_unexpected");

process.stdout.write(JSON.stringify({
  status: "ok",
  files: files.length,
  bytes: report[0].unpackedSize,
  packageLockInRepositoryOnly: true,
  deterministicTestsPacked: true
}) + "\n");
