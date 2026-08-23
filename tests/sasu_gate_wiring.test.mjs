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
  assert.match(skill, /closure BLOCK is terminal/i);
  assert.match(skill, /sasu gate reopen --slug <topic-slug> --gate gap-audit/);
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

test("please bounds each PRD gate to a full review and one closure review", () => {
  const skill = readSkill("please");
  assert.match(skill, /Run the full review once/);
  assert.match(skill, /one allowed closure review/);
  assert.match(skill, /A third autonomous judgment is forbidden/);
  assert.match(skill, /sasu gate reopen --slug <topic-slug> --gate <gap-audit\|spec>/);
  assert.match(skill, /sasu prd readiness --prd/);
  assert.doesNotMatch(skill, /plan-verification/);
  // Delegated-run contract: human-consent findings become a recorded,
  // veto-able ledger instead of a mid-run question; only P0 still stops.
  // The delegation is recorded ONCE as run state (sasu gate delegate), not
  // re-passed per call - 2026-08-20: two of three real runs omitted the
  // per-call flag and burned blocked rounds the delegation had answered.
  assert.match(skill, /sasu gate delegate --slug <topic-slug>/);
  assert.match(skill, /--evidence "<verbatim \$please invocation message>"/);
  assert.ok(
    skill.indexOf("sasu gate delegate --slug <topic-slug>") < skill.indexOf("sasu gate gap-audit --slug <topic-slug>"),
    "delegation must be bound before the first gap-audit command",
  );
  assert.match(skill, /Do not run gap-audit or spec until this command succeeds/);
  assert.match(skill, /Do not draft the PRD until gap-audit is PASS/);
  assert.match(skill, /Never overwrite it, clear it, pass `--assume-human-findings` again/);
  assert.match(skill, /P0 findings still block under this flag/);
  assert.match(skill, /listed at the TOP of the final report/);
  assert.match(skill, /only the user's own delegating message is valid evidence/);
  assert.match(skill, /P0 finding blocks under the delegated disposition/);
  assert.match(skill, /`--grant-budget` only with the user's verbatim approval to retry that broken backend/);
  assert.match(skill, /when closure is exhausted/);
  assert.match(skill, /Never run `sasu gate override` yourself/);
  assert.match(skill, /authorizes making reversible choices; it does not turn those choices into user-approved scope/);
  assert.doesNotMatch(skill, /already carries the user's approval of scope, structure, verification modes/);
});

test("please seals specification in the main session before implementation dispatch", () => {
  const skill = readSkill("please");
  const observer = fs.readFileSync(
    path.join(repoRoot, "skills", "implement", "references", "observer-and-herdr.md"),
    "utf8",
  );
  const prdStage = skill.indexOf("## Stage 1: PRD");
  const dispatchStage = skill.indexOf("## Implementation Dispatch");
  const implementStage = skill.indexOf("## Stage 2: Implement");

  assert.ok(prdStage >= 0 && prdStage < dispatchStage && dispatchStage < implementStage);
  assert.match(skill, /main session is the sole qa-log writer/);
  assert.match(skill, /main session writes and seals the PRD/);
  assert.match(skill, /must not open an Implementor.*before the PRD reaches `status: ready`/s);
  assert.match(skill, /--prd agents\/prd\/<topic-slug>\/prd\.md/);
  assert.match(skill, /PIPELINE: implement via/);
  assert.match(skill, /Do not send `PIPELINE: please`/);
  assert.match(skill, /Treat the qa-log and PRD body as sealed, read-only inputs/);
  assert.match(observer, /main session is the Spec Owner through qa-log closure and PRD readiness/);
  assert.match(observer, /It never authors or repairs the qa-log or PRD/);
  assert.doesNotMatch(observer, /Implementor owns PRD authoring/);
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
