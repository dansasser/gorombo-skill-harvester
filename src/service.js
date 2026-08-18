import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendControlCommand } from "./control.js";
import { buildLayout, resolveCodexRoot } from "./paths.js";
import { runPreflight } from "./preflight.js";
import { inspectReadiness } from "./readiness.js";
import { readHeartbeat, readRuntimeLock } from "./runtime-lock.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.js", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVICE_NAME = "gorombo-skill-harvester";
const LAUNCHD_LABEL = "com.gorombo.gorombo-skill-harvester";
const WINDOWS_TASK = "\\Gorombo\\gorombo-skill-harvester";
const MAX_MANAGER_OUTPUT_BYTES = 64 * 1024;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function absoluteValue(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw codedError(code);
  return path.resolve(value);
}

function xml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function systemdArgument(value) {
  return "\"" + String(value).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"").replace(/%/gu, "%%").replace(/\$/gu, "$$") + "\"";
}

function systemdPath(value) {
  return String(value).replace(/\\/gu, "\\\\").replace(/%/gu, "%%");
}

function windowsArgument(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return "\"" + text.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1") + "\"";
}

function safePathEnvironment(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 64 * 1024 || /[\u0000\r\n]/u.test(value)) throw codedError("service_environment_invalid");
  return value;
}

export function detectServiceManager(platform = process.platform) {
  if (platform === "linux") return "systemd-user";
  if (platform === "darwin") return "launchd-user";
  if (platform === "win32") return "windows-task-scheduler";
  throw codedError("service_manager_unsupported");
}

export function resolveServicePaths(layout, options = {}) {
  const manager = options.manager || detectServiceManager(options.platform);
  const home = absoluteValue(options.home || os.homedir(), "service_home_invalid");
  const nodeExecutable = absoluteValue(options.nodeExecutable || process.execPath, "service_node_invalid");
  const cliEntry = absoluteValue(options.cliEntry || CLI_ENTRY, "service_entry_invalid");
  const packageRoot = absoluteValue(options.packageRoot || PACKAGE_ROOT, "service_package_invalid");
  let descriptorFile;
  let managerTarget;
  if (manager === "systemd-user") {
    descriptorFile = path.join(home, ".config", "systemd", "user", SERVICE_NAME + ".service");
    managerTarget = SERVICE_NAME + ".service";
  } else if (manager === "launchd-user") {
    descriptorFile = path.join(home, "Library", "LaunchAgents", LAUNCHD_LABEL + ".plist");
    managerTarget = LAUNCHD_LABEL;
  } else if (manager === "windows-task-scheduler") {
    descriptorFile = path.join(layout.runtimeDir, "service-task.xml");
    managerTarget = WINDOWS_TASK;
  } else throw codedError("service_manager_unsupported");
  return Object.freeze({
    manager,
    descriptorFile,
    managerTarget,
    home,
    nodeExecutable,
    cliEntry,
    packageRoot,
    codexRoot: absoluteValue(layout.codexRoot, "service_codex_root_invalid")
  });
}

