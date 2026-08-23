import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("canonical workflow uses qa-log as the only intake artifact", () => {
  const files = [
    path.join(repoRoot, "skills", "interview-me", "SKILL.md"),
    path.join(repoRoot, "skills", "gen-prd", "SKILL.md"),
    path.join(repoRoot, "skills", "please", "SKILL.md"),
  ];
  const combined = files.map(file => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(combined, /prd-handoff\.md/);
  assert.match(combined, /one canonical artifact only: qa-log\.md/);
  // The former standalone "semantic losslessness sweep" now lives inside the
  // gen-prd Inline Self-Check; the guarantee itself must survive.
  assert.match(combined, /Losslessness: every material answer/);
  assert.match(combined, /without treating silence as consent/);
  assert.match(combined, /do not treat silence or a topic change as approval/);
});

test("interview capture stays off the ordinary answer-to-question path", () => {
  const skill = fs.readFileSync(path.join(repoRoot, "skills", "interview-me", "SKILL.md"), "utf8");
  const please = fs.readFileSync(path.join(repoRoot, "skills", "please", "SKILL.md"), "utf8");
  assert.match(skill, /Ordinary answered questions require no tool call and no qa-log write/);
  assert.match(skill, /sasu interview sync --slug <slug>/);
  assert.match(skill, /--normalized pending/);
  assert.match(skill, /Never edit `needs_normalization` or `outstanding_raw_entries` yourself/);
  assert.match(skill, /explicit question-count limit or interview timebox as a hard interaction budget/);
  assert.match(skill, /interview init --question-limit <n>/);
  assert.match(skill, /questionBudgetReached/);
  assert.match(skill, /mark the qa-log `paused` rather than asking another question/);
  assert.match(skill, /source_ref: <runtime>:<session-id>:<human-message-ref>/);
  assert.doesNotMatch(skill, /sasu interview log/);
  assert.match(please, /Run `interview sync` once more immediately before the final normalization and gap-audit/);
});
