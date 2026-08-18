import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { publicCodexProbeReport, resolveVerifiedCodexLaunchPlan, runBoundedCodexProbe } from "./codex-launcher.js";

const MINIMUM_NODE = [22, 13, 0];

export function nodeVersionSupported(value = process.versions.node) {
  const parts = String(value || "").split(".").map(function (part) { return Number(part); });
  if (parts.length < 3 || parts.some(function (part) { return !Number.isInteger(part) || part < 0; })) return false;
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    if (parts[index] > MINIMUM_NODE[index]) return true;
    if (parts[index] < MINIMUM_NODE[index]) return false;
  }
  return true;
}

export async function preparePreflight(options = {}) {
  if (!nodeVersionSupported()) throw new Error("node_version_unsupported");
  if (typeof globalThis.fetch !== "function" || typeof AbortController !== "function") throw new Error("web_runtime_unavailable");
  if (typeof fs.lstatSync !== "function") throw new Error("node_runtime_unavailable");
  if (randomBytes(16).length !== 16 || createHash("sha256").update("gorombo-skill-harvester").digest("hex").length !== 64) throw new Error("crypto_unavailable");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON;PRAGMA synchronous=FULL;CREATE TABLE preflight(value INTEGER NOT NULL);");
    db.prepare("INSERT INTO preflight(value) VALUES(?)").run(1);
    const row = db.prepare("SELECT value FROM preflight").get();
    if (!row || Number(row.value) !== 1) throw new Error("sqlite_unavailable");
  } finally {
    db.close();
  }

  const verified = options.launchPlan
    ? { plan: options.launchPlan, diagnostics: [] }
    : await resolveVerifiedCodexLaunchPlan(options);
  const probe = options.probe || runBoundedCodexProbe;
  const probeOptions = {
    spawn: options.spawn,
    env: options.env,
    platform: options.platform,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    outputLimitBytes: options.outputLimitBytes,
    terminateChild: options.terminateChild
  };
  const login = await probe(verified.plan, ["login", "status"], probeOptions);
  if (!login || login.exitCode !== 0) throw new Error("codex_login_status_failed");
  const appServer = await probe(verified.plan, ["app-server", "--help"], probeOptions);
  if (!appServer || appServer.exitCode !== 0) throw new Error("codex_app_server_unavailable");

  return {
    report: {
      ok: true,
      nodeVersion: process.versions.node,
      sqlite: "available",
      crypto: "available",
      fetch: "available",
      childProcess: "available",
      filesystem: "available",
      codex: publicCodexProbeReport(verified)
    },
    launchPlan: verified.plan
  };
}

export async function runPreflight(options = {}) {
  return (await preparePreflight(options)).report;
}
