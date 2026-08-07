// Skill-side wiring for the sasu judge gates (PRD mini-cli-llm-boundary
// R9/AC): the four revised skills must call the CLI at their gate points and
// must forbid agent-run overrides. This pins the prompt contract so a later
// skill edit cannot silently drop a gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function readSkill(name) {
  return fs.readFileSync(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");
}

test("interview-me routes closure through the gap-audit gate", () => {
  const skill = readSkill("interview-me");
  assert.match(skill, /sasu gate gap-audit --slug <topic-slug> --qa-log/);
  assert.match(skill, /hard block/i);
  assert.match(skill, /Never run `sasu gate override` yourself/);
  assert.match(skill, /never a numeric score/i, "the numeric-gate ban must survive the gate integration");
  assert.match(skill, /A gap finding is not an answer/);
  assert.match(skill, /`requiresHuman: false` does not authorize resolution/);
});

test("gen-prd routes readiness through the spec gate", () => {
  const skill = readSkill("gen-prd");
  assert.match(skill, /sasu gate spec --slug <topic-slug> --prd/);
  assert.match(skill, /fidelity/i);
  assert.match(skill, /Never run `sasu gate override` yourself/);
});

test("implement routes changed-code tasks through the verify gate", () => {
  const skill = readSkill("implement");
  assert.match(skill, /sasu verify --slug <topic-slug> --prd/);
  assert.match(skill, /mechanical/i);
  assert.match(skill, /Never run `sasu gate override` yourself/);
});

test("please treats gate BLOCKs as fix-and-regate loops, stopping only for humans or budget", () => {
  const skill = readSkill("please");
  assert.match(skill, /BLOCK is not a stop/);
  assert.match(skill, /needs human decision/);
  assert.match(skill, /retry budget/i);
  assert.match(skill, /Never run `sasu gate override` yourself/);
});

test("every gate-calling skill keeps the override user-only in the same breath", () => {
  for (const name of ["interview-me", "gen-prd", "implement", "please"]) {
    const skill = readSkill(name);
    const gateMentions = skill.match(/sasu (gate|verify)/g) ?? [];
    assert.ok(gateMentions.length > 0, `${name} must call a sasu gate`);
    assert.match(skill, /override[^\n]*user/i, `${name} must state overrides are user-only`);
  }
});
