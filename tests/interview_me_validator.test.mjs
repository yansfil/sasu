import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const validator = path.join(repoRoot, "skills", "interview-me", "scripts", "validate_intake.mjs");

test("canonical workflow uses qa-log as the only intake artifact", () => {
  const files = [
    path.join(repoRoot, "skills", "interview-me", "SKILL.md"),
    path.join(repoRoot, "skills", "gen-prd", "SKILL.md"),
    path.join(repoRoot, "skills", "please", "SKILL.md"),
  ];
  const combined = files.map(file => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(combined, /prd-handoff\.md/);
  assert.match(combined, /one canonical artifact only: qa-log\.md/);
  assert.match(combined, /semantic losslessness sweep/);
});

function fixtureQaLog({ withUxCard = true, withLinkedDecisions = true } = {}) {
  return [
    "---",
    'selected_packs: "ux, verification"',
    "---",
    "",
    "# Interview Log: Settings retry",
    "",
    "## Decision Register",
    "",
    "| ID | Kind | Area | Decision / fact | Priority | Source / owner | Status | PRD mapping / revisit |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |",
    "",
    "## Raw Q&A",
    "",
    "### Q1: Failed save behavior",
    "- decision_ids: D-01",
    "- needs_normalization: false",
    "",
    "## UX Scenario Cards",
    "",
    ...(withUxCard
      ? [
        "### UX-01: Change a setting",
        "- trigger: User opens the existing settings page.",
        "- happy path: User saves a valid setting and sees the persisted value.",
        "- state / failure: A failed save keeps the entered value and explains the error.",
        "- recovery: User retries without re-entering the value.",
        "- proof: Browser flow confirms error, retry, and persisted result.",
        ...(withLinkedDecisions ? ["- linked decisions: D-01"] : []),
      ]
      : []),
    "",
    "## Evidence From Code, Docs, Or Research",
    "",
    "- src/settings/page.tsx: existing entry route.",
  ].join("\n");
}

function runValidator(qaLog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-me-validator-"));
  const qaPath = path.join(dir, "qa-log.md");
  fs.writeFileSync(qaPath, qaLog);
  const result = spawnSync(process.execPath, [validator, qaPath], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test("intake validator accepts traceable UX coverage", () => {
  const result = runValidator(fixtureQaLog());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Intake validation passed/);
});

test("intake validator rejects selected UX without a scenario card", () => {
  const result = runValidator(fixtureQaLog({ withUxCard: false }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no UX Scenario Card/);
});

test("intake validator requires scenario cards to link decisions", () => {
  const result = runValidator(fixtureQaLog({ withLinkedDecisions: false }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing 'linked decisions'/);
});

test("intake validator rejects a non-empty linked-decisions field without a Decision Register ID", () => {
  const qa = fixtureQaLog().replace("- linked decisions: D-01", "- linked decisions: none");
  const result = runValidator(qa);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must link at least one Decision Register ID/);
});

test("intake validator rejects duplicate Decision Register IDs", () => {
  const duplicateQa = fixtureQaLog().replace(
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |",
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |\n| D-01 | fact | Technical | Existing settings route is present | P1 | repo: src/settings/page.tsx | resolved | informs R1 |",
  );
  const result = runValidator(duplicateQa);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicates Decision Register ID D-01/);
});

test("intake validator accepts a reversible agent-owned assumption", () => {
  const qa = fixtureQaLog().replace(
    "| D-01 | decision | UX/design | Failed save exposes retry and preserves input | P0 | user: confirmed 2026-07-14 | resolved | changes retry behavior -> R1, AC1, V1 |",
    "| D-01 | assumption | UX/design | Retry uses the existing default delay | P1 | agent default from existing repo behavior | resolved | R1, AC1, V1; revisit if retry policy changes |",
  );
  const result = runValidator(qa);
  assert.equal(result.status, 0, result.stderr);
});

test("intake validator blocks closure while raw notes still need normalization", () => {
  const qa = fixtureQaLog().replace("- needs_normalization: false", "- needs_normalization: true");
  const result = runValidator(qa);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs_normalization is true/);
});

test("intake validator rejects an open material decision", () => {
  const qa = fixtureQaLog().replace("| resolved | changes retry behavior", "| open | changes retry behavior");
  const result = runValidator(qa);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /leaves material P0 node D-01 open/);
});
