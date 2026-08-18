import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLayout, ensureOwnedDirectory, resolveCodexRoot, resolveStoredRelative, validateStoredRelative } from "../src/paths.js";

test("layout is derived from the runtime Codex root", function () {
  const root = path.resolve(process.cwd());
  const layout = buildLayout(root);
  assert.equal(layout.environmentFile, path.join(root, ".gorombo", ".env"));
  assert.equal(layout.databaseFile, path.join(root, ".gorombo", "gorombo-skill-harvester", "state.sqlite3"));
  assert.equal(layout.completionSpoolDir, path.join(root, ".gorombo", "gorombo-skill-harvester", "completion-spool"));
});

test("root resolution accepts a discovered absolute existing directory", function () {
  assert.equal(resolveCodexRoot({ explicitRoot: os.tmpdir() }), path.resolve(os.tmpdir()));
});

test("stored paths are relative and contained", function () {
  assert.equal(validateStoredRelative("recommendations/rec_abc.md"), "recommendations/rec_abc.md");
  const invalid = [
    "../outside",
    "a/../b",
    "/outside",
    "C:/outside",
    "//server/share",
    "a\\b",
    "a//b",
    ".",
    "a/\0/b",
    Array(18).fill("a").join("/")
  ];
  for (const value of invalid) assert.throws(function () { validateStoredRelative(value); }, /relative_path_invalid/);
  const root = path.resolve(process.cwd());
  assert.equal(resolveStoredRelative(root, "recommendations/x.md"), path.join(root, "recommendations", "x.md"));
  assert.throws(function () { resolveStoredRelative(root, "../outside"); }, /relative_path_invalid/);
  assert.throws(function () { resolveStoredRelative(root, "C:/outside"); }, /relative_path_invalid/);
});

test("owned directory creation rejects a link or junction escape without changing the outside directory", async function (t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-paths-"));
  const owned = path.join(root, "owned");
  const outside = path.join(root, "outside");
  const redirect = path.join(owned, "redirect");
  const sentinel = path.join(outside, "sentinel.txt");
  try {
    await fsp.mkdir(owned);
    await fsp.mkdir(outside);
    await fsp.writeFile(sentinel, "must-not-change\n", "utf8");
    const beforeNames = await fsp.readdir(outside);
    const beforeBytes = await fsp.readFile(sentinel, "utf8");
    try {
      await fsp.symlink(outside, redirect, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && ["EPERM", "EACCES"].includes(error.code)) return t.skip("link creation unavailable");
      throw error;
    }
    await assert.rejects(
      ensureOwnedDirectory(owned, path.join(redirect, "nested")),
      /owned_path_unsafe/
    );
    assert.deepEqual(await fsp.readdir(outside), beforeNames);
    assert.equal(await fsp.readFile(sentinel, "utf8"), beforeBytes);
    await assert.rejects(fsp.lstat(path.join(outside, "nested")), { code: "ENOENT" });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Codex root resolution rejects a link or junction", async function (t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-root-link-"));
  const actual = path.join(root, "actual");
  const linked = path.join(root, "linked");
  try {
    await fsp.mkdir(actual);
    try {
      await fsp.symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error && ["EPERM", "EACCES"].includes(error.code)) return t.skip("link creation unavailable");
      throw error;
    }
    assert.throws(function () { resolveCodexRoot({ explicitRoot: linked }); }, /codex_root_invalid/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
