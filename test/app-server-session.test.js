import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../src/app-server.js";
import { openStorage } from "../src/storage.js";
import { createSession, createSessionAdapter, listSessions, selectSession, sessionStatus, testSessionRoute } from "../src/session-route.js";

const TEST_LAUNCH_PLAN = Object.freeze({
  command: "fixture-node",
  argsPrefix: Object.freeze(["fixture-codex.js"]),
  provenance: "packaged",
  source: "fixture-package",
  version: "0.147.0"
});

function fakeSpawn(handler, calls) {
  return function (executable, args, options) {
    assert.equal(executable, "fixture-node");
    assert.deepEqual(args, ["fixture-codex.js", "app-server", "--stdio"]);
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = function () { child.killed = true; queueMicrotask(function () { child.emit("close", 0); }); };
    let buffer = "";
    child.stdin.on("data", function (chunk) {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        calls.push(request);
        handler(request, child);
      }
    });
    return child;
  };
}

function response(child, id, result) {
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

test("app-server transport initializes and correlates bounded JSON-RPC", async function () {
  const calls = [];
  const client = new CodexAppServerClient({
    launchPlan: TEST_LAUNCH_PLAN,
    spawn: fakeSpawn(function (request, child) {
      if (request.method === "initialize") response(child, request.id, { userAgent: "test" });
      if (request.method === "thread/list") response(child, request.id, { data: [], nextCursor: null });
    }, calls),
    requestTimeoutMs: 1000
  });
  const result = await client.request("thread/list", { limit: 100 });
  assert.deepEqual(result, { data: [], nextCursor: null });
  assert.equal(calls[0].method, "initialize");
  assert.equal(calls[0].params.capabilities.experimentalApi, true);
  assert.equal(calls[1].method, "initialized");
  assert.equal(calls[2].method, "thread/list");
  await client.close();
});

test("session listing is paginated and duplicate visible names are refused", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  const client = {
    async request(method, params) {
      assert.equal(method, "thread/list");
      if (!params.cursor) return { data: [{ id: "one", name: "Alerts", status: "idle" }], nextCursor: "next" };
      return { data: [{ id: "two", name: "Alerts", status: "idle" }], nextCursor: null };
    }
  };
  try {
    assert.equal((await listSessions(client)).length, 2);
    await assert.rejects(selectSession(storage, client, "Alerts", 2), /session_name_ambiguous/);
    assert.equal(sessionStatus(storage), null);
  } finally {
    storage.close();
  }
});

test("dedicated session creation names and privately binds the exact thread", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "private-thread", name: null, status: "idle" } };
      if (method === "thread/name/set") return {};
      if (method === "thread/list") return { data: [{ id: "private-thread", name: "Gorombo Skill Harvester", status: "idle" }], nextCursor: null };
      throw new Error("unexpected");
    }
  };
  try {
    const selected = await createSession(storage, client, "Gorombo Skill Harvester", process.cwd(), 2);
    assert.equal(selected.displayName, "Gorombo Skill Harvester");
    assert.deepEqual(calls.map(function (item) { return item.method; }), ["thread/start", "thread/name/set", "thread/list"]);
    assert.equal(calls.some(function (item) { return item.method === "thread/resume" || item.method === "turn/steer" || item.method === "update_goal"; }), false);
    const privateRow = storage.db.prepare("SELECT internal_thread_id FROM session_routes").get();
    assert.equal(privateRow.internal_thread_id, "private-thread");
    assert.equal(JSON.stringify(sessionStatus(storage)).includes("private-thread"), false);
  } finally {
    storage.close();
  }
});

test("dedicated session creation preserves an existing selection when naming fails", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  const existingId = "ses_" + "1".repeat(32);
  const beforeRows = [{
    id: existingId,
    display_name: "Existing Alerts",
    internal_thread_id: "existing-thread",
    state: "READY",
    revision: 1,
    selected_at: 1,
    last_verified_at: 1
  }];
  const calls = [];
  try {
    storage.db.prepare(
      "INSERT INTO session_routes(id,display_name,internal_thread_id,state,revision,selected_at,last_verified_at) VALUES(?,?,?,'READY',?,?,?)"
    ).run(existingId, "Existing Alerts", "existing-thread", 1, 1, 1);
    storage.upsertRoute("session", true, "READY", { displayName: "Existing Alerts" }, 1);
    const beforeRoute = storage.getRoute("session");
    const client = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "new-thread", name: null, status: "idle" } };
        if (method === "thread/name/set") throw new Error("thread_name_set_failed");
        throw new Error("unexpected");
      }
    };

    await assert.rejects(
      createSession(storage, client, "Gorombo Skill Harvester", process.cwd(), 2),
      /thread_name_set_failed/
    );
    assert.deepEqual(calls.map(function (item) { return item.method; }), ["thread/start", "thread/name/set"]);
    assert.deepEqual(
      storage.db.prepare(
        "SELECT id,display_name,internal_thread_id,state,revision,selected_at,last_verified_at FROM session_routes ORDER BY revision"
      ).all().map(function (row) { return { ...row }; }),
      beforeRows
    );
    assert.deepEqual(storage.getRoute("session"), beforeRoute);
  } finally {
    storage.close();
  }
});

