import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const skillDir = path.join(repoRoot, "skills", "implement");
const skillPath = path.join(skillDir, "SKILL.md");
const genPrdSkillPath = path.join(repoRoot, "skills", "gen-prd", "SKILL.md");
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
  assert.match(skill, /Read each linked reference completely when its condition applies\./);

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

test("implement entrypoint keeps deterministic verification and visible review boundaries", () => {
  const skill = fs.readFileSync(skillPath, "utf8");
  const reviewReference = fs.readFileSync(path.join(referencesDir, "reviews-and-finalization.md"), "utf8");
  const requiredContracts = [
    /`state\.json` stores run ownership/,
    /writes the current `verification-report\.json` and `verification-report\.md`/,
    /It does not start reviewers/,
    /follow the CLI's `Next action:` response/,
    /native subagent facility directly/,
    /^## Review Disposition$/m,
    /^## Delivery$/m,
    /^## Final Report$/m,
  ];

  for (const contract of requiredContracts) {
    assert.match(skill, contract);
  }
  for (const contract of [
    /Fidelity checks every approved behavior/,
    /Code checks implementation quality, integration, concurrency, data flow, and error paths/,
    /Security checks authentication, authorization, secrets, destructive data, and abuse boundaries/,
    /Sasu sets no reviewer turn limit/,
    /REVIEW_UNAVAILABLE/,
    /^### Fix now$/m,
    /^### Follow-up improvements$/m,
    /^### What was checked$/m,
  ]) {
    assert.match(reviewReference, contract);
  }
});

// The approved workflow plan changes the PRD's three-column contract and
// explicitly removes per-requirement proof/lifecycle prose, including manuals.
test("gen-prd and implement preserve all requirements without per-requirement ceremony", () => {
  const genPrd = fs.readFileSync(genPrdSkillPath, "utf8");
  const implement = fs.readFileSync(skillPath, "utf8");
  for (const section of ["## Goal", "## Non-goals", "## Decisions", "## Behaviors", "## Technical structure", "## Risks"]) {
    assert.match(genPrd, new RegExp(`^${section}$`, "m"));
  }
  assert.match(genPrd, /\| D-n \| 결정 \| 근거 \|/);
  assert.match(genPrd, /\| # \| 사용자가 관찰하는 행동 \| 결정 \|/);
  assert.match(implement, /follow the CLI's `Next action:` response/);
  const activeDocuments = [
    genPrd, implement,
    ...expectedReferences.map((name) => fs.readFileSync(path.join(referencesDir, name), "utf8")),
  ];
  for (const document of activeDocuments) {
    for (const retired of [
      /sasu implement (?:check|park|resume|qa-brief|trail|design)\b/,
      /--row\b/, /\| 검사 방법 \|/, /\bparkedRows\b/,
      /Acceptance and fidelity are separate LLM calls/,
      /one result per row/, /each row's status and attempts/,
      /complete-pending-human/, /receipt\.json/, /sasu implement finalize/,
    ]) assert.doesNotMatch(document, retired);
  }
});

test("removed dispatcher rejects direct legacy invocations with new-command guidance", () => {
  const script = path.join(skillDir, "scripts", "prd_state_harness.js");
  for (const args of [[], ["hook", "stop"], ["verify-run", "--id", "V1"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /prd_state_harness\.js was removed/);
    assert.match(result.stderr, /sasu implement start\|artifact\|status\|verify\|amend\|retire/);
  }
});
