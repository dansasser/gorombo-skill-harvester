#!/usr/bin/env node
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const skillDir = path.join(packageRoot, "skills", "gorombo-skill-harvester");
const skillFile = path.join(skillDir, "SKILL.md");

function contained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readJson(relative) {
  return JSON.parse(await fsp.readFile(path.join(packageRoot, relative), "utf8"));
}

const skillText = (await fsp.readFile(skillFile, "utf8")).replace(/\r\n?/gu, "\n");
const frontmatter = skillText.match(/^---\n([\s\S]*?)\n---\n/u);
assert.ok(frontmatter, "skill_frontmatter_missing");
const fields = frontmatter[1].split("\n").filter(Boolean).map(function (line) {
  const separator = line.indexOf(":");
  assert.ok(separator > 0, "skill_frontmatter_invalid");
  return line.slice(0, separator).trim();
});
assert.deepEqual(fields.sort(), ["description", "name"], "skill_frontmatter_fields_invalid");
assert.match(frontmatter[1], /^name:\s*gorombo-skill-harvester$/mu);
assert.match(frontmatter[1], /^description:\s*\S.+$/mu);
assert.match(skillText, /node \.\.\/\.\.\/src\/cli\.js status --json/u);

const links = [...skillText.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map(function (match) { return match[1]; });
assert.ok(links.length >= 2, "skill_references_missing");
for (const link of links) {
  assert.equal(link.includes("://"), false, "skill_reference_must_be_local");
  const target = path.resolve(skillDir, link);
  assert.ok(contained(skillDir, target), "skill_reference_outside_root");
  const info = await fsp.lstat(target);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "skill_reference_invalid");
}

const relativeCli = path.resolve(skillDir, "..", "..", "src", "cli.js");
assert.ok(contained(packageRoot, relativeCli), "skill_cli_outside_package");
assert.ok((await fsp.lstat(relativeCli)).isFile(), "skill_cli_missing");

const plugin = await readJson(".codex-plugin/plugin.json");
const packageMetadata = await readJson("package.json");
assert.equal(plugin.name, "gorombo-skill-harvester");
assert.equal(plugin.version, packageMetadata.version);
assert.equal(plugin.license, packageMetadata.license);
assert.equal(plugin.skills, "./skills/");
assert.equal(plugin.repository, "https://github.com/dansasser/gorombo-skill-harvester");
assert.equal(packageMetadata.name, "@gorombo/gorombo-skill-harvester");

const hookText = await fsp.readFile(path.join(packageRoot, "hooks", "hooks.json"), "utf8");
const hooks = JSON.parse(hookText);
assert.ok(hooks.hooks && Array.isArray(hooks.hooks.PostToolUse), "hooks_contract_invalid");
const pluginRootToken = "$" + "{PLUGIN_ROOT}";
assert.ok(hookText.includes(pluginRootToken), "hook_plugin_root_missing");
assert.equal(hookText.includes("CLAUDE_PLUGIN_ROOT"), false, "hook_compatibility_root_disallowed");
assert.ok((await fsp.lstat(path.join(packageRoot, "hooks", "completion-hook.mjs"))).isFile(), "completion_hook_missing");
assert.ok((await fsp.lstat(path.join(skillDir, "agents", "openai.yaml"))).isFile(), "skill_agent_metadata_missing");

process.stdout.write(JSON.stringify({ status: "ok", references: links.length }) + "\n");