test("dedicated session creation writes no local selection when name verification fails", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "private-thread", name: null, status: "idle" } };
      if (method === "thread/name/set") return {};
      if (method === "thread/list") return { data: [], nextCursor: null };
      throw new Error("unexpected");
    }
  };
  try {
    await assert.rejects(
      createSession(storage, client, "Gorombo Skill Harvester", process.cwd(), 2),
      /session_name_verification_failed/
    );
    assert.deepEqual(calls.map(function (item) { return item.method; }), ["thread/start", "thread/name/set", "thread/list"]);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM session_routes").get().count, 0);
    assert.equal(storage.getRoute("session"), null);
  } finally {
    storage.close();
  }
});

test("session test requires matching completion before READY", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/list") return { data: [{ id: "private-thread", name: "Gorombo Skill Harvester", status: "idle" }], nextCursor: null };
      if (method === "turn/start") return { turn: { id: "turn-one", status: "inProgress" } };
      throw new Error("unexpected");
    },
    async waitForNotification(predicate) {
      const notification = { method: "turn/completed", params: { threadId: "private-thread", turn: { id: "turn-one", status: "completed" } } };
      assert.equal(predicate(notification), true);
      return notification;
    }
  };
  try {
    storage.db.prepare("INSERT INTO onboarding_runs(id,state,requested_route_mode,plan_json,safe_reason_code,started_at) VALUES(?,?,?,?,?,?)")
      .run("onb_" + "d".repeat(32), "WAITING_FOR_ROUTE_CONFIGURATION", "session", "{}", null, 1);
    await selectSession(storage, client, "Gorombo Skill Harvester", 2);
    const digest = "a".repeat(64);
    const result = await testSessionRoute(storage, client, "Gorombo Skill Harvester\n\nRetain this recommendation for review.", digest, { now: function () { return 3; } });
    assert.equal(result.category, "accepted");
    assert.equal(sessionStatus(storage).state, "READY");
    assert.equal(storage.db.prepare("SELECT state FROM onboarding_runs").get().state, "COMPLETED");
    const sent = calls.find(function (item) { return item.method === "turn/start"; });
    assert.match(sent.params.input[0].text, /^Gorombo Skill Harvester/);
    assert.equal(sent.params.input[0].text.includes("private-thread"), false);
    assert.equal(calls.some(function (item) { return ["thread/resume", "turn/steer", "update_goal"].includes(item.method); }), false);
  } finally {
    storage.close();
  }
});

test("renamed and missing bindings never redirect", async function () {
  const storage = openStorage(":memory:", { create: true, now: 1 });
  let threads = [{ id: "private-thread", name: "Gorombo Skill Harvester", status: "idle" }];
  const client = {
    async request(method) {
      if (method === "thread/list") return { data: threads, nextCursor: null };
      throw new Error("turn must not start");
    }
  };
  try {
    await selectSession(storage, client, "Gorombo Skill Harvester", 2);
    storage.db.prepare("UPDATE session_routes SET state='READY'").run();
    threads = [{ id: "private-thread", name: "Renamed", status: "idle" }, { id: "other", name: "Gorombo Skill Harvester", status: "idle" }];
    const adapter = createSessionAdapter({ storage, client, now: function () { return 3; } });
    const renamed = await adapter.send({ plainText: "Gorombo Skill Harvester", renderedDigest: "a".repeat(64) });
    assert.deepEqual(renamed, { category: "routeBlocked", safeError: { code: "session_reselection_required" } });
    assert.equal(sessionStatus(storage).state, "RESELECTION_REQUIRED");
    threads = [];
    const missing = await adapter.send({ plainText: "Gorombo Skill Harvester", renderedDigest: "a".repeat(64) });
    assert.equal(missing.safeError.code, "session_missing");
  } finally {
    storage.close();
  }
});
