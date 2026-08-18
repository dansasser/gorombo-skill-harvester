import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const documents = [
  "README.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "docs/README.md",
  "docs/configuration.md",
  "docs/development.md",
  "docs/getting-started.md",
  "docs/migration.md",
  "docs/operations.md"
];

test("public Markdown links resolve inside the repository", async function () {
  for (const relativeDocument of documents) {
    const absoluteDocument = path.join(packageRoot, relativeDocument);
    const markdown = await fsp.readFile(absoluteDocument, "utf8");
    const links = markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu);
    for (const match of links) {
      const target = match[1].replace(/^<|>$/gu, "");
      if (target.startsWith("#") || /^(?:https?:|mailto:)/u.test(target)) continue;
      const filePart = decodeURIComponent(target.split("#", 1)[0]);
      const resolved = path.resolve(path.dirname(absoluteDocument), filePart);
      const containment = path.relative(packageRoot, resolved);
      assert.ok(containment === "" || !containment.startsWith("..") && !path.isAbsolute(containment), "documentation_link_outside_repository:" + relativeDocument + ":" + target);
      const info = await fsp.lstat(resolved);
      assert.ok(info.isFile() || info.isDirectory(), "documentation_link_missing:" + relativeDocument + ":" + target);
    }
  }
});