export function buildServiceDescriptor(manager, runtime) {
  const nodeExecutable = absoluteValue(runtime.nodeExecutable, "service_node_invalid");
  const cliEntry = absoluteValue(runtime.cliEntry, "service_entry_invalid");
  const packageRoot = absoluteValue(runtime.packageRoot, "service_package_invalid");
  const codexRoot = absoluteValue(runtime.codexRoot, "service_codex_root_invalid");
  const pathEnvironment = safePathEnvironment(runtime.pathEnvironment);
  if (manager === "systemd-user") {
    const command = [nodeExecutable, cliEntry, "serve", "--codex-root", codexRoot].map(systemdArgument).join(" ");
    return [
      "[Unit]",
      "Description=Gorombo Skill Harvester",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "ExecStart=" + command,
      "WorkingDirectory=" + systemdPath(packageRoot),
      ...(pathEnvironment ? ["Environment=" + systemdArgument("PATH=" + pathEnvironment)] : []),
      "Restart=on-failure",
      "RestartSec=5s",
      "TimeoutStopSec=45s",
      "NoNewPrivileges=true",
      "",
      "[Install]",
      "WantedBy=default.target",
      ""
    ].join("\n");
  }
  if (manager === "launchd-user") {
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\">",
      "<dict>",
      "  <key>Label</key><string>" + xml(LAUNCHD_LABEL) + "</string>",
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>" + xml(nodeExecutable) + "</string>",
      "    <string>" + xml(cliEntry) + "</string>",
      "    <string>serve</string>",
      "    <string>--codex-root</string>",
      "    <string>" + xml(codexRoot) + "</string>",
      "  </array>",
      "  <key>WorkingDirectory</key><string>" + xml(packageRoot) + "</string>",
      ...(pathEnvironment ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict><key>PATH</key><string>" + xml(pathEnvironment) + "</string></dict>"
      ] : []),
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
      "  <key>ThrottleInterval</key><integer>5</integer>",
      "  <key>ProcessType</key><string>Background</string>",
      "</dict>",
      "</plist>",
      ""
    ].join("\n");
  }
  if (manager === "windows-task-scheduler") {
    const userIdentity = typeof runtime.userIdentity === "string" && runtime.userIdentity.trim()
      ? runtime.userIdentity.trim()
      : os.userInfo().username;
    const argumentsText = [cliEntry, "serve", "--codex-root", codexRoot].map(windowsArgument).join(" ");
    return [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
      "  <RegistrationInfo><Description>Gorombo Skill Harvester</Description><URI>" + xml(WINDOWS_TASK) + "</URI></RegistrationInfo>",
      "  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + xml(userIdentity) + "</UserId></LogonTrigger></Triggers>",
      "  <Principals><Principal id=\"Author\"><UserId>" + xml(userIdentity) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
      "  <Settings>",
      "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "    <StartWhenAvailable>true</StartWhenAvailable>",
      "    <RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>",
      "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "    <Enabled>true</Enabled>",
      "  </Settings>",
      "  <Actions Context=\"Author\"><Exec>",
      "    <Command>" + xml(nodeExecutable) + "</Command>",
      "    <Arguments>" + xml(argumentsText) + "</Arguments>",
      "    <WorkingDirectory>" + xml(packageRoot) + "</WorkingDirectory>",
      "  </Exec></Actions>",
      "</Task>",
      ""
    ].join("\n");
  }
  throw codedError("service_manager_unsupported");
}

