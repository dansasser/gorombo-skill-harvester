import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(".");
const packedTest = process.env.GOROMBO_SKILL_HARVESTER_PACKED_TEST === "1";

function resolveNpmCli() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(function (candidate) { return typeof candidate === "string" && path.isAbsolute(candidate); });
  for (const candidate of candidates) {
    try {
      const info = fs.lstatSync(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch {}
  }
  throw new Error("npm_cli_unavailable");
}

const npmCli = resolveNpmCli();

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || packageRoot,
    env: options.env || process.env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(result.error, undefined, "child_launch_failed");
  if (options.allowedStatuses) assert.ok(options.allowedStatuses.includes(result.status), "child_exit_unexpected");
  else assert.equal(result.status, 0, "child_exit_nonzero");
  return result;
}

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

test("public scan covers repository candidates and packed files", { skip: packedTest }, function () {
  const scanned = run(process.execPath, ["scripts/scan-public.mjs"]);
  const report = JSON.parse(scanned.stdout.trim().split(/\r?\n/u).at(-1));
  const listed = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const repositoryFiles = listed.stdout.split("\0").filter(Boolean);
  assert.equal(report.status, "ok");
  assert.equal(report.mode, "repository-and-package");
  assert.equal(report.repositoryFiles, repositoryFiles.length);
  assert.ok(report.repositoryFiles > report.packageFiles);
  assert.equal(report.files, report.repositoryFiles);
  assert.ok(repositoryFiles.includes(".github/ISSUE_TEMPLATE/bug-report.yml"));
});

test("packed package installs cleanly, verifies its tests, and onboarding creates only owned private state", { timeout: 120000, skip: packedTest }, async function () {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-package-"));
  const installRoot = path.join(temporary, "install");
  const codexRoot = path.join(temporary, "codex-home");
  try {
    await fsp.mkdir(installRoot);
    await fsp.mkdir(codexRoot);

    const packed = run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", temporary]);
    const report = JSON.parse(packed.stdout);
    assert.ok(Array.isArray(report) && report.length === 1);
    const tarball = path.join(temporary, report[0].filename);

    run(process.execPath, [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      tarball
    ]);

    const installed = path.join(installRoot, "node_modules", "@gorombo", "gorombo-skill-harvester");
    const cli = path.join(installed, "src", "cli.js");
    assert.equal(await exists(path.join(installed, "CHANGELOG.md")), true);
    assert.equal(await exists(path.join(installed, "CODE_OF_CONDUCT.md")), true);
    assert.equal(await exists(path.join(installed, "CONTRIBUTING.md")), true);
    assert.equal(await exists(path.join(installed, "SECURITY.md")), true);
    assert.equal(await exists(path.join(installed, "SUPPORT.md")), true);
    for (const document of ["README.md", "configuration.md", "development.md", "getting-started.md", "migration.md", "operations.md"]) {
      assert.equal(await exists(path.join(installed, "docs", document)), true);
    }
    assert.equal(await exists(path.join(installed, "docs", "planning")), false);
    assert.equal(await exists(path.join(installed, "docs", "specs")), false);
    assert.equal(await exists(path.join(installed, "skills", "gorombo-skill-harvester", "references", "onboarding.md")), true);
    assert.equal(await exists(path.join(installed, "skills", "gorombo-skill-harvester", "references", "operations.md")), true);
    assert.equal(await exists(path.join(installed, "test", "completion-spool.test.js")), true);
    assert.equal(await exists(path.join(installed, "test", "package-release.test.js")), true);
    assert.equal(await exists(path.join(installed, "test", "preflight.test.js")), true);
    assert.equal(await exists(path.join(installed, "src", "codex-launcher.js")), true);

    const verified = run(process.execPath, [path.join(installed, "scripts", "verify-release.mjs")], {
      cwd: installed,
      env: { ...process.env, GOROMBO_SKILL_HARVESTER_PACKED_TEST: "1" }
    });
    const verificationLine = verified.stdout.trim().split(/\r?\n/u).at(-1);
    const verification = JSON.parse(verificationLine);
    assert.equal(verification.status, "ok");
    assert.equal(verification.deterministicTests, true);

    const fakeBin = path.join(temporary, "fake-bin");
    const fakeCodexRoot = path.join(fakeBin, "node_modules", "@openai", "codex");
    await fsp.mkdir(path.join(fakeCodexRoot, "bin"), { recursive: true });
    await fsp.writeFile(path.join(fakeCodexRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    await fsp.writeFile(path.join(fakeCodexRoot, "bin", "codex.js"), [
      'const args = process.argv.slice(2);',
      'if (args.length === 1 && args[0] === "--version") process.stdout.write("codex-cli 0.147.0\\n");',
      'else if (args.length === 2 && args[0] === "login" && args[1] === "status") process.exitCode = 0;',
      'else if (args.length === 2 && args[0] === "app-server" && args[1] === "--help") process.exitCode = 0;',
      'else process.exitCode = 64;',
      ''
    ].join("\n"));
    const childEnv = { ...process.env, CODEX_HOME: codexRoot, PATH: fakeBin };
    const preflight = run(process.execPath, [cli, "preflight", "--json"], { env: childEnv });
    assert.equal(JSON.parse(preflight.stdout).ok, true);

    const status = run(process.execPath, [cli, "status", "--json"], {
      env: childEnv,
      allowedStatuses: [2]
    });
    assert.equal(JSON.parse(status.stdout).status, "NEEDS_ONBOARDING");
    assert.equal(await exists(path.join(codexRoot, ".gorombo")), false);

    const onboarded = run(process.execPath, [cli, "onboard", "--route", "session"], {
      env: childEnv,
      allowedStatuses: [2]
    });
    assert.equal(JSON.parse(onboarded.stdout).routeMode, "session");
    assert.equal(await exists(path.join(codexRoot, ".gorombo", ".env")), false);
    assert.equal(await exists(path.join(codexRoot, ".gorombo", "gorombo-skill-harvester", "config.json")), true);
    assert.equal(await exists(path.join(codexRoot, ".gorombo", "gorombo-skill-harvester", "state.sqlite3")), true);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});
