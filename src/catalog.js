import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./ids.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

export function parseSkillFrontmatter(text) {
  if (typeof text !== "string" || !text.startsWith("---\n")) throw new Error("skill_frontmatter_invalid");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("skill_frontmatter_invalid");
  const values = Object.create(null);
  for (const line of text.slice(4, end).split("\n")) {
    const match = line.match(/^([a-z][a-z0-9_-]*):[ \t]*(.*)$/u);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("skill_frontmatter_invalid");
    values[match[1]] = unquote(match[2]);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(values.name || "") || values.name.length > 64) throw new Error("skill_frontmatter_invalid");
  if (typeof values.description !== "string" || values.description.length === 0 || Array.from(values.description).length > 1024) throw new Error("skill_frontmatter_invalid");
  return { name: values.name, description: values.description };
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function walkSkillFiles(root, current, depth, output) {
  if (depth > MAX_DEPTH) throw new Error("catalog_traversal_limit");
  const entries = await fsp.readdir(current, { withFileTypes: true });
  entries.sort(function (a, b) { return compareText(a.name, b.name); });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const info = await fsp.lstat(absolute);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await walkSkillFiles(root, absolute, depth + 1, output);
    else if (info.isFile() && entry.name === "SKILL.md") output.push(absolute);
  }
}

function resolveCatalogRoot(spec, anchors) {
  const base = spec.anchor === "codex-root" ? anchors.codexRoot : anchors.pluginRoot;
  if (!base || !path.isAbsolute(base)) throw new Error("catalog_anchor_invalid");
  const absolute = path.resolve(base, ...spec.relativePath.split("/"));
  const relative = path.relative(path.resolve(base), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("catalog_root_outside_anchor");
  return absolute;
}

export async function buildCatalogSnapshot(rootSpecs, anchors, now = Date.now()) {
  const roots = [];
  const skills = [];
  const rootErrors = [];
  for (const spec of [...rootSpecs].sort(function (a, b) { return a.precedence - b.precedence || compareText(a.anchor + ":" + a.relativePath, b.anchor + ":" + b.relativePath); })) {
    const rootId = spec.anchor + ":" + spec.relativePath;
    const rootRecord = { rootId, origin: spec.origin, precedence: spec.precedence, required: true };
    roots.push(rootRecord);
    let root;
    try {
      root = resolveCatalogRoot(spec, anchors);
      const info = await fsp.lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("catalog_root_invalid");
      const files = [];
      const rootSkills = [];
      await walkSkillFiles(root, root, 0, files);
      for (const absolute of files) {
        const relativeSkillPath = path.relative(root, absolute).split(path.sep).join("/");
        const bytes = await fsp.readFile(absolute);
        let parsed = null;
        let errorCodes = [];
        if (bytes.length > MAX_MANIFEST_BYTES) errorCodes = ["manifest_too_large"];
        else {
          try { parsed = parseSkillFrontmatter(bytes.toString("utf8").replace(/\r\n?/gu, "\n")); }
          catch { errorCodes = ["frontmatter_invalid"]; }
        }
        rootSkills.push({
          skillRef: rootId + "/" + relativeSkillPath,
          name: parsed ? parsed.name : path.basename(path.dirname(relativeSkillPath)),
          description: parsed ? parsed.description : "",
          rootId,
          relativeSkillPath,
          skillManifestSha256: sha256(bytes),
          valid: Boolean(parsed),
          errorCodes,
          duplicate: false,
          inventoryPreferred: false,
          precedence: spec.precedence
        });
      }
      skills.push(...rootSkills);
    } catch (error) {
      const code = error && error.message === "catalog_root_invalid"
        ? "root_invalid"
        : error && error.message === "catalog_traversal_limit"
          ? "traversal_limit"
          : "root_unavailable";
      rootErrors.push({ rootId, code });
    }
  }
  skills.sort(function (a, b) {
    return a.precedence - b.precedence || compareText(a.rootId, b.rootId) || compareText(a.relativeSkillPath, b.relativeSkillPath);
  });
  const preferredNames = new Set();
  for (const skill of skills) {
    if (!skill.valid) continue;
    if (preferredNames.has(skill.name)) skill.duplicate = true;
    else {
      preferredNames.add(skill.name);
      skill.inventoryPreferred = true;
    }
  }
  const storedSkills = skills.map(function ({ precedence, ...item }) { return item; });
  const snapshot = { schemaVersion: 1, roots, skills: storedSkills, rootErrors };
  const canonicalJson = JSON.stringify(snapshot) + "\n";
  if (Buffer.byteLength(canonicalJson, "utf8") > 2_000_000) throw new Error("catalog_too_large");
  return Object.freeze({ snapshot, canonicalJson, revision: sha256(Buffer.from(canonicalJson, "utf8")) });
}
