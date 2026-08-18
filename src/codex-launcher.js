import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MINIMUM_CODEX_VERSION = Object.freeze([0, 147, 0]);

const MAX_PATH_ENTRIES = 128;
const MAX_CANDIDATES = 256;
const MAX_MANAGER_DIRECTORY_ENTRIES = 256;
const MAX_MANAGER_VERSIONS = 64;
const MAX_MANAGER_ENTRIES = MAX_MANAGER_VERSIONS + 8;
const MAX_PROBE_BYTES = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const SAFE_SOURCE = /^[a-z][a-z0-9_-]{0,31}$/u;
const PROBE_ENV_NAMES = new Set([
  "ALL_PROXY", "APPDATA", "CODEX_API_KEY", "CODEX_HOME", "COMSPEC", "HOME",
  "HOMEDRIVE", "HOMEPATH", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LANGUAGE",
  "LC_ALL", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS", "NO_COLOR", "NO_PROXY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_ORG_ID",
  "OPENAI_PROJECT", "OPENAI_PROJECT_ID", "PATH", "PATHEXT", "SSL_CERT_DIR",
  "SSL_CERT_FILE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR",
  "USERPROFILE", "WINDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"
]);

function codedError(code, diagnostics = []) {
  const error = new Error(code);
  error.code = code;
  error.diagnostics = diagnostics.map(function (item) {
    return {
      source: SAFE_SOURCE.test(String(item.source || "")) ? item.source : "candidate",
      code: /^[a-z][a-z0-9_]{0,63}$/u.test(String(item.code || "")) ? item.code : "codex_probe_failed"
    };
  }).slice(0, MAX_CANDIDATES);
  return error;
}

function versionText(parts) {
  return parts.join(".");
}

export function compareCodexVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

export function parseStableCodexVersion(value) {
  const text = String(value || "").trim();
  const stable = /^(?:codex-cli|codex)\s+(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (!stable) {
    if (/^(?:codex-cli|codex)\s+\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/u.test(text)) throw codedError("codex_version_unstable");
    throw codedError("codex_version_invalid");
  }
  const parts = stable.slice(1).map(Number);
  if (parts.some(function (part) { return !Number.isSafeInteger(part) || part < 0 || part > 999999; })) throw codedError("codex_version_invalid");
  return Object.freeze(parts);
}

function safeRealFile(candidate, fsImpl) {
  try {
    const real = fsImpl.realpathSync(candidate);
    const info = fsImpl.lstatSync(real);
    return info.isFile() ? { real, info } : null;
  } catch {
    return null;
  }
}

function boundedManagerVersions(directory, fsImpl) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) return [];
  let entries;
  try { entries = fsImpl.readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  if (!Array.isArray(entries) || entries.length > MAX_MANAGER_DIRECTORY_ENTRIES) return [];
  const versions = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || !/^v\d+\.\d+\.\d+$/u.test(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    let info;
    try { info = fsImpl.lstatSync(absolute); }
    catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    versions.push(absolute);
    if (versions.length > MAX_MANAGER_VERSIONS) return [];
  }
  return versions.sort(function (left, right) { return left.localeCompare(right, "en"); });
}

function packagedCandidate(scriptPath, source, options) {
  const fsImpl = options.fs || fs;
  const found = safeRealFile(scriptPath, fsImpl);
  if (!found) return null;
  const packageRoot = path.resolve(path.dirname(found.real), "..");
  const relative = path.relative(packageRoot, found.real);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).join("/") !== "bin/codex.js") return null;
  const metadataPath = path.join(packageRoot, "package.json");
  try {
    const metadataFile = safeRealFile(metadataPath, fsImpl);
    if (metadataFile) {
      const metadata = JSON.parse(fsImpl.readFileSync(metadataFile.real, "utf8"));
      if (metadata.name !== "@openai/codex") return null;
    }
  } catch {
    return null;
  }
  return {
    command: options.processExecPath || process.execPath,
    argsPrefix: [found.real],
    provenance: "packaged",
    source
  };
}

function nativeCandidate(executablePath, source, options) {
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const found = safeRealFile(executablePath, fsImpl);
  if (!found) return null;
  if (platform !== "win32" && (found.info.mode & 0o111) === 0) return null;
  if (found.real.toLowerCase().endsWith(".js")) return packagedCandidate(found.real, source, options);
  if (platform === "win32" && !/\.(?:exe|com)$/iu.test(found.real)) return null;
  return { command: found.real, argsPrefix: [], provenance: "native", source };
}

