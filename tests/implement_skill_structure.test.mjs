import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skillDir = path.join(repoRoot, "skills", "implement");
const skillPath = path.join(skillDir, "SKILL.md");
const referencesDir = path.join(skillDir, "references");

const expectedReferences = [
  "execution-planning.md",
  "observer-and-herdr.md",
  "reviews-and-finalization.md",
  "verification-and-evidence.md",
  "verification-environments.md",
  "worktrees-and-delivery.md",
];

function physicalLineCount(text) {
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

test("implement keeps a compact entrypoint with explicit conditional reference routing", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  assert.ok(physicalLineCount(skill) < 500, "SKILL.md must stay below the progressive-disclosure line budget");
  assert.match(skill, /^## Reference Routing$/m);
  assert.match(skill, /Read each directly linked reference completely when its condition applies\./);

  const linkedReferences = [...skill.matchAll(/\]\(references\/([^)]+\.md)\)/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(linkedReferences, expectedReferences);

  for (const reference of expectedReferences) {
    const row = new RegExp(`references/${reference.replaceAll(".", "\\.")}.*\\|\\s+(Before|When)`, "i");
    assert.match(skill, row, `${reference} must have an explicit read condition`);
  }
});

test("implement references stay direct, bounded, and navigable", () => {
  const sourceReferences = fs.readdirSync(referencesDir)
    .filter(name => name.endsWith(".md"))
    .sort();
  assert.deepEqual(sourceReferences, expectedReferences);

  for (const reference of sourceReferences) {
    const referencePath = path.join(referencesDir, reference);
    const markdown = fs.readFileSync(referencePath, "utf8");
    const lineCount = physicalLineCount(markdown);
    assert.ok(markdown.startsWith("# "), `${reference} must have a document title`);
    if (lineCount > 100) {
      assert.match(markdown.split("\n").slice(0, 25).join("\n"), /^## Contents$/m, `${reference} needs a near-top table of contents`);
    }

    const nestedMarkdownReferences = [...markdown.matchAll(/\]\((?!#)([^)]+\.md)\)/g)];
    assert.equal(nestedMarkdownReferences.length, 0, `${reference} must not require nested Markdown references`);
  }
});

test("implement entrypoint retains lifecycle, safety, and completion authority", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  const requiredContracts = [
    /Never implement a pending PRD without explicit human approval or the user's verbatim conversational approval/,
    /`state\.json` is the only machine record/,
    /Acceptance and fidelity are separate LLM calls/,
    /`sasu implement finalize` never runs tests, judges, capture tools, or external commands/,
    /`state\.json` is the completion authority/,
    /Commit, push, PR creation, CI, and merge are post-receipt delivery outcomes/,
    /^## Hard Stops$/m,
    /^## Final Report$/m,
  ];

  for (const contract of requiredContracts) {
    assert.match(skill, contract);
  }
});

test("removed dispatcher rejects direct legacy invocations with new-command guidance", () => {
  const script = path.join(skillDir, "scripts", "prd_state_harness.js");
  for (const args of [[], ["hook", "stop"], ["verify-run", "--id", "V1"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /prd_state_harness\.js was removed/);
    assert.match(result.stderr, /sasu implement start\|task\|artifact\|status\|verify\|finalize/);
  }
});
