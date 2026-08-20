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
  assert.match(skill, /sasu prd readiness --prd/);
  assert.doesNotMatch(skill, /plan-verification/);
  assert.match(skill, /sasu gate spec --slug <topic-slug> --prd/);
  assert.match(skill, /fidelity/i);
  assert.match(skill, /Never run `sasu gate override` yourself/);
});

test("implement routes changed-code tasks through unified implement verify", () => {
  const skill = readSkill("implement");
  assert.match(skill, /sasu implement verify/);
  assert.match(skill, /mechanical/i);
  assert.match(skill, /Do not use overrides on the user's behalf/);
});

test("please treats gate BLOCKs as fix-and-regate loops, stopping only for humans or budget", () => {
  const skill = readSkill("please");
  assert.match(skill, /BLOCK is not a stop/);
  assert.match(skill, /sasu prd readiness --prd/);
  assert.doesNotMatch(skill, /plan-verification/);
  // Delegated-run contract: human-consent findings become a recorded,
  // veto-able ledger instead of a mid-run question; only P0 still stops.
  // The delegation is recorded ONCE as run state (sasu gate delegate), not
  // re-passed per call - 2026-08-20: two of three real runs omitted the
  // per-call flag and burned blocked rounds the delegation had answered.
  assert.match(skill, /sasu gate delegate --slug <topic-slug>/);
  assert.match(skill, /--evidence "<verbatim \$please invocation message>"/);
  assert.match(skill, /P0 findings still block under this flag/);
  assert.match(skill, /listed at the TOP of the final report/);
  assert.match(skill, /only the user's own delegating message is valid evidence/);
  assert.match(skill, /a P0 finding blocks under the delegated flag/);
  assert.match(skill, /budgetExhausted/);
  assert.match(skill, /judgeErrorLoop/);
  assert.match(skill, /Never run `sasu gate override` yourself/);
});

test("quick documents its fast single-lane path and bounded large-input fallback", () => {
  const skill = readSkill("quick");
  assert.match(skill, /Up to eight machine-judged criteria stay in one routine judge call/);
  assert.match(skill, /balanced criterion lanes that run concurrently/);
  assert.match(skill, /command trace is audited and recorded/);
  assert.doesNotMatch(skill, /single tool-less call/);
});

test("every gate-calling skill keeps the override user-only in the same breath", () => {
  for (const name of ["interview-me", "gen-prd", "please"]) {
    const skill = readSkill(name);
    const gateMentions = skill.match(/sasu (gate|verify)/g) ?? [];
    assert.ok(gateMentions.length > 0, `${name} must call a sasu gate`);
    assert.match(skill, /override[^\n]*user/i, `${name} must state overrides are user-only`);
  }
});