function candidateKey(candidate, platform) {
  const fold = platform === "win32" ? function (value) { return value.toLowerCase(); } : function (value) { return value; };
  return fold(candidate.command) + "\u0000" + candidate.argsPrefix.map(fold).join("\u0000");
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || typeof candidate.command !== "string" || candidate.command.length === 0 ||
      !Array.isArray(candidate.argsPrefix) || candidate.argsPrefix.length > 4 ||
      candidate.argsPrefix.some(function (item) { return typeof item !== "string" || item.length === 0 || Buffer.byteLength(item, "utf8") > 4096; }) ||
      !["packaged", "native"].includes(candidate.provenance)) {
    throw codedError("codex_launcher_invalid");
  }
  return {
    command: candidate.command,
    argsPrefix: [...candidate.argsPrefix],
    provenance: candidate.provenance,
    source: SAFE_SOURCE.test(String(candidate.source || "")) ? candidate.source : "candidate"
  };
}

export function discoverCodexCandidates(options = {}) {
  const environment = options.env || process.env;
  const platform = options.platform || process.platform;
  const delimiter = platform === "win32" ? ";" : ":";
  const executable = options.executable;
  const entryValues = new Map();
  const entrySources = new Map();
  const pathEntryKeys = new Set();
  const managerEntryKeys = new Set();
  const entryKey = function (value) { return platform === "win32" ? value.toLowerCase() : value; };
  const addEntry = function (value, source = "path-package") {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096 || !path.isAbsolute(value)) return null;
    const resolved = path.resolve(value);
    const key = entryKey(resolved);
    const keys = source === "path-package" ? pathEntryKeys : managerEntryKeys;
    const limit = source === "path-package" ? MAX_PATH_ENTRIES : MAX_MANAGER_ENTRIES;
    if (!keys.has(key) && keys.size >= limit) return null;
    keys.add(key);
    if (!entryValues.has(key)) entryValues.set(key, resolved);
    if (!entrySources.has(key) || source !== "path-package") entrySources.set(key, source);
    return resolved;
  };
  const rawPath = typeof environment.PATH === "string" ? environment.PATH : typeof environment.Path === "string" ? environment.Path : "";
  for (const item of rawPath.split(delimiter)) if (item) addEntry(item);
  addEntry(environment.NVM_BIN, "nvm-package");
  addEntry(environment.NVM_SYMLINK, "nvm-package");
  addEntry(environment.FNM_MULTISHELL, "fnm-package");
  if (typeof environment.VOLTA_HOME === "string") addEntry(path.join(environment.VOLTA_HOME, "bin"), "volta-package");
  addEntry(path.dirname(options.processExecPath || process.execPath), "process-package");

  const fsImpl = options.fs || fs;
  const nvmRoots = [];
  const addNvmRoot = function (value) {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096 || !path.isAbsolute(value)) return;
    const resolved = path.resolve(value);
    if (!nvmRoots.some(function (item) { return entryKey(item) === entryKey(resolved); })) nvmRoots.push(resolved);
  };
  if (platform === "win32") addNvmRoot(environment.NVM_HOME);
  else {
    addNvmRoot(environment.NVM_DIR);
    const home = typeof environment.HOME === "string" ? environment.HOME : environment.USERPROFILE;
    if (typeof home === "string" && path.isAbsolute(home)) addNvmRoot(path.join(home, ".nvm"));
  }
  for (const root of nvmRoots) {
    const versionsDirectory = platform === "win32" ? root : path.join(root, "versions", "node");
    for (const versionDirectory of boundedManagerVersions(versionsDirectory, fsImpl)) {
      addEntry(platform === "win32" ? versionDirectory : path.join(versionDirectory, "bin"), "nvm-package");
    }
  }

  const entries = [
    ...[...managerEntryKeys].map(function (key) { return entryValues.get(key); }),
    ...[...pathEntryKeys].filter(function (key) { return !managerEntryKeys.has(key); }).map(function (key) { return entryValues.get(key); })
  ];
  const candidates = [];
  const seen = new Set();
  const addCandidate = function (candidate) {
    if (!candidate || candidates.length >= MAX_CANDIDATES) return;
    const normalized = validateCandidate(candidate);
    const key = candidateKey(normalized, platform);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };

  if (typeof executable === "string" && executable !== "" && executable !== "codex") {
    if (!path.isAbsolute(executable)) throw codedError("codex_executable_invalid");
    const extension = path.extname(executable).toLowerCase();
    if (extension === ".js") addCandidate(packagedCandidate(executable, "explicit-package", options));
    else if ([".cmd", ".bat", ".ps1"].includes(extension)) {
      addCandidate(packagedCandidate(path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js"), "explicit-package", options));
    } else addCandidate(nativeCandidate(executable, "explicit-native", options));
    if (candidates.length === 0) throw codedError([".cmd", ".bat", ".ps1"].includes(extension) ? "codex_launcher_unsupported" : "codex_not_found");
    return candidates;
  }
  if (executable !== undefined && executable !== null && executable !== "codex") throw codedError("codex_executable_invalid");

  for (const entry of entries) {
    const scripts = [
      path.join(entry, "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.resolve(entry, "..", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
      path.resolve(entry, "..", "node_modules", "@openai", "codex", "bin", "codex.js")
    ];
    const source = entrySources.get(entryKey(entry)) || "path-package";
    for (const script of scripts) addCandidate(packagedCandidate(script, source, options));
  }
  for (const entry of entries) {
    if (platform === "win32") {
      addCandidate(nativeCandidate(path.join(entry, "codex.exe"), "path-native", options));
      addCandidate(nativeCandidate(path.join(entry, "codex.com"), "path-native", options));
    } else addCandidate(nativeCandidate(path.join(entry, "codex"), "path-native", options));
  }
  return candidates;
}

function safeProbeEnvironment(source) {
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    const normalized = key.toUpperCase();
    if ((PROBE_ENV_NAMES.has(normalized) || /^(?:OPENAI|CODEX)_[A-Z0-9_]+$/u.test(normalized)) && typeof value === "string") result[key] = value;
  }
  delete result.TELEGRAM_BOT_TOKEN;
  delete result.TELEGRAM_ALLOWED_USER_IDS;
  return result;
}

function launchErrorCode(error) {
  if (error && error.code === "ENOENT") return "codex_not_found";
  if (error && (error.code === "EACCES" || error.code === "EPERM")) return "codex_not_executable";
  return "codex_launch_failed";
}

export function buildCodexInvocation(plan, args) {
  const normalized = validateCandidate(plan);
  if (!Array.isArray(args) || args.length < 1 || args.length > 64 ||
      args.some(function (item) { return typeof item !== "string" || Buffer.byteLength(item, "utf8") > 16_384; })) {
    throw codedError("codex_arguments_invalid");
  }
  return { command: normalized.command, args: [...normalized.argsPrefix, ...args] };
}

export function terminateOwnedChild(child, force) {
  if (!child) return Promise.resolve(false);
  if (process.platform === "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    return new Promise(function (resolve) {
      let killer;
      try {
        const args = ["/PID", String(child.pid), "/T"];
        if (force) args.push("/F");
        killer = spawn("taskkill", args, { windowsHide: true, shell: false, stdio: "ignore" });
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = function (value) {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      killer.once("error", function () { finish(false); });
      killer.once("close", function (code) { finish(code === 0); });
    });
  }
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return Promise.resolve(force);
    } catch {}
  }
  try { return Promise.resolve(force && child.kill(force ? "SIGKILL" : "SIGTERM") !== false); }
  catch { return Promise.resolve(false); }
}

