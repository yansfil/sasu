// Direct unit tests for the extracted PRD parser module.
// These pin the parsing contracts (sections, item lists, verification matrix,
// test mode contract, mode inference) that the CLI-level tests only exercise
// indirectly through one fixture PRD.

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

test("parseMarkdownItems keeps explicit ids and auto-numbers the rest", () => {
  const items = parser.parseMarkdownItems(
    "- R1. Explicit first. Covers AC2.\n- Second without id, needs R1 and AC1.\n- R7. Jumps ahead.\n",
    "R",
    "Requirement",
  );
  assert.deepEqual(items.map(item => item.id), ["R1", "R2", "R7"]);
  assert.deepEqual(items[0].acceptanceCriteria, ["AC2"]);
  assert.deepEqual(items[1].requirements, ["R1"]);
  assert.equal(items[0].status, "pending");
});

test("parseMarkdownItems preserves indented continuation lines", () => {
  const items = parser.parseMarkdownItems(
    "- R1. The product supports the complete primary journey.\n  This includes recovery from a failed save and covers AC1.\n- R2. The second requirement remains separate.\n",
    "R",
    "Requirement",
  );
  assert.equal(items.length, 2);
  assert.match(items[0].text, /recovery from a failed save/);
  assert.deepEqual(items[0].acceptanceCriteria, ["AC1"]);
});

test("parseVerification prefers matrix rows over bullets and normalizes matrix fields", () => {
  const section = [
    "### 9.2 Required Agent Verification",
    "",
    "| ID | Mode | Covers | Method | Artifact | Pass Intent | Required For Done | Can Be Blocked |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    '| V1 | build/static | R1, AC1 | `npm test` | command-log | tests pass | yes | no |',
    "| V2 | browser/runtime | R2 | open page | screenshot | page renders | no | yes |",
    "",
    "- stray bullet that must be ignored when a matrix exists",
  ].join("\n");
  const items = parser.parseVerification(section);
  assert.deepEqual(items.map(item => item.id), ["V1", "V2"]);
  assert.equal(items[0].source, "verification_matrix");
  assert.equal(items[0].matrix.requiredForDone, true);
  assert.equal(items[0].matrix.canBeBlocked, false);
  assert.equal(items[1].matrix.requiredForDone, false);
  assert.equal(items[1].matrix.canBeBlocked, true);
  assert.match(items[0].text, /Check: `npm test`/);
});

test("parseVerification falls back to bullets, then to a whole-section item", () => {
  const bullets = parser.parseVerification("- run the build\n- `node -e \"process.exit(0)\"`\n");
  assert.deepEqual(bullets.map(item => item.id), ["V1", "V2"]);
  assert.equal(bullets[0].source, "verification_bullet");

  const whole = parser.parseVerification("Just prose describing verification.\n\nNo bullets at all.");
  assert.equal(whole.length, 1);
  assert.equal(whole[0].source, "verification_section");
});

test("parseTestModeContract reads mode rows and required-for-done semantics", () => {
  const section = [
    "| Mode | Required For Done | Covers | Human Decision |",
    "| --- | --- | --- | --- |",
    "| build/static | yes | repo health | none |",
    "| browser/runtime | no / blockable | user flows | none |",
  ].join("\n");
  const rows = parser.parseTestModeContract(section);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].normalizedMode, "build-static");
  assert.equal(rows[0].requiredForDone, true);
  assert.equal(rows[1].requiredForDone, false);
  assert.equal(rows[1].canBeBlocked, true);
});

test("inferVerificationMode prefers the explicit matrix mode, else infers from text", () => {
  const testModes = parser.parseTestModeContract([
    "| Mode | Required For Done |",
    "| --- | --- |",
    "| build/static | yes |",
    "| browser/runtime | no |",
  ].join("\n"));

  const explicit = parser.inferVerificationMode(
    { matrix: { mode: "Build/Static" }, text: "" },
    testModes,
  );
  assert.equal(explicit.normalizedMode, "build-static");
  assert.equal(explicit.requiredForDone, true);

  const inferred = parser.inferVerificationMode(
    { matrix: null, level: "General", text: "open the page in a browser and take a screenshot" },
    testModes,
  );
  assert.equal(inferred.normalizedMode, "browser-runtime");
});

test("applyTestModeDefaults backfills required/blockable from the mode contract", () => {
  const testModes = parser.parseTestModeContract([
    "| Mode | Required For Done |",
    "| --- | --- |",
    "| build/static | no / blockable |",
  ].join("\n"));
  const items = [{
    id: "V1",
    level: "General",
    text: "Mode: build/static. Check: npm test.",
    matrix: { mode: "build/static", requiredForDoneRaw: "", canBeBlockedRaw: "" },
  }];
  parser.applyTestModeDefaults(items, testModes);
  assert.equal(items[0].matrix.requiredForDone, false);
  assert.equal(items[0].matrix.canBeBlocked, true);
  assert.equal(items[0].testMode, "build/static");
});

test("parseDecisionTraceItems accepts bullets and tables, skips none rows, infers stance", () => {
  const bullets = parser.parseDecisionTraceItems(
    "- User rejected the CSV export option.\n- none\n- User approved the JSON API.\n",
    "prd",
  );
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0].stance, "rejected");
  assert.equal(bullets[1].stance, "accepted");

  const table = parser.parseDecisionTraceItems([
    "| Decision / Proposal | Stance | Represented By |",
    "| --- | --- | --- |",
    "| Use SQLite | accepted | R1 |",
  ].join("\n"), "prd");
  assert.equal(table.length, 1);
  assert.equal(table[0].stance, "accepted");
  assert.equal(table[0].target, "R1");
});

test("buildIntentTrace parses the nested 4.3 decision-traceability subsection", () => {
  const parsed = parser.stripFrontmatter([
    "---",
    'topic: "t"',
    "---",
    "",
    "## 4. Pre-Work And Required Decisions",
    "",
    "### 4.3 Decision Traceability For Fidelity Review",
    "",
    "- User chose CSV export: represented by R1, AC1.",
    "- User rejected XML: non-goal.",
    "",
    "## 5. Major Technical Structure Changes",
    "",
    "None.",
  ].join("\n"));
  const trace = parser.buildIntentTrace(parsed, process.cwd());
  assert.equal(trace.prdDecisionCount, 2);
});
