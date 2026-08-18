import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCatalogSnapshot } from "../src/catalog.js";

test("catalog traversal-limit fails the required root closed", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-catalog-"));
  try {
    const skills = path.join(root, "skills");
    await fsp.mkdir(path.join(skills, "shallow"), { recursive: true });
    await fsp.writeFile(path.join(skills, "shallow", "SKILL.md"), "---\nname: shallow\ndescription: A shallow skill.\n---\n");
    let deep = skills;
    for (let index = 0; index < 10; index += 1) deep = path.join(deep, "level-" + index);
    await fsp.mkdir(deep, { recursive: true });
    await fsp.writeFile(path.join(deep, "SKILL.md"), "---\nname: deep\ndescription: A deep skill.\n---\n");
    const catalog = await buildCatalogSnapshot([{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 1 }], { codexRoot: root, pluginRoot: root }, 1);
    assert.deepEqual(catalog.snapshot.rootErrors, [{ rootId: "codex-root:skills", code: "traversal_limit" }]);
    assert.equal(catalog.snapshot.skills.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("catalog ordering and revision are byte-deterministic", async function () {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gorombo-skill-harvester-catalog-"));
  try {
    for (const name of ["zeta", "alpha", "omega"]) {
      const directory = path.join(root, "skills", name);
      await fsp.mkdir(directory, { recursive: true });
      await fsp.writeFile(path.join(directory, "SKILL.md"), "---\nname: " + name + "\ndescription: Deterministic " + name + ".\n---\n");
    }
    const specs = [{ anchor: "codex-root", relativePath: "skills", origin: "codex", precedence: 1 }];
    const first = await buildCatalogSnapshot(specs, { codexRoot: root, pluginRoot: root }, 1);
    const second = await buildCatalogSnapshot(specs, { codexRoot: root, pluginRoot: root }, 2);
    assert.deepEqual(first.snapshot.skills.map(function (item) { return item.name; }), ["alpha", "omega", "zeta"]);
    assert.equal(first.canonicalJson, second.canonicalJson);
    assert.equal(first.revision, second.revision);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
