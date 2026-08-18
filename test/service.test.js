import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { buildLayout } from "../src/paths.js";
import {
  buildServiceDescriptor,
  detectServiceManager,
  installService,
  resolveServicePaths,
  restartService,
  serviceStatus,
  stopService,
  uninstallService
} from "../src/service.js";

function runtimeFixture(root) {
  return {
    nodeExecutable: path.join(root, "runtime", "node"),
    cliEntry: path.join(root, "package", "src", "cli.js"),
    packageRoot: path.join(root, "package"),
    codexRoot: path.join(root, ".codex"),
    userIdentity: "fixture-user",
    pathEnvironment: path.join(root, "bin")
  };
}

test("service descriptors are deterministic for all supported user managers", function () {
  const root = path.resolve("service fixture +codex root");
  const runtime = runtimeFixture(root);
  assert.equal(detectServiceManager("linux"), "systemd-user");
  assert.equal(detectServiceManager("darwin"), "launchd-user");
  assert.equal(detectServiceManager("win32"), "windows-task-scheduler");
  assert.throws(function () { detectServiceManager("other"); }, /service_manager_unsupported/);

  const systemd = buildServiceDescriptor("systemd-user", runtime);
  assert.match(systemd, /Type=simple/u);
  assert.match(systemd, /Restart=on-failure/u);
  assert.match(systemd, /WantedBy=default\.target/u);
  assert.match(systemd, /serve/u);
  assert.match(systemd, /--codex-root/u);
  assert.match(systemd, /Environment=.*PATH=/u);
  assert.match(systemd, /^WorkingDirectory=.+service fixture \+codex root.+$/mu);
  assert.equal(systemd.includes('WorkingDirectory="'), false);
  assert.equal(systemd.includes("\\x2b"), false);

  const launchd = buildServiceDescriptor("launchd-user", runtime);
  assert.match(launchd, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(launchd, /<key>SuccessfulExit<\/key><false\/>/u);
  assert.match(launchd, /<key>ProgramArguments<\/key>/u);
  assert.match(launchd, /<key>EnvironmentVariables<\/key>/u);

  const windows = buildServiceDescriptor("windows-task-scheduler", runtime);
  assert.match(windows, /<LogonTrigger>/u);
  assert.match(windows, /<RestartOnFailure>/u);
  assert.match(windows, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.match(windows, /<Command>/u);
  assert.match(windows, /--codex-root/u);

  for (const descriptor of [systemd, launchd, windows]) {
    assert.equal(descriptor.includes("TELEGRAM_BOT_TOKEN"), false);
    assert.equal(descriptor.includes("bot-token-placeholder"), false);
  }
});

test("systemd lifecycle writes only its private definition and preserves product state", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-"));
  const home = path.join(parent, "home");
  const codexRoot = path.join(home, ".codex");
  const layout = buildLayout(codexRoot);
  const calls = [];
  const commandRunner = async function (executable, args) {
    calls.push({ executable, args: [...args] });
    return { code: 0 };
  };
  try {
    await fsp.mkdir(layout.runtimeDir, { recursive: true });
    await fsp.writeFile(layout.environmentFile, "PRIVATE_PLACEHOLDER=preserved\n");
    await fsp.writeFile(layout.databaseFile, "private-state-placeholder\n");
    const result = await installService({
      platform: "linux",
      home,
      codexRoot,
      readiness: { status: "READY", recoveryRequired: false },
      runPreflight: async function () {},
      commandRunner,
      env: { PATH: path.join(parent, "bin") }
    });
    assert.deepEqual(result, { status: "installed", manager: "systemd-user" });
    const paths = resolveServicePaths(layout, { platform: "linux", home });
    const descriptor = await fsp.readFile(paths.descriptorFile, "utf8");
    assert.match(descriptor, /enable|ExecStart/u);
    assert.equal(calls[0].executable, "systemctl");
    assert.deepEqual(calls[0].args, ["--user", "daemon-reload"]);
    assert.deepEqual(calls[1].args, ["--user", "enable", "--now", "gorombo-skill-harvester.service"]);

    const status = await serviceStatus({
      platform: "linux",
      home,
      codexRoot,
      commandRunner,
      inspectReadiness: async function () { return { status: "READY", recoveryRequired: false }; },
      readRuntimeLock: async function () {
        return { instanceId: "run_" + "1".repeat(32) };
      },
      readHeartbeat: async function () {
        return {
          instanceId: "run_" + "1".repeat(32),
          state: "RUNNING",
          observedAt: Date.now()
        };
      }
    });
    assert.equal(status.serviceState, "running");
    assert.equal(status.readiness.status, "READY");

    const removed = await uninstallService({ platform: "linux", home, codexRoot, commandRunner });
    assert.deepEqual(removed, {
      status: "uninstalled",
      manager: "systemd-user",
      privateStatePreserved: true
    });
    await assert.rejects(fsp.lstat(paths.descriptorFile), function (error) { return error && error.code === "ENOENT"; });
    assert.equal(await fsp.readFile(layout.environmentFile, "utf8"), "PRIVATE_PLACEHOLDER=preserved\n");
    assert.equal(await fsp.readFile(layout.databaseFile, "utf8"), "private-state-placeholder\n");
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("service install fails closed before writing when readiness is incomplete", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-not-ready-"));
  const home = path.join(parent, "home");
  const codexRoot = path.join(home, ".codex");
  const layout = buildLayout(codexRoot);
  let commandCount = 0;
  try {
    await fsp.mkdir(layout.runtimeDir, { recursive: true });
    await assert.rejects(installService({
      platform: "linux",
      home,
      codexRoot,
      readiness: { status: "DEGRADED", recoveryRequired: false },
      runPreflight: async function () {},
      commandRunner: async function () { commandCount += 1; return { code: 0 }; }
    }), /service_not_ready/);
    assert.equal(commandCount, 0);
    const paths = resolveServicePaths(layout, { platform: "linux", home });
    await assert.rejects(fsp.lstat(paths.descriptorFile), function (error) { return error && error.code === "ENOENT"; });
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("CLI routes service commands and binds service-started runtime to the discovered root", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-cli-"));
  const codexRoot = path.join(parent, ".codex");
  const stdout = [];
  const stderr = [];
  const calls = [];
  try {
    await fsp.mkdir(codexRoot);
    const base = {
      codexRoot,
      stdout: { write: function (value) { stdout.push(value); } },
      stderr: { write: function (value) { stderr.push(value); } },
      installService: async function (options) {
        calls.push({ command: "install", options });
        return { status: "installed", manager: "fixture" };
      },
      serviceStatus: async function () {
        calls.push({ command: "status" });
        return { status: "ok", manager: "fixture", serviceState: "running", readiness: { status: "READY" } };
      }
    };
    assert.equal(await runCli(["service", "install"], base), 0);
    assert.equal(calls[0].command, "install");
    assert.equal(calls[0].options.codexRoot, codexRoot);
    assert.equal(await runCli(["service", "status", "--json"], base), 0);
    assert.equal(calls[1].command, "status");

    let runtimeOptions = null;
    const processHost = {
      once: function () {},
      removeListener: function () {}
    };
    assert.equal(await runCli(["serve", "--codex-root", codexRoot], {
      ...base,
      processHost,
      startRuntime: async function (options) {
        runtimeOptions = options;
        return {
          status: function () { return { status: "RUNNING" }; },
          stop: async function () { return { status: "stopped" }; },
          done: Promise.resolve({ status: "stopped" })
        };
      }
    }), 0);
    assert.equal(runtimeOptions.codexRoot, path.resolve(codexRoot));
    assert.equal(runtimeOptions.env.CODEX_HOME, path.resolve(codexRoot));
    assert.equal(stderr.length, 0);
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("Windows restart waits for graceful ownership release before starting", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-windows-restart-"));
  const home = path.join(parent, "home");
  const codexRoot = path.join(home, ".codex");
  const layout = buildLayout(codexRoot);
  const events = [];
  let running = true;
  try {
    await fsp.mkdir(layout.runtimeDir, { recursive: true });
    const paths = resolveServicePaths(layout, { platform: "win32", home });
    await fsp.writeFile(paths.descriptorFile, "<Task/>\n");
    const result = await restartService({
      platform: "win32",
      home,
      codexRoot,
      sendControlCommand: async function () {
        events.push("shutdown");
        running = false;
        return { status: "shutdown_requested" };
      },
      readRuntimeLock: async function () {
        return running ? { instanceId: "run_" + "2".repeat(32) } : null;
      },
      readHeartbeat: async function () {
        return {
          instanceId: "run_" + "2".repeat(32),
          state: running ? "RUNNING" : "STOPPED",
          observedAt: Date.now()
        };
      },
      commandRunner: async function (executable, args) {
        events.push(executable + ":" + args[0]);
        return { code: 0 };
      }
    });
    assert.deepEqual(result, { status: "restarted", manager: "windows-task-scheduler" });
    assert.deepEqual(events, ["shutdown", "schtasks.exe:/Run"]);
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("forced Windows stop cannot race a restart while ownership remains", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-windows-forced-"));
  const home = path.join(parent, "home");
  const codexRoot = path.join(home, ".codex");
  const layout = buildLayout(codexRoot);
  const calls = [];
  try {
    await fsp.mkdir(layout.runtimeDir, { recursive: true });
    const paths = resolveServicePaths(layout, { platform: "win32", home });
    await fsp.writeFile(paths.descriptorFile, "<Task/>\n");
    await assert.rejects(restartService({
      platform: "win32",
      home,
      codexRoot,
      shutdownWaitMs: 0,
      managerStopWaitMs: 0,
      sendControlCommand: async function () { throw new Error("runtime_unavailable"); },
      readRuntimeLock: async function () { return { instanceId: "run_" + "3".repeat(32) }; },
      readHeartbeat: async function () {
        return { instanceId: "run_" + "3".repeat(32), state: "RUNNING", observedAt: Date.now() };
      },
      commandRunner: async function (executable, args) {
        calls.push({ executable, args: [...args] });
        return { code: 0 };
      }
    }), /service_stop_recovery_required/);
    assert.deepEqual(calls.map(function (item) { return item.args[0]; }), ["/End"]);
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("service mutation failures stay visible and retain the descriptor", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-manager-failure-"));
  const home = path.join(parent, "home");
  const codexRoot = path.join(home, ".codex");
  const layout = buildLayout(codexRoot);
  try {
    await fsp.mkdir(layout.runtimeDir, { recursive: true });
    const paths = resolveServicePaths(layout, { platform: "linux", home });
    await fsp.mkdir(path.dirname(paths.descriptorFile), { recursive: true });
    await fsp.writeFile(paths.descriptorFile, "[Service]\n");
    await assert.rejects(stopService({
      platform: "linux",
      home,
      codexRoot,
      sendControlCommand: async function () { return { status: "shutdown_requested" }; },
      readRuntimeLock: async function () { return null; },
      readHeartbeat: async function () { return { state: "STOPPED", observedAt: Date.now() }; },
      commandRunner: async function () { return { code: 5 }; }
    }), /service_command_failed/);
    assert.equal((await fsp.lstat(paths.descriptorFile)).isFile(), true);
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});

test("Windows status distinguishes running, stopped, and manager uncertainty", async function () {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-service-windows-status-"));
  const home = path.join(parent, "home");
  const codexRoot = path.join(home, ".codex");
  const layout = buildLayout(codexRoot);
  let managerCode = 0;
  let running = true;
  try {
    await fsp.mkdir(layout.runtimeDir, { recursive: true });
    const paths = resolveServicePaths(layout, { platform: "win32", home });
    await fsp.writeFile(paths.descriptorFile, "<Task/>\n");
    const options = {
      platform: "win32",
      home,
      codexRoot,
      commandRunner: async function () { return { code: managerCode }; },
      inspectReadiness: async function () { return { status: "READY", recoveryRequired: false }; },
      readRuntimeLock: async function () {
        return running ? { instanceId: "run_" + "4".repeat(32) } : null;
      },
      readHeartbeat: async function () {
        return {
          instanceId: "run_" + "4".repeat(32),
          state: running ? "RUNNING" : "STOPPED",
          observedAt: Date.now()
        };
      }
    };
    assert.equal((await serviceStatus(options)).serviceState, "running");
    running = false;
    assert.equal((await serviceStatus(options)).serviceState, "stopped");
    managerCode = 1;
    assert.equal((await serviceStatus(options)).serviceState, "unknown");
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }
});