async function defaultCommandRunner(executable, args, options = {}) {
  return await new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = function (value) {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      finish({ code: null, errorCode: "service_command_launch_failed", stdout: "", stderr: "" });
      return;
    }
    let outputBytes = 0;
    let oversized = false;
    const stdout = [];
    const stderr = [];
    const onData = function (target, chunk) {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_MANAGER_OUTPUT_BYTES) target.push(chunk);
      if (outputBytes > MAX_MANAGER_OUTPUT_BYTES && !oversized) {
        oversized = true;
        try { child.kill(); } catch {}
      }
    };
    child.stdout.on("data", function (chunk) { onData(stdout, chunk); });
    child.stderr.on("data", function (chunk) { onData(stderr, chunk); });
    child.once("error", function () {
      finish({ code: null, errorCode: "service_command_failed", stdout: "", stderr: "" });
    });
    child.once("close", function (code) {
      finish({
        code: oversized ? null : code,
        errorCode: oversized ? "service_command_output_too_large" : null,
        stdout: oversized ? "" : Buffer.concat(stdout).toString("utf8"),
        stderr: oversized ? "" : Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function command(paths, executable, args, options = {}) {
  const runner = options.commandRunner || defaultCommandRunner;
  let result;
  try { result = await runner(executable, args, { cwd: paths.packageRoot, env: options.env || process.env }); }
  catch { throw codedError("service_command_failed"); }
  if (!result || !Number.isInteger(result.code)) throw codedError(result && result.errorCode || "service_command_failed");
  if (result.code !== 0 && !options.allowFailure) throw codedError("service_command_failed");
  return {
    code: result.code,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : ""
  };
}

async function safeDescriptorDirectory(paths) {
  const directory = path.dirname(paths.descriptorFile);
  const base = paths.manager === "windows-task-scheduler" ? path.resolve(path.dirname(paths.descriptorFile), "..") : paths.home;
  const relative = path.relative(base, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw codedError("service_descriptor_path_invalid");
  let current = base;
  const baseInfo = await fsp.lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw codedError("service_descriptor_path_invalid");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await fsp.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw codedError("service_descriptor_path_invalid");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      await fsp.mkdir(current, { mode: 0o700 });
    }
    const verified = await fsp.lstat(current);
    if (!verified.isDirectory() || verified.isSymbolicLink()) throw codedError("service_descriptor_path_invalid");
  }
  return directory;
}

async function writeDescriptor(paths, content) {
  const directory = await safeDescriptorDirectory(paths);
  try {
    const current = await fsp.lstat(paths.descriptorFile);
    if (!current.isFile() || current.isSymbolicLink()) throw codedError("service_descriptor_path_invalid");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, "." + SERVICE_NAME + "." + process.pid + "." + Date.now() + ".tmp");
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(temporary, paths.descriptorFile);
  } catch (error) {
    try { await fsp.unlink(temporary); } catch {}
    throw error;
  }
  if (process.platform !== "win32") await fsp.chmod(paths.descriptorFile, 0o600);
}

async function removeDescriptor(paths) {
  try {
    const info = await fsp.lstat(paths.descriptorFile);
    if (!info.isFile() || info.isSymbolicLink()) throw codedError("service_descriptor_path_invalid");
    await fsp.unlink(paths.descriptorFile);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function context(options = {}) {
  const environment = options.env || process.env;
  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: environment, home: options.home });
  const layout = buildLayout(codexRoot);
  const manager = options.manager || detectServiceManager(options.platform);
  const paths = resolveServicePaths(layout, {
    manager,
    platform: options.platform,
    home: options.home,
    nodeExecutable: options.nodeExecutable,
    cliEntry: options.cliEntry,
    packageRoot: options.packageRoot
  });
  return { environment, codexRoot, layout, manager, paths };
}

async function readyForInstall(options, ctx) {
  const inspect = options.inspectReadiness || inspectReadiness;
  const snapshot = options.readiness || await inspect({ codexRoot: ctx.codexRoot, env: ctx.environment, home: options.home });
  if (!snapshot || snapshot.status !== "READY" || snapshot.recoveryRequired) throw codedError("service_not_ready");
}

async function descriptorExists(paths) {
  try {
    const info = await fsp.lstat(paths.descriptorFile);
    if (!info.isFile() || info.isSymbolicLink()) throw codedError("service_descriptor_path_invalid");
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function managerProbe(ctx, options) {
  if (ctx.manager === "systemd-user") {
    return await command(ctx.paths, "systemctl", ["--user", "is-active", ctx.paths.managerTarget], { ...options, allowFailure: true });
  }
  if (ctx.manager === "launchd-user") {
    const domain = "gui/" + String(options.uid === undefined ? process.getuid() : options.uid);
    return await command(ctx.paths, "launchctl", ["print", domain + "/" + ctx.paths.managerTarget], { ...options, allowFailure: true });
  }
  return await command(ctx.paths, "schtasks.exe", ["/Query", "/TN", ctx.paths.managerTarget], { ...options, allowFailure: true });
}

async function readSafeHeartbeat(ctx, options) {
  try { return await (options.readHeartbeat || readHeartbeat)(ctx.layout); }
  catch { return null; }
}

async function runtimeServiceState(ctx, options) {
  let lock;
  try { lock = await (options.readRuntimeLock || readRuntimeLock)(ctx.layout); }
  catch { return "unknown"; }
  const heartbeat = await readSafeHeartbeat(ctx, options);
  if (!lock) return heartbeat && heartbeat.state === "RECOVERY_REQUIRED" ? "recovery_required" : "stopped";
  if (!heartbeat || heartbeat.instanceId !== lock.instanceId) return "unknown";
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const staleMs = options.heartbeatStaleMs === undefined ? 120_000 : options.heartbeatStaleMs;
  if (!Number.isSafeInteger(heartbeat.observedAt) || now - heartbeat.observedAt > staleMs) return "unknown";
  if (heartbeat.state === "RECOVERY_REQUIRED") return "recovery_required";
  if (heartbeat.state === "STARTING") return "starting";
  if (heartbeat.state === "STOPPING") return "stopping";
  if (heartbeat.state === "RUNNING" || heartbeat.state === "DEGRADED") return "running";
  return "unknown";
}

async function waitForNoRuntimeLock(ctx, options, timeoutMs) {
  const intervalMs = options.shutdownPollMs === undefined ? 50 : options.shutdownPollMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw codedError("service_wait_options_invalid");
  }
  const attempts = Math.ceil(timeoutMs / intervalMs);
  const delay = options.delay || function (milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  };
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    let lock;
    try { lock = await (options.readRuntimeLock || readRuntimeLock)(ctx.layout); }
    catch { return false; }
    if (!lock) return true;
    if (attempt < attempts) await delay(intervalMs);
  }
  return false;
}

async function requestRuntimeShutdown(ctx, options) {
  try {
    await (options.sendControlCommand || sendControlCommand)(ctx.layout, "shutdown", {}, {
      timeoutMs: options.controlTimeoutMs === undefined ? 5000 : options.controlTimeoutMs
    });
  } catch {}
  return await waitForNoRuntimeLock(ctx, options, options.shutdownWaitMs === undefined ? 15_000 : options.shutdownWaitMs);
}

async function stopManager(ctx, options, runtimeStopped) {
  if (ctx.manager === "systemd-user") {
    await command(ctx.paths, "systemctl", ["--user", "stop", ctx.paths.managerTarget], options);
    return;
  }
  if (ctx.manager === "launchd-user") {
    const domain = "gui/" + String(options.uid === undefined ? process.getuid() : options.uid);
    const loaded = await managerProbe(ctx, options);
    if (loaded.code === 0) await command(ctx.paths, "launchctl", ["bootout", domain + "/" + ctx.paths.managerTarget], options);
    return;
  }
  if (!runtimeStopped) await command(ctx.paths, "schtasks.exe", ["/End", "/TN", ctx.paths.managerTarget], options);
}

export async function installService(options = {}) {
  await (options.runPreflight || runPreflight)({
    ...(options.preflightOptions || {}),
    env: options.env,
    executable: options.codexExecutable
  });
  const ctx = context(options);
  await readyForInstall(options, ctx);
  const runtime = {
    nodeExecutable: ctx.paths.nodeExecutable,
    cliEntry: ctx.paths.cliEntry,
    packageRoot: ctx.paths.packageRoot,
    codexRoot: ctx.paths.codexRoot,
    userIdentity: options.userIdentity,
    pathEnvironment: ctx.environment.PATH || ctx.environment.Path || null
  };
  await writeDescriptor(ctx.paths, buildServiceDescriptor(ctx.manager, runtime));
  if (ctx.manager === "systemd-user") {
    await command(ctx.paths, "systemctl", ["--user", "daemon-reload"], options);
    await command(ctx.paths, "systemctl", ["--user", "enable", "--now", ctx.paths.managerTarget], options);
  } else if (ctx.manager === "launchd-user") {
    const domain = "gui/" + String(options.uid === undefined ? process.getuid() : options.uid);
    const loaded = await managerProbe(ctx, options);
    if (loaded.code === 0) await command(ctx.paths, "launchctl", ["bootout", domain + "/" + ctx.paths.managerTarget], options);
    await command(ctx.paths, "launchctl", ["bootstrap", domain, ctx.paths.descriptorFile], options);
  } else {
    await command(ctx.paths, "schtasks.exe", ["/Create", "/TN", ctx.paths.managerTarget, "/XML", ctx.paths.descriptorFile, "/F"], options);
    await command(ctx.paths, "schtasks.exe", ["/Run", "/TN", ctx.paths.managerTarget], options);
  }
  return { status: "installed", manager: ctx.manager };
}

export async function startService(options = {}) {
  const ctx = context(options);
  if (!await descriptorExists(ctx.paths)) throw codedError("service_not_installed");
  if (ctx.manager === "systemd-user") {
    await command(ctx.paths, "systemctl", ["--user", "start", ctx.paths.managerTarget], options);
  } else if (ctx.manager === "launchd-user") {
    const domain = "gui/" + String(options.uid === undefined ? process.getuid() : options.uid);
    const loaded = await managerProbe(ctx, options);
    if (loaded.code === 0) await command(ctx.paths, "launchctl", ["kickstart", "-k", domain + "/" + ctx.paths.managerTarget], options);
    else await command(ctx.paths, "launchctl", ["bootstrap", domain, ctx.paths.descriptorFile], options);
  } else {
    await command(ctx.paths, "schtasks.exe", ["/Run", "/TN", ctx.paths.managerTarget], options);
  }
  return { status: "started", manager: ctx.manager };
}

export async function stopService(options = {}) {
  const ctx = context(options);
  if (!await descriptorExists(ctx.paths)) return { status: "not_installed", manager: ctx.manager };
  const runtimeStopped = await requestRuntimeShutdown(ctx, options);
  await stopManager(ctx, options, runtimeStopped);
  const stopped = runtimeStopped || await waitForNoRuntimeLock(
    ctx,
    options,
    options.managerStopWaitMs === undefined ? 5_000 : options.managerStopWaitMs
  );
  if (!stopped) throw codedError("service_stop_recovery_required");
  const heartbeat = await readSafeHeartbeat(ctx, options);
  if (heartbeat && heartbeat.state === "RECOVERY_REQUIRED") throw codedError("service_stop_recovery_required");
  return { status: "stopped", manager: ctx.manager };
}

export async function restartService(options = {}) {
  const stopped = await stopService(options);
  if (stopped.status === "not_installed") throw codedError("service_not_installed");
  const started = await startService(options);
  return { status: "restarted", manager: started.manager };
}

export async function serviceStatus(options = {}) {
  const ctx = context(options);
  const installed = await descriptorExists(ctx.paths);
  let serviceState = "not_installed";
  if (installed) {
    const observed = await managerProbe(ctx, options);
    serviceState = observed.code === 0 ? await runtimeServiceState(ctx, options) : "unknown";
  }
  const inspect = options.inspectReadiness || inspectReadiness;
  const readiness = await inspect({ codexRoot: ctx.codexRoot, env: ctx.environment, home: options.home });
  return {
    status: "ok",
    manager: ctx.manager,
    serviceState,
    readiness
  };
}

export async function uninstallService(options = {}) {
  const ctx = context(options);
  if (!await descriptorExists(ctx.paths)) {
    return { status: "uninstalled", manager: ctx.manager, privateStatePreserved: true };
  }
  await stopService(options);
  if (ctx.manager === "systemd-user") {
    await command(ctx.paths, "systemctl", ["--user", "disable", ctx.paths.managerTarget], options);
    await removeDescriptor(ctx.paths);
    await command(ctx.paths, "systemctl", ["--user", "daemon-reload"], options);
  } else if (ctx.manager === "launchd-user") {
    await removeDescriptor(ctx.paths);
  } else {
    await command(ctx.paths, "schtasks.exe", ["/Delete", "/TN", ctx.paths.managerTarget, "/F"], options);
    await removeDescriptor(ctx.paths);
  }
  return { status: "uninstalled", manager: ctx.manager, privateStatePreserved: true };
}
