#!/usr/bin/env node
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const legacyPatterns = ["Harvester V2", "harvester-v2", "HARVESTER_V2", "HarvesterV2", "harvesterV2", "@gorombo/harvester-v2", "v2_environment", "v2_pairing"];
const allowed = new Map([
  ["migrations/001-initial.sql", new Map([["Harvester V2", 1]])],
  ["src/constants.js", new Map([["harvester-v2", 1]])],
  ["src/config.js", new Map([["HARVESTER_V2", 3]])],
  ["src/pairing.js", new Map([["harvester-v2", 1]])],
  ["README.md", new Map([["HARVESTER_V2", 1]])],
  ["docs/migration.md", new Map([["harvester-v2", 1], ["HARVESTER_V2", 3]])],
  ["test/config.test.js", new Map([["HARVESTER_V2", 4]])]
]);

async function files(directory = root) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name) || entry.name.endsWith(".tgz")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("identity_scan_symlink");
    if (entry.isDirectory()) result.push(...await files(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

for (const absolute of await files()) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative === "scripts/verify-identity.mjs") continue;
  const raw = await fsp.readFile(absolute);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) continue;
  for (const legacy of legacyPatterns) {
    const count = text.split(legacy).length - 1;
    const expected = allowed.get(relative)?.get(legacy) || 0;
    assert.equal(count, expected, "legacy_identity_residue:" + relative + ":" + legacy);
  }
}

const packageMetadata = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
const plugin = JSON.parse(await fsp.readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
const agent = await fsp.readFile(path.join(root, "skills", "gorombo-skill-harvester", "agents", "openai.yaml"), "utf8");
assert.equal(packageMetadata.name, "@gorombo/gorombo-skill-harvester");
assert.equal(packageMetadata.bin["gorombo-skill-harvester"], "./src/cli.js");
assert.equal(plugin.name, "gorombo-skill-harvester");
assert.equal(plugin.interface.displayName, "Gorombo Skill Harvester");
assert.match(agent, /default_prompt:\s*"Use \$gorombo-skill-harvester\b/u);

process.stdout.write(JSON.stringify({ status: "ok", legacyCompatibilityFiles: allowed.size }) + "\n");
