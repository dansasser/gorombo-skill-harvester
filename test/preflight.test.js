import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  compareCodexVersions,
  discoverCodexCandidates,
  parseStableCodexVersion,
  resolveVerifiedCodexLaunchPlan,
  runBoundedCodexProbe
} from "../src/codex-launcher.js";
import { preparePreflight, runPreflight } from "../src/preflight.js";

function candidate(name, provenance = "packaged") {
  return {
    command: "fixture-node",
    argsPrefix: [name],
    provenance,
    source: provenance === "packaged" ? "fixture-package" : "fixture-native"
  };
}

function scriptedSpawn(handler, calls = []) {
  return function (command, args, options) {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.kill = function () { return true; };
    queueMicrotask(function () {
      const response = handler(command, args) || {};
      if (response.error) {
        child.emit("error", Object.assign(new Error("private child diagnostic"), { code: response.error }));
        return;
      }
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", response.code === undefined ? 0 : response.code);
    });
    return child;
  };
}

test("stable Codex versions parse and compare strictly", function () {
  assert.deepEqual([...parseStableCodexVersion("codex-cli 0.147.0\n")], [0, 147, 0]);
  assert.deepEqual([...parseStableCodexVersion("codex 1.2.3")], [1, 2, 3]);
  assert.equal(compareCodexVersions([0, 148, 0], [0, 147, 9]), 1);
  assert.throws(function () { parseStableCodexVersion("codex-cli 0.148.0-beta.1"); }, /codex_version_unstable/);
  assert.throws(function () { parseStableCodexVersion("unexpected 0.148.0"); }, /codex_version_invalid/);
});

test("verified discovery selects the highest compatible packaged launcher before native fallback", async function () {
  const calls = [];
  const spawn = scriptedSpawn(function (_command, args) {
    if (args[0] === "old.js") return { stdout: "codex-cli 0.147.0\n" };
    if (args[0] === "new.js") return { stdout: "codex-cli 0.149.1\n" };
    return { stdout: "codex-cli 9.0.0\n" };
  }, calls);
  const verified = await resolveVerifiedCodexLaunchPlan({
    candidates: [candidate("old.js"), candidate("new.js"), candidate("native", "native")],
    spawn
  });
  assert.equal(verified.plan.version, "0.149.1");
  assert.equal(verified.plan.argsPrefix[0], "new.js");
  assert.equal(calls.some(function (call) { return call.args[0] === "native"; }), false);
});

test("native discovery is used only when no packaged candidate is compatible", async function () {
  const spawn = scriptedSpawn(function (_command, args) {
    return { stdout: args[0] === "old.js" ? "codex-cli 0.146.9\n" : "codex-cli 0.150.0\n" };
  });
  const verified = await resolveVerifiedCodexLaunchPlan({
    candidates: [candidate("old.js"), candidate("native", "native")],
    spawn
  });
  assert.equal(verified.plan.provenance, "native");
  assert.equal(verified.plan.version, "0.150.0");
  assert.ok(verified.diagnostics.some(function (item) { return item.code === "codex_version_unsupported"; }));
});

