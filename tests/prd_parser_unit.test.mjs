// Direct unit tests for the shared PRD parser module's section helpers.
// The six-section Behaviors/Decisions parsing is covered in
// cli/test/unit/prd-parser.test.mjs against the same module.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const require = createRequire(import.meta.url);
const parserPath = [
  path.join(repoRoot, "cli", "lib", "prd_parser.js"),
  path.join(repoRoot, "skills", "implement", "scripts", "lib", "prd_parser.js"),
].find(candidate => fs.existsSync(candidate));
const parser = require(parserPath);

test("stripFrontmatter splits yaml-ish frontmatter from body", () => {
  const { frontmatter, body } = parser.stripFrontmatter('---\ntopic: "demo"\nstatus: ready\n---\n\n# Title\n');
  assert.equal(frontmatter.topic, "demo");
  assert.equal(frontmatter.status, "ready");
  assert.match(body, /^# Title/m);
});

test("extractSection matches numbered h2 headings case-insensitively and stops at the next h2", () => {
  const markdown = "## 6. Requirements\n\n- R1. First.\n\n### 6.1 Sub\n\n- nested\n\n## 7. Acceptance Criteria\n\n- AC1. Done.\n";
  const section = parser.extractSection(markdown, "6. Requirements");
  assert.match(section, /R1\. First/);
  assert.match(section, /nested/);
  assert.doesNotMatch(section, /AC1/);
  assert.equal(parser.extractSection(markdown, "Missing Heading"), "");
});

test("extractNestedSection scopes an h3 to the next heading of same or higher level", () => {
  const markdown = "## 9. Verification Contract\n\n### 9.1 Test Mode Contract\n\ntable here\n\n### 9.2 Required Agent Verification\n\nmatrix here\n";
  const section = parser.extractNestedSection(markdown, "9.1 Test Mode Contract");
  assert.match(section, /table here/);
  assert.doesNotMatch(section, /matrix here/);
});
