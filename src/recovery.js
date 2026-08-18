import { readConfig } from "./config.js";
import { buildLayout, resolveCodexRoot } from "./paths.js";
import { storageReadiness } from "./readiness.js";
import { acquireRuntimeLock, readHeartbeat, releaseRuntimeLock, writeHeartbeat } from "./runtime-lock.js";
import { openStorage } from "./storage.js";

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function recoverRuntime(options = {}) {
  const environment = options.env || process.env;
  const codexRoot = resolveCodexRoot({ explicitRoot: options.codexRoot, env: environment, home: options.home });
  const layout = buildLayout(codexRoot);
  const initial = await readHeartbeat(layout);
  if (!initial || initial.state !== "RECOVERY_REQUIRED") {
    return { status: "not_required", recovery: "runtime", restartRequired: false };
  }

  let ownership = null;
  let storage = null;
  let cleared = false;
  let generation = initial.generation;
  try {
    ownership = await acquireRuntimeLock(layout, options.lockOptions || {});
    const heartbeat = await readHeartbeat(layout);
    if (!heartbeat || heartbeat.state !== "RECOVERY_REQUIRED") throw codedError("recovery_state_changed");
    generation = heartbeat.generation;
    await readConfig(layout.configFile);
    storage = openStorage(layout.databaseFile, { create: false });
    const integrity = storage.integrityCheck();
    if (!integrity.ok) throw codedError("storage_integrity_failed");
    const readiness = storageReadiness(storage);
    if (readiness.recoveryRequired) throw codedError("recovery_scope_incomplete");

    const stopped = await writeHeartbeat(layout, ownership, "STOPPED", generation + 1, options.now === undefined ? Date.now() : options.now);
    cleared = true;
    const verified = await readHeartbeat(layout);
    if (!verified || verified.instanceId !== ownership.instanceId || verified.state !== "STOPPED" || verified.generation !== stopped.generation) {
      throw codedError("recovery_heartbeat_verification_failed");
    }
    storage.close();
    storage = null;
    const released = await releaseRuntimeLock(layout, ownership);
    ownership = null;
    if (!released) throw codedError("recovery_lock_release_failed");
    return {
      status: "recovered",
      recovery: "runtime",
      restartRequired: true,
      readiness
    };
  } catch (error) {
    if (storage) {
      try { storage.close(); } catch {}
      storage = null;
    }
    if (ownership) {
      if (cleared) {
        try { await writeHeartbeat(layout, ownership, "RECOVERY_REQUIRED", generation + 2, Date.now()); } catch {}
      }
      try { await releaseRuntimeLock(layout, ownership); } catch {}
    }
    throw error;
  }
}