test("PATH package discovery avoids Windows command shims", async function () {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-codex-"));
  try {
    const bin = path.join(temporary, "bin");
    const packageRoot = path.join(bin, "node_modules", "@openai", "codex");
    await fsp.mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    await fsp.writeFile(path.join(packageRoot, "bin", "codex.js"), "process.exitCode = 0;\n");
    const candidates = discoverCodexCandidates({
      env: { PATH: bin },
      platform: "win32",
      processExecPath: process.execPath
    });
    const packaged = candidates.find(function (item) { return item.provenance === "packaged"; });
    assert.ok(packaged);
    assert.equal(packaged.command, process.execPath);
    assert.equal(packaged.argsPrefix.length, 1);
    assert.equal(candidates.some(function (item) { return /\.(?:cmd|bat|ps1)$/iu.test(item.command); }), false);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("NVM installations are discovered without PATH or shell-profile loading", async function () {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-nvm-"));
  try {
    const nvmRoot = path.join(temporary, ".nvm");
    const install = async function (version) {
      const packageRoot = path.join(nvmRoot, "versions", "node", version, "lib", "node_modules", "@openai", "codex");
      await fsp.mkdir(path.join(packageRoot, "bin"), { recursive: true });
      await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
      const script = path.join(packageRoot, "bin", "codex.js");
      await fsp.writeFile(script, "process.exitCode = 0;\n");
      return script;
    };
    const oldScript = await install("v20.20.0");
    const currentScript = await install("v22.22.3");
    await install("v23.0.0-beta.1");
    const candidates = discoverCodexCandidates({
      env: { PATH: "", HOME: temporary },
      platform: "linux",
      processExecPath: process.execPath
    }).filter(function (item) { return item.source === "nvm-package"; });
    assert.deepEqual(candidates.map(function (item) { return item.argsPrefix[0]; }).sort(), [oldScript, currentScript].sort());
    const verified = await resolveVerifiedCodexLaunchPlan({
      candidates,
      probe: async function (plan, args) {
        assert.deepEqual(args, ["--version"]);
        return { exitCode: 0, stdout: plan.argsPrefix[0] === oldScript ? "codex-cli 0.146.0\n" : "codex-cli 0.147.0\n" };
      }
    });
    assert.equal(verified.plan.version, "0.147.0");
    assert.equal(verified.plan.argsPrefix[0], currentScript);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("runtime-manager discovery remains available when PATH reaches its independent cap", async function () {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-nvm-path-cap-"));
  try {
    const pathEntries = [];
    for (let index = 0; index < 128; index += 1) {
      const entry = path.join(temporary, "path-" + index);
      await fsp.mkdir(entry);
      pathEntries.push(entry);
    }
    const nvmRoot = path.join(temporary, "nvm");
    const versionDirectory = process.platform === "win32"
      ? path.join(nvmRoot, "v22.22.3")
      : path.join(nvmRoot, "versions", "node", "v22.22.3");
    const packageRoot = process.platform === "win32"
      ? path.join(versionDirectory, "node_modules", "@openai", "codex")
      : path.join(versionDirectory, "lib", "node_modules", "@openai", "codex");
    await fsp.mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await fsp.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    const script = path.join(packageRoot, "bin", "codex.js");
    await fsp.writeFile(script, "process.exitCode = 0;\n");
    const environment = { PATH: pathEntries.join(path.delimiter) };
    if (process.platform === "win32") environment.NVM_HOME = nvmRoot;
    else environment.NVM_DIR = nvmRoot;
    const candidates = discoverCodexCandidates({
      env: environment,
      platform: process.platform,
      processExecPath: process.execPath
    });
    assert.ok(candidates.some(function (item) {
      return item.source === "nvm-package" && item.argsPrefix[0] === script;
    }));
    assert.ok(candidates.length <= 256);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("oversized NVM version roots are ignored instead of partially scanned", async function () {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-nvm-cap-"));
  try {
    const versionsRoot = path.join(temporary, ".nvm", "versions", "node");
    for (let index = 0; index < 65; index += 1) await fsp.mkdir(path.join(versionsRoot, "v22.0." + index), { recursive: true });
    const packageRoot = path.join(versionsRoot, "v22.0.64", "lib", "node_modules", "@openai", "codex");
    await fsp.mkdir(path.join(packageRoot, "bin"), { recursive: true });
    await fsp.writeFile(path.join(packageRoot, "bin", "codex.js"), "process.exitCode = 0;\n");
    const candidates = discoverCodexCandidates({
      env: { PATH: "", HOME: temporary },
      platform: "linux",
      processExecPath: process.execPath
    });
    assert.equal(candidates.some(function (item) { return item.source === "nvm-package"; }), false);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("preflight verifies version, login, and App Server with one private launch plan", async function () {
  const calls = [];
  const privateHome = path.join(os.tmpdir(), "gorombo-skill-harvester-private-home");
  const spawn = scriptedSpawn(function (_command, args) {
    const tail = args.slice(1);
    if (tail.length === 1 && tail[0] === "--version") return { stdout: "codex-cli 0.147.0\n" };
    if (tail[0] === "login") return { stdout: "private-auth-mode\n" };
    if (tail[0] === "app-server") return { stdout: "private-help-output\n" };
    return { code: 64 };
  }, calls);
  const prepared = await preparePreflight({
    candidates: [candidate("fixture-codex.js")],
    spawn,
    env: {
      PATH: "fixture-path",
      CODEX_HOME: privateHome,
      TELEGRAM_BOT_TOKEN: "private-telegram-canary"
    }
  });
  assert.equal(prepared.report.ok, true);
  assert.deepEqual(prepared.report.codex, {
    available: true,
    version: "0.147.0",
    minimumVersion: "0.147.0",
    authentication: "available",
    appServer: "available"
  });
  assert.deepEqual(calls.map(function (call) { return call.args.slice(1); }), [
    ["--version"],
    ["login", "status"],
    ["app-server", "--help"]
  ]);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.CODEX_HOME, privateHome);
    assert.equal(Object.hasOwn(call.options.env, "TELEGRAM_BOT_TOKEN"), false);
  }
  const serialized = JSON.stringify(prepared.report);
  assert.equal(serialized.includes(privateHome), false);
  assert.equal(serialized.includes("private-auth-mode"), false);
  assert.equal(serialized.includes("private-help-output"), false);
  assert.equal(serialized.includes("fixture-codex.js"), false);
});

test("preflight failures expose only safe categories", async function () {
  const spawn = scriptedSpawn(function (_command, args) {
    const tail = args.slice(1);
    if (tail.length === 1 && tail[0] === "--version") return { stdout: "codex-cli 0.147.0\n" };
    if (tail[0] === "login") return { code: 1, stdout: "private-auth-output", stderr: "private-diagnostic" };
    return { code: 0 };
  });
  await assert.rejects(runPreflight({
    candidates: [candidate("fixture-codex.js")],
    spawn
  }), function (error) {
    assert.equal(error.message, "codex_login_status_failed");
    assert.equal(JSON.stringify(error).includes("private-auth-output"), false);
    assert.equal(JSON.stringify(error).includes("private-diagnostic"), false);
    return true;
  });
});

test("bounded probes terminate on timeout and output overflow", async function () {
  const plan = candidate("fixture-codex.js");
  let terminations = 0;
  const never = function () {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.kill = function () { return true; };
    return child;
  };
  await assert.rejects(runBoundedCodexProbe(plan, ["--version"], {
    spawn: never,
    timeoutMs: 5,
    terminateChild: async function () { terminations += 1; return true; }
  }), /codex_probe_timeout/);
  const overflow = function () {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12346;
    child.kill = function () { return true; };
    queueMicrotask(function () { child.stdout.write(Buffer.alloc(2048)); });
    return child;
  };
  await assert.rejects(runBoundedCodexProbe(plan, ["--version"], {
    spawn: overflow,
    outputLimitBytes: 1024,
    timeoutMs: 100,
    terminateChild: async function () { terminations += 1; return true; }
  }), /codex_probe_output_limit/);
  assert.equal(terminations, 2);
});
