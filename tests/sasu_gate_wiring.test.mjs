import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const readSkill = (name) => fs.readFileSync(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");

test("interview and PRD skills keep their existing specification gates", () => {
  const interview = readSkill("interview-me");
  const prd = readSkill("gen-prd");
  assert.match(interview, /sasu gate gap-audit --slug <topic-slug> --qa-log/);
  assert.match(interview, /Never run `sasu gate override` yourself/);
  assert.match(prd, /sasu prd readiness --prd/);
  assert.match(prd, /sasu gate spec --slug <topic-slug> --prd/);
  assert.match(prd, /Never run `sasu gate override` yourself/);
});

test("implement separates deterministic CLI verification from native review", () => {
  const skill = readSkill("implement");
  assert.match(skill, /sasu implement verify/);
  assert.match(skill, /runs every sealed required suite/);
  assert.match(skill, /does not start reviewers/);
  assert.match(skill, /native subagent facility directly/);
  assert.match(skill, /Fidelity and Code in parallel/);
  assert.match(skill, /Sasu imposes no reviewer turn limit/);
  assert.match(skill, /REVIEW_UNAVAILABLE/);
  assert.match(skill, /GitHub Actions/);
});

test("please composes the established gates, implementation, review, and delivery", () => {
  const skill = readSkill("please");
  assert.match(skill, /interview-me\/SKILL\.md/);
  assert.match(skill, /gen-prd\/SKILL\.md/);
  assert.match(skill, /implement\/SKILL\.md/);
  assert.match(skill, /ship\/SKILL\.md/);
  assert.match(skill, /sasu implement verify/);
  assert.match(skill, /native subagent facility/);
  assert.match(skill, /Fix now/);
  assert.match(skill, /Follow-up improvements/);
  assert.match(skill, /Never run `sasu gate override` yourself/);
});

test("quick uses native review without restoring receipt or model-gate machinery", () => {
  const skill = readSkill("quick");
  assert.match(skill, /native subagent facility/);
  assert.match(skill, /Fix now/);
  assert.match(skill, /Follow-up improvements/);
  assert.match(skill, /Reviewer unavailability stays visible/);
  assert.doesNotMatch(skill, /receipt|finalize|sasu gate verify/i);
});