export async function runBoundedCodexProbe(plan, args, options = {}) {
  const invocation = buildCodexInvocation(plan, args);
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_PROBE_TIMEOUT_MS : options.timeoutMs;
  const outputLimitBytes = options.outputLimitBytes === undefined ? MAX_PROBE_BYTES : options.outputLimitBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1024 || outputLimitBytes > 1024 * 1024) {
    throw codedError("codex_probe_options_invalid");
  }
  const terminate = options.terminateChild || terminateOwnedChild;
  return await new Promise(function (resolve, reject) {
    let child;
    let settled = false;
    let timer = null;
    let bytes = 0;
    const stdout = [];
    const finish = function (error, value) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const stopAndReject = function (code) {
      if (settled) return;
      void Promise.resolve().then(function () { return terminate(child, true); }).catch(function () {});
      finish(codedError(code));
    };
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd: options.cwd || process.cwd(),
        env: safeProbeEnvironment(options.env || process.env),
        shell: false,
        windowsHide: true,
        detached: (options.platform || process.platform) !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      throw codedError(launchErrorCode(error));
    }
    if (!child || !child.stdout || !child.stderr || typeof child.once !== "function") throw codedError("codex_launch_failed");
    timer = setTimeout(function () { stopAndReject("codex_probe_timeout"); }, timeoutMs);
    const consume = function (capture, chunk) {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > outputLimitBytes) {
        stopAndReject("codex_probe_output_limit");
        return;
      }
      if (capture) stdout.push(buffer);
    };
    child.stdout.on("data", function (chunk) { consume(options.captureStdout === true, chunk); });
    child.stderr.on("data", function (chunk) { consume(false, chunk); });
    child.once("error", function (error) { finish(codedError(launchErrorCode(error))); });
    child.once("close", function (code) {
      finish(null, {
        exitCode: Number.isInteger(code) ? code : null,
        stdout: options.captureStdout === true ? Buffer.concat(stdout).toString("utf8") : ""
      });
    });
  });
}

