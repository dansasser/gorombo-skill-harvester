#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const checkOnly = process.argv.slice(2);
assert.ok(checkOnly.length === 0 || checkOnly.length === 1 && checkOnly[0] === "--check-only", "usage_invalid");

async function collectJavaScript(directory) {
  const absolute = path.join(packageRoot, directory);
  const entries = await fsp.readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(absolute, entry.name);
    const relative = path.relative(packageRoot, target);
    if (entry.isSymbolicLink()) throw new Error("public_symlink_disallowed:" + relative);
    if (entry.isDirectory()) files.push(...await collectJavaScript(relative));
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) files.push(relative);
  }
  return files;
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });
  assert.equal(result.error, undefined, "verification_launch_failed");
  assert.equal(result.status, 0, "verification_failed:" + args.join(" "));
}

const syntaxFiles = [
  ...await collectJavaScript("src"),
  ...await collectJavaScript("hooks"),
  ...await collectJavaScript("scripts"),
  ...await collectJavaScript("test")
].sort();
for (const file of syntaxFiles) runNode(["--check", file]);

runNode(["scripts/validate-skill.mjs"]);
runNode(["scripts/validate-package.mjs"]);
runNode(["scripts/verify-identity.mjs"]);
runNode(["scripts/scan-public.mjs"]);
if (!checkOnly.length) runNode(["--test"]);

process.stdout.write(JSON.stringify({
  status: "ok",
  syntaxFiles: syntaxFiles.length,
  deterministicTests: !checkOnly.length
}) + "\n");