function chooseHighest(values) {
  return values.sort(function (left, right) { return compareCodexVersions(right.parts, left.parts); })[0];
}

export async function resolveVerifiedCodexLaunchPlan(options = {}) {
  const candidates = Array.isArray(options.candidates)
    ? options.candidates.map(validateCandidate)
    : discoverCodexCandidates(options);
  const diagnostics = [];
  const probe = options.probe || runBoundedCodexProbe;
  const probeOptions = {
    spawn: options.spawn,
    env: options.env,
    platform: options.platform,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    outputLimitBytes: options.outputLimitBytes,
    terminateChild: options.terminateChild,
    captureStdout: true
  };
  const evaluate = async function (items) {
    const compatible = [];
    for (const candidate of items) {
      let result;
      try { result = await probe(candidate, ["--version"], probeOptions); }
      catch (error) {
        diagnostics.push({ source: candidate.source, code: /^[a-z][a-z0-9_]{0,63}$/u.test(String(error && (error.code || error.message) || "")) ? String(error.code || error.message) : "codex_probe_failed" });
        continue;
      }
      if (!result || result.exitCode !== 0) {
        diagnostics.push({ source: candidate.source, code: "codex_version_command_failed" });
        continue;
      }
      let parts;
      try { parts = parseStableCodexVersion(result.stdout); }
      catch (error) {
        diagnostics.push({ source: candidate.source, code: error.code || "codex_version_invalid" });
        continue;
      }
      if (compareCodexVersions(parts, MINIMUM_CODEX_VERSION) < 0) {
        diagnostics.push({ source: candidate.source, code: "codex_version_unsupported" });
        continue;
      }
      compatible.push({ candidate, parts });
    }
    return compatible;
  };

  const packaged = candidates.filter(function (candidate) { return candidate.provenance === "packaged"; });
  const native = candidates.filter(function (candidate) { return candidate.provenance === "native"; });
  let compatible = await evaluate(packaged);
  if (compatible.length === 0) compatible = await evaluate(native);
  if (compatible.length > 0) {
    const selected = chooseHighest(compatible);
    return {
      plan: Object.freeze({
        command: selected.candidate.command,
        argsPrefix: Object.freeze([...selected.candidate.argsPrefix]),
        provenance: selected.candidate.provenance,
        source: selected.candidate.source,
        version: versionText(selected.parts)
      }),
      diagnostics: diagnostics.map(function (item) { return { ...item }; })
    };
  }

  if (candidates.length === 0) throw codedError("codex_not_found", diagnostics);
  const codes = new Set(diagnostics.map(function (item) { return item.code; }));
  for (const code of [
    "codex_version_unsupported", "codex_version_unstable", "codex_version_invalid",
    "codex_not_executable", "codex_probe_timeout", "codex_probe_output_limit", "codex_not_found"
  ]) {
    if (codes.has(code)) throw codedError(code, diagnostics);
  }
  throw codedError("codex_launch_failed", diagnostics);
}

export function publicCodexProbeReport(verified) {
  const plan = verified && verified.plan;
  if (!plan || typeof plan.version !== "string") throw codedError("codex_launcher_invalid");
  return {
    available: true,
    version: plan.version,
    minimumVersion: versionText(MINIMUM_CODEX_VERSION),
    authentication: "available",
    appServer: "available"
  };
}
